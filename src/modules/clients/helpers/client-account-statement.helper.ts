import { DocumentPaymentStatus, DocumentStatus } from '../../documents/document.model';
import {
  DocumentBalanceSummary,
  SourceImputationSummary,
  isBalanceTrackableType,
  isPaymentSourceType,
} from '../../documents/helpers/document-balance.helper';
import { ClientDocumentRole } from './client-document-matching.helper';

export interface AccountStatementBreakdown {
  invoicedNet: number;
  paidOrCredited: number;
  remainingBalance: number;
  invoicesCount: number;
  paidCount: number;
  partialCount: number;
  pendingCount: number;
}

export interface ClientAccountStatement {
  totalInvoicedNet: number;
  totalPaidOrCollected: number;
  totalRemainingBalance: number;
  totalPaymentsAmount: number;
  totalUnappliedPayments: number;
  invoicesCount: number;
  paidInvoicesCount: number;
  partialInvoicesCount: number;
  pendingInvoicesCount: number;
  unlinkedReceiptsCount: number;
  unbilledRemitosCount: number;
  receivable: AccountStatementBreakdown;
  payable: AccountStatementBreakdown;
}

export interface StatementDocInput {
  doc: {
    id: number;
    status?: string | null;
    documentType?: string | null;
    paymentStatus?: string | null;
    totalAmount?: number | string | null;
  };
  clientRole: ClientDocumentRole;
  normalizedType: string;
  linkedCount: number;
  balanceSummary: DocumentBalanceSummary;
  imputationSummary: SourceImputationSummary;
}

const emptyBreakdown = (): AccountStatementBreakdown => ({
  invoicedNet: 0,
  paidOrCredited: 0,
  remainingBalance: 0,
  invoicesCount: 0,
  paidCount: 0,
  partialCount: 0,
  pendingCount: 0,
});

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Consolida el estado de cuenta corriente del cliente separando cuentas a cobrar
 * (cliente destinatario) y a pagar (cliente emisor / proveedor), más pagos sin imputar
 * y remitos sin facturar para detectar rápidamente qué falta conciliar.
 */
export function computeClientAccountStatement(
  items: StatementDocInput[],
): ClientAccountStatement {
  const receivable = emptyBreakdown();
  const payable = emptyBreakdown();

  let totalPaymentsAmount = 0;
  let totalUnappliedPayments = 0;
  let unlinkedReceiptsCount = 0;
  let unbilledRemitosCount = 0;

  for (const item of items) {
    const status = item.doc.status;
    if (status === DocumentStatus.REJECTED || status === DocumentStatus.ERROR) {
      continue;
    }

    if (isBalanceTrackableType(item.normalizedType)) {
      const bal = item.balanceSummary;
      const effectiveStatus = bal.isTrackable
        ? bal.derivedPaymentStatus
        : ((item.doc.paymentStatus as DocumentPaymentStatus) || DocumentPaymentStatus.PENDING);

      const target =
        item.clientRole === 'issuer' ? payable : receivable;

      target.invoicesCount += 1;
      target.invoicedNet += bal.effectiveTotal;
      target.paidOrCredited += bal.paidAmount;
      target.remainingBalance += bal.remainingBalance;

      if (effectiveStatus === DocumentPaymentStatus.PAID) {
        target.paidCount += 1;
      } else if (effectiveStatus === DocumentPaymentStatus.PARTIALLY_PAID) {
        target.partialCount += 1;
      } else if (effectiveStatus !== DocumentPaymentStatus.NOT_APPLICABLE) {
        target.pendingCount += 1;
      }
    }

    if (isPaymentSourceType(item.normalizedType)) {
      const imp = item.imputationSummary;
      totalPaymentsAmount += imp.totalAmount;
      totalUnappliedPayments += imp.unappliedAmount;
      if (item.linkedCount === 0 || imp.unappliedAmount > 1) {
        unlinkedReceiptsCount += 1;
      }
    }

    if (item.normalizedType === 'remito' && item.linkedCount === 0) {
      unbilledRemitosCount += 1;
    }
  }

  for (const b of [receivable, payable]) {
    b.invoicedNet = round2(b.invoicedNet);
    b.paidOrCredited = round2(b.paidOrCredited);
    b.remainingBalance = round2(b.remainingBalance);
  }

  return {
    totalInvoicedNet: round2(receivable.invoicedNet + payable.invoicedNet),
    totalPaidOrCollected: round2(receivable.paidOrCredited + payable.paidOrCredited),
    totalRemainingBalance: round2(receivable.remainingBalance + payable.remainingBalance),
    totalPaymentsAmount: round2(totalPaymentsAmount),
    totalUnappliedPayments: round2(totalUnappliedPayments),
    invoicesCount: receivable.invoicesCount + payable.invoicesCount,
    paidInvoicesCount: receivable.paidCount + payable.paidCount,
    partialInvoicesCount: receivable.partialCount + payable.partialCount,
    pendingInvoicesCount: receivable.pendingCount + payable.pendingCount,
    unlinkedReceiptsCount,
    unbilledRemitosCount,
    receivable,
    payable,
  };
}
