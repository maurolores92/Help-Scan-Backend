import { DocumentLinkType } from '../models/document-link.model';
import {
  normalizeVoucherCode,
  resolveLinkDirectionAndType,
  scoreMatchCandidate,
  voucherCodesMatch,
} from './document-matching.helper';

describe('document-matching.helper', () => {
  it('normaliza números de comprobante ARCA removiendo ceros a la izquierda y prefijos', () => {
    expect(normalizeVoucherCode('0001-00004521')).toBe('1-4521');
    expect(normalizeVoucherCode('A 00001-00004521')).toBe('1-4521');
    expect(normalizeVoucherCode('4521', '0001')).toBe('1-4521');
    expect(voucherCodesMatch('1-4521', '1-4521')).toBe('exact');
    expect(voucherCodesMatch('4521', '1-4521')).toBe('suffix');
  });

  it('resuelve dirección canónica y tipo de vínculo según documentos', () => {
    expect(resolveLinkDirectionAndType('recibo', 'factura')).toEqual({
      linkType: DocumentLinkType.PAYMENT_IMPUTATION,
      swapDirection: false,
    });
    expect(resolveLinkDirectionAndType('remito', 'factura')).toEqual({
      linkType: DocumentLinkType.BILLING_FROM_DELIVERY,
      swapDirection: true,
    });
    expect(resolveLinkDirectionAndType('nota_credito', 'factura')).toEqual({
      linkType: DocumentLinkType.CREDIT_NOTE_ADJUSTMENT,
      swapDirection: false,
    });
    expect(resolveLinkDirectionAndType('transferencia_pago', 'orden_pago')).toEqual({
      linkType: DocumentLinkType.PAYMENT_EXECUTION,
      swapDirection: false,
    });
  });

  it('asigna score alto y match exacto cuando un recibo referencia una factura del mismo cliente', () => {
    const scored = scoreMatchCandidate(
      {
        id: 200,
        documentType: 'recibo',
        clientId: 7,
        recipientTaxId: '30-71234567-9',
        totalAmount: 100000,
        formData: {
          appliedVouchers: [
            { voucherType: 'Factura A', voucherNumber: '0001-00004521', appliedAmount: 60000 },
          ],
        },
      },
      {
        id: 100,
        documentType: 'factura',
        clientId: 7,
        recipientTaxId: '30-71234567-9',
        documentNumber: '0001-00004521',
        totalAmount: 60000,
      },
      60000,
    );

    expect(scored).not.toBeNull();
    expect(scored?.isExactNumberMatch).toBe(true);
    expect(scored?.linkType).toBe(DocumentLinkType.PAYMENT_IMPUTATION);
    expect(scored?.suggestedAppliedAmount).toBe(60000);
    expect(scored?.score).toBeGreaterThanOrEqual(85);
  });

  it('no sugiere vínculo si no comparten cliente, CUIT ni razón social', () => {
    const scored = scoreMatchCandidate(
      {
        id: 201,
        documentType: 'recibo',
        clientId: 7,
        issuerTaxId: '30-11111111-1',
        totalAmount: 50000,
      },
      {
        id: 101,
        documentType: 'factura',
        clientId: 99,
        issuerTaxId: '30-22222222-2',
        documentNumber: '0001-00009999',
        totalAmount: 50000,
      },
      50000,
    );

    expect(scored).toBeNull();
  });
});
