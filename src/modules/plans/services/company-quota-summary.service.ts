import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { col, fn, Op } from 'sequelize';
import { Plan } from '../plan.model';
import { CompanyMonthlyUsage } from '../models/company-monthly-usage.model';
import { Company } from '../../companies/company.model';
import { Users, UserStatus } from '../../users/users.model';
import { Document } from '../../documents/document.model';
import { FtpDevice, FtpDeviceStatus } from '../../ftp-devices/ftp-device.model';
import {
  buildQuotaMetric,
  bytesToMegabytes,
  calcStorageMbFromDocuments,
  CompanyQuotaSummary,
  getCurrentBillingPeriod,
  resolveCompanyEffectiveLimits,
} from '../helpers/quota-calculator.helper';

/**
 * Servicio especializado en el cálculo agregado y sin N+1 del resumen de cuotas
 * y consumo actual (usuarios, PDFs, MB en disco y consultas IA mensuales) por compañía.
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

    const [userCountsRaw, docAggregatesRaw, aiUsagesRaw, ftpDeviceCountsRaw] = await Promise.all([
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
    ]);

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
        },
        activeDocumentsCount: docStats.count,
        activeFtpDevicesCount: ftpDeviceCountMap.get(company.id) ?? 0,
      });
    }

    return result;
  }
}

