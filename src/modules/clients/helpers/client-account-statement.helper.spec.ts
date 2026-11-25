import { DocumentPaymentStatus, DocumentStatus } from '../../documents/document.model';
import { DocumentLinkType } from '../../documents/models/document-link.model';
import {
  computeDocumentBalanceSummary,
  computeSourceImputationSummary,
} from '../../documents/helpers/document-balance.helper';
import { computeClientAccountStatement } from './client-account-statement.helper';

describe('client-account-statement.helper', () => {
  it('consolida facturado neto, cobrado, saldo pendiente, recibos sin imputar y remitos sin facturar', () => {
    const fc1Links = [
      {
        sourceDocumentId: 201,
        targetDocumentId: 101,
        linkType: DocumentLinkType.PAYMENT_IMPUTATION,
        appliedAmount: 40000,
      },
    ];
    const fc1Balance = computeDocumentBalanceSummary({
      documentId: 101,
      documentType: 'factura',
      totalAmount: 100000,
      currentPaymentStatus: DocumentPaymentStatus.PARTIALLY_PAID,
      links: fc1Links,
    });
    const fc2Balance = computeDocumentBalanceSummary({
      documentId: 102,
      documentType: 'factura',
      totalAmount: 50000,
      currentPaymentStatus: DocumentPaymentStatus.PENDING,
      links: [],
    });

    const rec1Imp = computeSourceImputationSummary({
      documentId: 201,
      documentType: 'recibo',
      totalAmount: 90000,
      links: fc1Links,
    });

    const statement = computeClientAccountStatement([
      {
        doc: { id: 101, status: DocumentStatus.VALIDATED, documentType: 'factura', totalAmount: 100000 },
        clientRole: 'recipient',
        normalizedType: 'factura',
        linkedCount: 1,
        balanceSummary: fc1Balance,
        imputationSummary: { isPaymentSource: false, totalAmount: 100000, imputedAmount: 0, unappliedAmount: 0 },
      },
      {
        doc: { id: 102, status: DocumentStatus.VALIDATED, documentType: 'factura', totalAmount: 50000 },
        clientRole: 'recipient',
        normalizedType: 'factura',
        linkedCount: 0,
        balanceSummary: fc2Balance,
        imputationSummary: { isPaymentSource: false, totalAmount: 50000, imputedAmount: 0, unappliedAmount: 0 },
      },
      {
        doc: { id: 201, status: DocumentStatus.VALIDATED, documentType: 'recibo', totalAmount: 90000 },
        clientRole: 'recipient',
        normalizedType: 'recibo',
        linkedCount: 1,
        balanceSummary: {
          isTrackable: false,
          totalAmount: 90000,
          creditedAmount: 0,
          debitedAmount: 0,
          paidAmount: 0,
          effectiveTotal: 90000,
          remainingBalance: 0,
          overpaidAmount: 0,
          derivedPaymentStatus: DocumentPaymentStatus.NOT_APPLICABLE,
        },
        imputationSummary: rec1Imp,
      },
      {
        doc: { id: 301, status: DocumentStatus.VALIDATED, documentType: 'remito', totalAmount: 0 },
        clientRole: 'recipient',
        normalizedType: 'remito',
        linkedCount: 0,
        balanceSummary: {
          isTrackable: false,
          totalAmount: 0,
          creditedAmount: 0,
          debitedAmount: 0,
          paidAmount: 0,
          effectiveTotal: 0,
          remainingBalance: 0,
          overpaidAmount: 0,
          derivedPaymentStatus: DocumentPaymentStatus.NOT_APPLICABLE,
        },
        imputationSummary: { isPaymentSource: false, totalAmount: 0, imputedAmount: 0, unappliedAmount: 0 },
      },
    ]);

    expect(statement.totalInvoicedNet).toBe(150000);
    expect(statement.totalPaidOrCollected).toBe(40000);
    expect(statement.totalRemainingBalance).toBe(110000);
    expect(statement.partialInvoicesCount).toBe(1);
    expect(statement.pendingInvoicesCount).toBe(1);
    expect(statement.paidInvoicesCount).toBe(0);
    expect(statement.totalUnappliedPayments).toBe(50000);
    expect(statement.unlinkedReceiptsCount).toBe(1);
    expect(statement.unbilledRemitosCount).toBe(1);
  });
});
