import { DocumentPaymentStatus } from '../document.model';
import { DocumentLinkType } from '../models/document-link.model';
import {
  computeDocumentBalanceSummary,
  computeSourceImputationSummary,
} from './document-balance.helper';

describe('document-balance.helper', () => {
  it('calcula PARTIALLY_PAID cuando hay un pago parcial sobre una factura', () => {
    const summary = computeDocumentBalanceSummary({
      documentId: 10,
      documentType: 'factura',
      totalAmount: 100000,
      currentPaymentStatus: DocumentPaymentStatus.PENDING,
      links: [
        {
          sourceDocumentId: 20,
          targetDocumentId: 10,
          linkType: DocumentLinkType.PAYMENT_IMPUTATION,
          appliedAmount: 40000,
        },
      ],
    });

    expect(summary.isTrackable).toBe(true);
    expect(summary.paidAmount).toBe(40000);
    expect(summary.remainingBalance).toBe(60000);
    expect(summary.overpaidAmount).toBe(0);
    expect(summary.derivedPaymentStatus).toBe(DocumentPaymentStatus.PARTIALLY_PAID);
  });

  it('aplica Nota de Crédito y Nota de Débito antes de evaluar saldo y pasa a PAID dentro de tolerancia', () => {
    const summary = computeDocumentBalanceSummary({
      documentId: 10,
      documentType: 'factura',
      totalAmount: 100000,
      currentPaymentStatus: DocumentPaymentStatus.PENDING,
      links: [
        {
          sourceDocumentId: 11,
          targetDocumentId: 10,
          linkType: DocumentLinkType.CREDIT_NOTE_ADJUSTMENT,
          appliedAmount: 20000,
        },
        {
          sourceDocumentId: 12,
          targetDocumentId: 10,
          linkType: DocumentLinkType.DEBIT_NOTE_ADJUSTMENT,
          appliedAmount: 5000,
        },
        {
          sourceDocumentId: 13,
          targetDocumentId: 10,
          linkType: DocumentLinkType.PAYMENT_IMPUTATION,
          appliedAmount: 84999.5,
        },
      ],
    });

    expect(summary.creditedAmount).toBe(20000);
    expect(summary.debitedAmount).toBe(5000);
    expect(summary.effectiveTotal).toBe(85000);
    expect(summary.remainingBalance).toBe(0.5);
    expect(summary.derivedPaymentStatus).toBe(DocumentPaymentStatus.PAID);
  });

  it('detecta sobre-imputación sin fallar cuando los pagos superan el total efectivo', () => {
    const summary = computeDocumentBalanceSummary({
      documentId: 10,
      documentType: 'factura',
      totalAmount: 50000,
      currentPaymentStatus: DocumentPaymentStatus.PENDING,
      links: [
        {
          sourceDocumentId: 21,
          targetDocumentId: 10,
          linkType: DocumentLinkType.PAYMENT_IMPUTATION,
          appliedAmount: 55000,
        },
      ],
    });

    expect(summary.remainingBalance).toBe(0);
    expect(summary.overpaidAmount).toBe(5000);
    expect(summary.derivedPaymentStatus).toBe(DocumentPaymentStatus.PAID);
  });

  it('marca isTrackable=false para documentos logísticos como remito', () => {
    const summary = computeDocumentBalanceSummary({
      documentId: 30,
      documentType: 'remito',
      totalAmount: 0,
      currentPaymentStatus: DocumentPaymentStatus.NOT_APPLICABLE,
      links: [],
    });

    expect(summary.isTrackable).toBe(false);
    expect(summary.derivedPaymentStatus).toBe(DocumentPaymentStatus.NOT_APPLICABLE);
  });

  it('calcula cuánto falta imputar en un recibo con imputaciones parciales', () => {
    const imp = computeSourceImputationSummary({
      documentId: 20,
      documentType: 'recibo',
      totalAmount: 100000,
      links: [
        {
          sourceDocumentId: 20,
          targetDocumentId: 10,
          linkType: DocumentLinkType.PAYMENT_IMPUTATION,
          appliedAmount: 35000,
        },
      ],
    });

    expect(imp.isPaymentSource).toBe(true);
    expect(imp.imputedAmount).toBe(35000);
    expect(imp.unappliedAmount).toBe(65000);
  });
});
