import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { col, fn, Op } from 'sequelize';
import { Plan } from '../plan.model';
import { CompanyMonthlyUsage } from '../models/company-monthly-usage.model';
import { Company } from '../../companies/company.model';
import { Users, UserStatus } from '../../users/users.model';
import { Document } from '../../documents/document.model';
import { FtpDevice, FtpDeviceStatus } from '../../ftp-devices/ftp-device.model';
import { CompanyEmailChannel } from '../../channels/models/company-email-channel.model';
import {
  CompanyWhatsappChannel,
  WhatsappConnectionStatus,
} from '../../channels/models/company-whatsapp-channel.model';
import { CompanyTelegramChannel } from '../../channels/models/company-telegram-channel.model';
import {
  buildQuotaMetric,
  bytesToMegabytes,
  calcStorageMbFromDocuments,
  CompanyQuotaSummary,
  getCurrentBillingPeriod,
  resolveCompanyEffectiveLimits,
} from '../helpers/quota-calculator.helper';
import { ExchangeRateService } from './exchange-rate.service';

/**
 * Servicio especializado en el cálculo agregado y sin N+1 del resumen de cuotas
 * y consumo actual (usuarios, PDFs, MB en disco, procesamiento y canales activos) por compañía.
 */
@Injectable()
export class CompanyQuotaSummaryService {
  constructor(
    @InjectModel(Company) private readonly companyModel: typeof Company,
    @InjectModel(Users) private readonly userModel: typeof Users,
    @InjectModel(Document) private readonly documentModel: typeof Document,
    @InjectModel(FtpDevice) private readonly ftpDeviceModel: typeof FtpDevice,
    @InjectModel(CompanyMonthlyUsage)
    private readonly monthlyUsageModel: typeof CompanyMonthlyUsage,
    @Optional()
    @InjectModel(CompanyEmailChannel)
    private readonly emailChannelModel?: typeof CompanyEmailChannel,
    @Optional()
    @InjectModel(CompanyWhatsappChannel)
    private readonly whatsappChannelModel?: typeof CompanyWhatsappChannel,
    @Optional()
    @InjectModel(CompanyTelegramChannel)
    private readonly telegramChannelModel?: typeof CompanyTelegramChannel,
    @Optional()
    private readonly exchangeRateService?: ExchangeRateService,
  ) {}

  /**
   * Obtiene el resumen completo de plan, límites vigentes y consumo actual de una compañía.
   */
  async getCompanyQuotaSummary(companyId: number): Promise<CompanyQuotaSummary> {
    const company = await this.companyModel.findByPk(companyId, {
      include: [{ model: Plan, as: 'plan' }],
    });

    if (!company) {
      throw new NotFoundException(`La compañía con ID ${companyId} no existe`);
    }

    const map = await this.getBatchQuotaSummaries([company]);
    return map.get(company.id)!;
  }

  /**
   * Calcula en lote (sin problema N+1) el resumen de cuotas para múltiples compañías.
   */
  async getBatchQuotaSummaries(
    companies: Company[],
  ): Promise<Map<number, CompanyQuotaSummary>> {
    const result = new Map<number, CompanyQuotaSummary>();
    if (companies.length === 0) return result;

    const companyIds = companies.map((c) => c.id);
    const period = getCurrentBillingPeriod();
    const exchangeConfig = this.exchangeRateService
      ? await this.exchangeRateService.getConfig().catch(() => null)
      : null;
    const usdRate = Number(exchangeConfig?.usdRate || process.env.USD_EXCHANGE_RATE || 1250);
    const roundPrices =
      exchangeConfig?.roundPrices !== undefined ? Boolean(exchangeConfig.roundPrices) : true;

    const [
      userCountsRaw,
      docAggregatesRaw,
      aiUsagesRaw,
      ftpDeviceCountsRaw,
      emailChannelsRaw,
      whatsappChannelsRaw,
      telegramChannelsRaw,
    ] = await Promise.all([
      this.userModel.findAll({
        attributes: ['companyId', [fn('COUNT', col('id')), 'activeCount']],
        where: {
          companyId: { [Op.in]: companyIds },
          status: { [Op.ne]: UserStatus.INACTIVE },
        },
        group: ['companyId'],
        raw: true,
      }) as unknown as Promise<Array<{ companyId: number; activeCount: string | number }>>,
      this.documentModel.findAll({
        attributes: [
          'companyId',
          [fn('COUNT', col('id')), 'docsCount'],
          [fn('COALESCE', fn('SUM', col('file_size')), 0), 'totalBytes'],
        ],
        where: { companyId: { [Op.in]: companyIds } },
        group: ['companyId'],
        raw: true,
      }) as unknown as Promise<
        Array<{ companyId: number; docsCount: string | number; totalBytes: string | number }>
      >,
      this.monthlyUsageModel.findAll({
        where: { companyId: { [Op.in]: companyIds }, period },
        raw: true,
      }),
      this.ftpDeviceModel.findAll({
        attributes: ['companyId', [fn('COUNT', col('id')), 'activeCount']],
        where: {
          companyId: { [Op.in]: companyIds },
          status: FtpDeviceStatus.ACTIVE,
        },
        group: ['companyId'],
        raw: true,
      }) as unknown as Promise<Array<{ companyId: number; activeCount: string | number }>>,
      this.emailChannelModel
        ? this.emailChannelModel.findAll({
            attributes: ['companyId', 'isActive'],
            where: { companyId: { [Op.in]: companyIds } },
            raw: true,
          })
        : Promise.resolve([]),
      this.whatsappChannelModel
        ? this.whatsappChannelModel.findAll({
            attributes: ['companyId', 'isActive', 'connectionStatus'],
            where: { companyId: { [Op.in]: companyIds } },
            raw: true,
          })
        : Promise.resolve([]),
      this.telegramChannelModel
        ? this.telegramChannelModel.findAll({
            attributes: ['companyId', 'isActive'],
            where: { companyId: { [Op.in]: companyIds } },
            raw: true,
          })
        : Promise.resolve([]),
    ]);

    const emailChannelMap = new Map<number, { isActive: boolean }>(
      (emailChannelsRaw as any[]).map((c) => [
        Number(c.companyId),
        { isActive: Boolean(c.isActive) },
      ]),
    );
    const whatsappChannelMap = new Map<
      number,
      { isActive: boolean; connectionStatus: string }
    >(
      (whatsappChannelsRaw as any[]).map((c) => [
        Number(c.companyId),
        {
          isActive: Boolean(c.isActive),
          connectionStatus: String(c.connectionStatus || ''),
        },
      ]),
    );
    const telegramChannelMap = new Map<number, { isActive: boolean }>(
      (telegramChannelsRaw as any[]).map((c) => [
        Number(c.companyId),
        { isActive: Boolean(c.isActive) },
      ]),
    );

    const userCountMap = new Map<number, number>(
      userCountsRaw.map((r) => [Number(r.companyId), Number(r.activeCount || 0)]),
    );
    const ftpDeviceCountMap = new Map<number, number>(
      ftpDeviceCountsRaw.map((r) => [Number(r.companyId), Number(r.activeCount || 0)]),
    );
    const docStatsMap = new Map<number, { count: number; bytes: number }>(
      docAggregatesRaw.map((r) => [
        Number(r.companyId),
        { count: Number(r.docsCount || 0), bytes: Number(r.totalBytes || 0) },
      ]),
    );
    const aiUsageMap = new Map<number, { queries: number; tokens: number; docsProcessed: number; pagesCount: number }>(
      aiUsagesRaw.map((r: any) => [
        Number(r.companyId),
        {
          queries: Number(r.aiQueriesCount || 0),
          tokens: Number(r.tokensUsed || 0),
          docsProcessed: Number(r.aiDocumentsProcessed || 0),
          pagesCount: Number(r.pagesCount || 0),
        },
      ]),
    );

    for (const company of companies) {
      const limits = resolveCompanyEffectiveLimits(company);
      const activeUsers = userCountMap.get(company.id) ?? 0;
      const docStats = docStatsMap.get(company.id) ?? { count: 0, bytes: 0 };
      const aiStats = aiUsageMap.get(company.id) ?? { queries: 0, tokens: 0, docsProcessed: 0, pagesCount: 0 };
      const currentStorageMb = bytesToMegabytes(docStats.bytes);
      const maxStoredFiles = limits.maxDocuments ?? limits.maxPages;
      const effectiveStorageMax =
        limits.maxStorageMb ?? calcStorageMbFromDocuments(maxStoredFiles);

      const storageMetric = buildQuotaMetric(currentStorageMb, effectiveStorageMax);
      const aiMetric = buildQuotaMetric(aiStats.queries, limits.maxAiQueriesMonthly);
      const storedDocsMetric = buildQuotaMetric(docStats.count, maxStoredFiles);
      const pagesMetric = buildQuotaMetric(
        aiStats.pagesCount,
        limits.maxPages ?? limits.maxDocuments,
      );
      const unitPriceArs = Number(limits.pricePerProcessedDocumentArs || 0);
      const additionalCostArs = Number(
        (aiStats.docsProcessed * unitPriceArs).toFixed(2),
      );
      const rawPlanPrice = Number(company.plan?.priceMonthly || 0);
      const planCurrency = (company.plan?.currency ||
        (rawPlanPrice === 0 ? 'ARS' : 'USD')) as 'ARS' | 'USD';
      const convertedPlanPrice =
        planCurrency === 'USD' ? rawPlanPrice * usdRate : rawPlanPrice;
      const planBasePriceArs = roundPrices
        ? Math.ceil(convertedPlanPrice)
        : Number(convertedPlanPrice.toFixed(2));
      const totalToChargeArs = Number((planBasePriceArs + additionalCostArs).toFixed(2));

      result.set(company.id, {
        companyId: company.id,
        plan: company.plan
          ? {
              id: company.plan.id,
              name: company.plan.name,
              slug: company.plan.slug,
              badgeColor: company.plan.badgeColor || 'primary',
            }
          : null,
        useCustomLimits: Boolean(company.useCustomLimits),
        users: buildQuotaMetric(activeUsers, limits.maxUsers),
        pages: pagesMetric,
        documents: storedDocsMetric,
        storageMb: { ...storageMetric, currentBytes: docStats.bytes },
        aiQueries: {
          ...aiMetric,
          period,
          tokensUsed: aiStats.tokens,
          aiDocumentsProcessed: aiStats.docsProcessed,
        },
        totalPagesUploaded: company.totalPagesUploaded ?? 0,
        totalDocumentsProcessed: company.totalDocumentsProcessed ?? 0,
        processingBilling: {
          period,
          processedCount: aiStats.docsProcessed,
          unitPriceArs,
          additionalCostArs,
          planBasePriceArs,
          planOriginalPrice: rawPlanPrice,
          planCurrency,
          exchangeRateApplied: usdRate,
          totalToChargeArs,
        },
        activeDocumentsCount: docStats.count,
        activeFtpDevicesCount: ftpDeviceCountMap.get(company.id) ?? 0,
        channels: (() => {
          const enabledModules = Array.isArray(company.enabledModules)
            ? company.enabledModules
            : [];
          const emailCh = emailChannelMap.get(company.id);
          const waCh = whatsappChannelMap.get(company.id);
          const tgCh = telegramChannelMap.get(company.id);
          const waEnabled = enabledModules.includes('whatsapp');
          const emailEnabled = enabledModules.includes('email');
          const tgEnabled = enabledModules.includes('telegram');

          return {
            enabledModules,
            whatsapp: {
              enabledInPlan: waEnabled,
              configured: Boolean(waCh),
              active:
                waEnabled &&
                Boolean(waCh?.isActive) &&
                waCh?.connectionStatus === WhatsappConnectionStatus.CONNECTED,
              status: waCh?.connectionStatus || 'DISCONNECTED',
            },
            email: {
              enabledInPlan: emailEnabled,
              configured: Boolean(emailCh),
              active: emailEnabled && Boolean(emailCh?.isActive),
            },
            telegram: {
              enabledInPlan: tgEnabled,
              configured: Boolean(tgCh),
              active: tgEnabled && Boolean(tgCh?.isActive),
            },
          };
        })(),
      });
    }

    return result;
  }
}

