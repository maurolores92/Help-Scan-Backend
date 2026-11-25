export interface QuotaMetricItem {
  current: number;
  max: number | null;
  unlimited: boolean;
  percentage: number;
}

export interface StorageQuotaMetricItem extends QuotaMetricItem {
  currentBytes: number;
}

export interface AiQuotaMetricItem extends QuotaMetricItem {
  period: string;
  tokensUsed: number;
  aiDocumentsProcessed: number;
}

export interface EffectiveCompanyLimits {
  maxUsers: number | null;
  maxPages: number | null;
  maxDocuments: number | null;
  maxStorageMb: number | null;
  maxAiQueriesMonthly: number | null;
  pricePerProcessedDocumentArs: number;
}

export interface DocumentProcessingBillingSummary {
  period: string;
  processedCount: number;
  unitPriceArs: number;
  additionalCostArs: number;
}

export interface CompanyQuotaSummary {
  companyId: number;
  plan: {
    id: number;
    name: string;
    slug: string;
    badgeColor: string;
  } | null;
  useCustomLimits: boolean;
  users: QuotaMetricItem;
  pages: QuotaMetricItem;
  documents: QuotaMetricItem;
  storageMb: StorageQuotaMetricItem;
  aiQueries: AiQuotaMetricItem;
  totalPagesUploaded?: number;
  totalDocumentsProcessed?: number;
  processingBilling?: DocumentProcessingBillingSummary;
  activeDocumentsCount?: number;
  activeFtpDevicesCount?: number;
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Calcula la cuota de storage en MB (base binaria: 1000 archivos ≈ 1024 MB = 1 GB)
 * a partir del límite máximo de archivos almacenados.
 */
export const calcStorageMbFromDocuments = (
  maxDocuments: number | null | undefined,
): number | null => {
  if (maxDocuments === null || maxDocuments === undefined || maxDocuments <= 0) {
    return null;
  }
  return Math.max(1, Math.round((Number(maxDocuments) / 1000) * 1024));
};

/**
 * Retorna el período mensual actual en formato 'YYYY-MM'.
 */
export const getCurrentBillingPeriod = (date: Date = new Date()): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

/**
 * Convierte bytes a megabytes con redondeo a 2 decimales.
 */
export const bytesToMegabytes = (bytes: number): number => {
  if (!bytes || bytes <= 0) return 0;
  return Number((bytes / BYTES_PER_MB).toFixed(2));
};

/**
 * Normaliza un límite numérico donde `null` representa capacidad ilimitada.
 * Nota: para `maxAiQueriesMonthly`, `0` significa sin consultas permitidas, mientras `null` es ilimitado.
 */
export const normalizeNullableLimit = (
  value: number | null | undefined,
  treatZeroAsUnlimited = false,
): number | null => {
  if (value === null || value === undefined) return null;
  if (treatZeroAsUnlimited && value <= 0) return null;
  return Number(value);
};

/**
 * Construye una métrica estandarizada de cuota con porcentaje y bandera `unlimited`.
 */
export const buildQuotaMetric = (
  current: number,
  max: number | null,
): QuotaMetricItem => {
  const safeCurrent = Math.max(0, current);
  if (max === null) {
    return {
      current: safeCurrent,
      max: null,
      unlimited: true,
      percentage: 0,
    };
  }

  if (max <= 0) {
    return {
      current: safeCurrent,
      max: 0,
      unlimited: false,
      percentage: safeCurrent > 0 ? 100 : 0,
    };
  }

  const percentage = Math.min(Math.round((safeCurrent / max) * 100), 100);
  return {
    current: safeCurrent,
    max,
    unlimited: false,
    percentage,
  };
};

/**
 * Determina los límites efectivos de una compañía combinando su Plan asociado y overrides personalizados.
 */
export const resolveCompanyEffectiveLimits = (company: {
  useCustomLimits?: boolean;
  maxUsers?: number | null;
  maxPages?: number | null;
  maxDocuments?: number | null;
  maxStorageMb?: number | null;
  maxAiQueriesMonthly?: number | null;
  plan?: {
    maxUsers: number | null;
    maxPages?: number | null;
    maxDocuments: number | null;
    maxStorageMb: number | null;
    maxAiQueriesMonthly: number | null;
    pricePerProcessedDocumentArs?: number | null;
  } | null;
}): EffectiveCompanyLimits => {
  const hasPlan = Boolean(company.plan);
  const useCustom = Boolean(company.useCustomLimits) || !hasPlan;
  const pricePerProcessedDocumentArs = Number(
    company.plan?.pricePerProcessedDocumentArs || 0,
  );

  if (!useCustom && company.plan) {
    const planDocs = normalizeNullableLimit(
      company.plan.maxDocuments ?? company.plan.maxPages,
      true,
    );
    const planStorageMb =
      normalizeNullableLimit(company.plan.maxStorageMb, true) ??
      calcStorageMbFromDocuments(planDocs);

    return {
      maxUsers: normalizeNullableLimit(company.plan.maxUsers, true),
      maxPages: planDocs,
      maxDocuments: planDocs,
      maxStorageMb: planStorageMb,
      maxAiQueriesMonthly: normalizeNullableLimit(
        company.plan.maxAiQueriesMonthly,
        false,
      ),
      pricePerProcessedDocumentArs,
    };
  }

  const fallbackPlan = company.plan;
  const customDocs =
    company.maxDocuments !== undefined
      ? normalizeNullableLimit(company.maxDocuments, true)
      : company.maxPages !== undefined
        ? normalizeNullableLimit(company.maxPages, true)
        : normalizeNullableLimit(
            fallbackPlan?.maxDocuments ?? fallbackPlan?.maxPages,
            true,
          );

  const customStorageMb =
    company.maxStorageMb !== undefined
      ? normalizeNullableLimit(company.maxStorageMb, true)
      : normalizeNullableLimit(fallbackPlan?.maxStorageMb, true);

  return {
    maxUsers:
      company.maxUsers !== undefined
        ? normalizeNullableLimit(company.maxUsers, true)
        : normalizeNullableLimit(fallbackPlan?.maxUsers, true),
    maxPages: customDocs,
    maxDocuments: customDocs,
    maxStorageMb: customStorageMb ?? calcStorageMbFromDocuments(customDocs),
    maxAiQueriesMonthly:
      company.maxAiQueriesMonthly !== undefined
        ? normalizeNullableLimit(company.maxAiQueriesMonthly, false)
        : normalizeNullableLimit(fallbackPlan?.maxAiQueriesMonthly, false),
    pricePerProcessedDocumentArs,
  };
};

