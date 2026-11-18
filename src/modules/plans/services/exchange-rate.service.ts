import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Plan } from '../plan.model';
import { PlanExchangeConfig } from '../models/plan-exchange-config.model';
import { UpdateExchangeConfigDto } from '../dto/update-exchange-config.dto';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';

export interface PlanPublicWithExchangeRate {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  priceMonthly: number; // Expresado en PESOS (ARS), calculado según cotización y redondeo
  currency: 'ARS';
  originalPrice: number;
  originalCurrency: 'ARS' | 'USD';
  exchangeRate: number;
  roundPrices: boolean;
  isTrial: boolean;
  trialDays: number | null;
  maxUsers: number | null;
  maxDocuments: number | null;
  maxStorageMb: number | null;
  maxAiQueriesMonthly: number | null;
  includedModules: string[];
  badgeColor: string;
  isDefault: boolean;
}

export interface ExchangeConfigResponse {
  id: number;
  usdRate: number;
  roundPrices: boolean;
  updatedBy: number | null;
  updatedAt?: Date;
}

@Injectable()
export class ExchangeRateService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRateService.name);

  private readonly defaultRate = process.env.USD_EXCHANGE_RATE
    ? Number(process.env.USD_EXCHANGE_RATE)
    : 1250;

  constructor(
    @InjectModel(PlanExchangeConfig)
    private readonly configModel: typeof PlanExchangeConfig,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit() {
    await this.ensureTableAndDefault();
  }

  /**
   * Asegura que la tabla plan_exchange_config exista y contenga al menos un registro inicial.
   */
  async ensureTableAndDefault(): Promise<PlanExchangeConfig> {
    try {
      await this.configModel.sync();
    } catch (err: any) {
      this.logger.warn(`[ExchangeRateService] Aviso al sincronizar plan_exchange_config: ${err.message}`);
    }

    try {
      let config = await this.configModel.findOne({ order: [['id', 'ASC']] });
      if (!config) {
        config = await this.configModel.create({
          usdRate: this.defaultRate,
          roundPrices: true,
          updatedBy: null,
        } as any);
        this.logger.log(`[ExchangeRateService] Inicializada configuración base de cotización: $${this.defaultRate} ARS`);
      }
      return config;
    } catch (err: any) {
      this.logger.warn(`[ExchangeRateService] Error al inicializar registro de cotización: ${err.message}`);
      return {
        id: 1,
        usdRate: this.defaultRate,
        roundPrices: true,
        updatedBy: null,
      } as PlanExchangeConfig;
    }
  }

  /**
   * Obtiene la configuración de cotización y redondeo persistida en base de datos.
   * Si no existe aún un registro o la tabla está ausente, la crea automáticamente.
   */
  async getConfig(): Promise<PlanExchangeConfig> {
    try {
      const config = await this.configModel.findOne({ order: [['id', 'ASC']] });
      if (!config) {
        return await this.ensureTableAndDefault();
      }
      return config;
    } catch (err: any) {
      this.logger.warn(`[ExchangeRateService] Error al consultar plan_exchange_config (${err.message}). Reintentando tras sincronización...`);
      return await this.ensureTableAndDefault();
    }
  }

  /**
   * Actualiza la cotización del dólar y/o la política de redondeo.
   * Exclusivo del Super Administrador con registro en auditoría.
   */
  async updateConfig(
    dto: UpdateExchangeConfigDto,
    actorUserId?: number,
  ): Promise<ExchangeConfigResponse> {
    let config: PlanExchangeConfig | null = null;
    try {
      config = await this.configModel.findOne({ order: [['id', 'ASC']] });
    } catch (err: any) {
      this.logger.warn(`[ExchangeRateService] Tabla ausente al actualizar. Sincronizando modelo...`);
      await this.configModel.sync();
      config = await this.configModel.findOne({ order: [['id', 'ASC']] });
    }

    const previous = config ? config.toJSON() : null;

    if (!config) {
      config = await this.configModel.create({
        usdRate: dto.usdRate,
        roundPrices: dto.roundPrices !== undefined ? dto.roundPrices : true,
        updatedBy: actorUserId ?? null,
      } as any);
    } else {
      if (dto.usdRate !== undefined) {
        config.usdRate = dto.usdRate;
      }
      if (dto.roundPrices !== undefined) {
        config.roundPrices = dto.roundPrices;
      }
      config.updatedBy = actorUserId ?? null;
      await config.save();
    }

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'PlanExchangeConfig',
      entityId: config.id,
      companyId: null,
      userId: actorUserId,
      payload: { previous, updated: config.toJSON() },
      description: `Actualizada cotización USD a $${config.usdRate} ARS (Redondeo: ${config.roundPrices ? 'Activado' : 'Desactivado'})`,
    });

    this.logger.log(`[ExchangeRateService] Cotización USD actualizada: $${config.usdRate} ARS | Redondeo: ${config.roundPrices}`);

    return {
      id: config.id,
      usdRate: Number(config.usdRate),
      roundPrices: Boolean(config.roundPrices),
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * Retorna la cotización activa del dólar.
   */
  async getUsdRate(): Promise<number> {
    const config = await this.getConfig();
    return Number(config.usdRate || this.defaultRate);
  }

  /**
   * Transforma un Plan para su visualización pública en la web,
   * calculando el precio mensual en PESOS (ARS) según la cotización guardada
   * y aplicando el redondeo configurable.
   */
  async formatPlanForPublicWeb(plan: Plan): Promise<PlanPublicWithExchangeRate> {
    const config = await this.getConfig();
    const usdRate = Number(config.usdRate || this.defaultRate);
    const roundPrices = Boolean(config.roundPrices);
    const rawPrice = Number(plan.priceMonthly || 0);
    const planCurrency = (plan.currency || (rawPrice === 0 ? 'ARS' : 'USD')) as 'ARS' | 'USD';

    let finalPriceInPesos: number;
    if (planCurrency === 'USD') {
      const converted = rawPrice * usdRate;
      finalPriceInPesos = roundPrices ? Math.ceil(converted) : Number(converted.toFixed(2));
    } else {
      finalPriceInPesos = roundPrices ? Math.ceil(rawPrice) : Number(rawPrice.toFixed(2));
    }

    return {
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      priceMonthly: finalPriceInPesos,
      currency: 'ARS',
      originalPrice: rawPrice,
      originalCurrency: planCurrency,
      exchangeRate: usdRate,
      roundPrices,
      isTrial: Boolean(plan.isTrial),
      trialDays: plan.trialDays ?? null,
      maxUsers: plan.maxUsers,
      maxDocuments: plan.maxDocuments,
      maxStorageMb: plan.maxStorageMb,
      maxAiQueriesMonthly: plan.maxAiQueriesMonthly,
      includedModules: plan.includedModules || [],
      badgeColor: plan.badgeColor || 'primary',
      isDefault: Boolean(plan.isDefault),
    };
  }
}
