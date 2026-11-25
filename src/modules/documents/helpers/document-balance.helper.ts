import { DocumentPaymentStatus } from '../document.model';
import { DocumentLinkType } from '../models/document-link.model';
import { normalizeDocumentTypeBucket } from '../../clients/helpers/client-document-matching.helper';

export const BALANCE_TOLERANCE_AMOUNT = 1.0;

export interface DocumentBalanceLinkInput {
  sourceDocumentId: number;
  targetDocumentId: number;
  linkType: DocumentLinkType | string;
  appliedAmount?: number | string | null;
  sourceTotalAmount?: number | string | null;
}

export interface SourceImputationSummary {
  isPaymentSource: boolean;
  totalAmount: number;
  imputedAmount: number;
  unappliedAmount: number;
}

const PAYMENT_IMPUTING_BUCKETS = new Set([
  'recibo',
  'orden_pago',
  'transferencia_pago',
  'certificado_retencion',
  'nota_credito',
]);

export function isPaymentSourceType(documentType?: string | null): boolean {
  return PAYMENT_IMPUTING_BUCKETS.has(normalizeDocumentTypeBucket(documentType));
}

/**
 * Calcula cuánto de un recibo, orden de pago, transferencia, retención o NC
 * ya fue imputado a comprobantes destino y cuánto queda disponible por aplicar.
 */
export function computeSourceImputationSummary(params: {
  documentId: number;
  documentType?: string | null;
  totalAmount?: number | string | null;
  links: DocumentBalanceLinkInput[];
}): SourceImputationSummary {
  const isPaymentSource = isPaymentSourceType(params.documentType);
  const totalAmount = roundMoney(Math.max(0, toNumericAmount(params.totalAmount)));
  if (!isPaymentSource) {
    return {
      isPaymentSource: false,
      totalAmount,
      imputedAmount: 0,
      unappliedAmount: 0,
    };
  }

  let imputedAmount = 0;
  for (const link of params.links) {
    if (Number(link.sourceDocumentId) !== Number(params.documentId)) continue;
    if (
      link.linkType === DocumentLinkType.PAYMENT_IMPUTATION ||
      link.linkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT
    ) {
      const amt = toNumericAmount(link.appliedAmount);
      if (amt > 0) imputedAmount += amt;
    }
  }

  imputedAmount = roundMoney(imputedAmount);
  const unappliedAmount = roundMoney(Math.max(0, totalAmount - imputedAmount));

  return {
    isPaymentSource: true,
    totalAmount,
    imputedAmount,
    unappliedAmount,
  };
}

export interface DocumentBalanceSummary {
  isTrackable: boolean;
  totalAmount: number;
  creditedAmount: number;
  debitedAmount: number;
  paidAmount: number;
  effectiveTotal: number;
  remainingBalance: number;
  overpaidAmount: number;
  derivedPaymentStatus: DocumentPaymentStatus;
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function toNumericAmount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Determina si un documento representa una obligación/comprobante cuyo saldo
 * puede conciliarse contra pagos, retenciones, NC o ND.
 */
export function isBalanceTrackableType(documentType?: string | null): boolean {
  const bucket = normalizeDocumentTypeBucket(documentType);
  return bucket === 'factura' || bucket === 'ticket_fiscal' || bucket === 'nota_debito';
}

/**
 * Calcula el resumen financiero y el saldo pendiente real de un documento a partir
 * de su importe total y los vínculos entrantes/salientes en document_links.
 */
export function computeDocumentBalanceSummary(params: {
  documentId: number;
  documentType?: string | null;
  totalAmount?: number | string | null;
  currentPaymentStatus?: DocumentPaymentStatus | string | null;
  links: DocumentBalanceLinkInput[];
}): DocumentBalanceSummary {
  const trackable = isBalanceTrackableType(params.documentType);
  const totalAmount = roundMoney(Math.max(0, toNumericAmount(params.totalAmount)));

  if (!trackable) {
    return {
      isTrackable: false,
      totalAmount,
      creditedAmount: 0,
      debitedAmount: 0,
      paidAmount: 0,
      effectiveTotal: totalAmount,
      remainingBalance: 0,
      overpaidAmount: 0,
      derivedPaymentStatus:
        (params.currentPaymentStatus as DocumentPaymentStatus) ||
        DocumentPaymentStatus.NOT_APPLICABLE,
    };
  }

  let creditedAmount = 0;
  let debitedAmount = 0;
  let paidAmount = 0;

  for (const link of params.links) {
    if (Number(link.targetDocumentId) !== Number(params.documentId)) continue;
    const amount = toNumericAmount(link.appliedAmount ?? link.sourceTotalAmount);
    if (amount <= 0) continue;

    if (link.linkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT) {
      creditedAmount += amount;
    } else if (link.linkType === DocumentLinkType.DEBIT_NOTE_ADJUSTMENT) {
      debitedAmount += amount;
    } else if (link.linkType === DocumentLinkType.PAYMENT_IMPUTATION) {
      paidAmount += amount;
    }
  }

  creditedAmount = roundMoney(creditedAmount);
  debitedAmount = roundMoney(debitedAmount);
  paidAmount = roundMoney(paidAmount);

  const effectiveTotal = roundMoney(Math.max(0, totalAmount + debitedAmount - creditedAmount));
  const diff = roundMoney(effectiveTotal - paidAmount);
  const remainingBalance = diff > 0 ? diff : 0;
  const overpaidAmount = diff < -BALANCE_TOLERANCE_AMOUNT ? roundMoney(Math.abs(diff)) : 0;

  let derivedPaymentStatus: DocumentPaymentStatus;
  if (
    params.currentPaymentStatus === DocumentPaymentStatus.NOT_APPLICABLE
  ) {
    derivedPaymentStatus = DocumentPaymentStatus.NOT_APPLICABLE;
  } else if (effectiveTotal > 0 && remainingBalance <= BALANCE_TOLERANCE_AMOUNT) {
    derivedPaymentStatus = DocumentPaymentStatus.PAID;
  } else if (paidAmount > 0 || creditedAmount > 0) {
    if (effectiveTotal === 0 && creditedAmount > 0) {
      derivedPaymentStatus = DocumentPaymentStatus.PAID;
    } else if (paidAmount > 0) {
      derivedPaymentStatus = DocumentPaymentStatus.PARTIALLY_PAID;
    } else {
      derivedPaymentStatus =
        params.currentPaymentStatus === DocumentPaymentStatus.SCHEDULED
          ? DocumentPaymentStatus.SCHEDULED
          : DocumentPaymentStatus.PENDING;
    }
  } else if (params.currentPaymentStatus === DocumentPaymentStatus.SCHEDULED) {
    derivedPaymentStatus = DocumentPaymentStatus.SCHEDULED;
  } else {
    derivedPaymentStatus = DocumentPaymentStatus.PENDING;
  }

  return {
    isTrackable: true,
    totalAmount,
    creditedAmount,
    debitedAmount,
    paidAmount,
    effectiveTotal,
    remainingBalance,
    overpaidAmount,
    derivedPaymentStatus,
  };
}
