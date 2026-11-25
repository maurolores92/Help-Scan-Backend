import {
  buildDocumentValidationWarnings,
  checkAmountConsistency,
  isValidArgentineCuit,
  normalizeFiscalNumberKey,
  resolveDefaultPaymentStatus,
} from './document-fiscal-checks.helper';

describe('document-fiscal-checks.helper', () => {
  it('valida correctamente dígito verificador de CUIT argentino y detecta inválidos', () => {
    expect(isValidArgentineCuit('30-70841005-1')).toBe(true);
    expect(isValidArgentineCuit('20-11111111-1')).toBe(false);
    expect(isValidArgentineCuit('30-12345')).toBe(false);
    expect(isValidArgentineCuit('')).toBe(true);
  });

  it('normaliza números fiscales removiendo ceros a la izquierda por tramo', () => {
    expect(normalizeFiscalNumberKey('0008-00041980')).toBe('8-41980');
    expect(normalizeFiscalNumberKey('00008-00041980')).toBe('8-41980');
    expect(normalizeFiscalNumberKey('41980', '00008')).toBe('8-41980');
  });

  it('detecta descuadre matemático cuando neto + IVA + otros no coincide con total', () => {
    const mismatch = checkAmountConsistency({
      netAmount: 10000,
      taxAmount: 2100,
      totalAmount: 13500,
    });
    expect(mismatch?.code).toBe('AMOUNT_MISMATCH');

    const ok = checkAmountConsistency({
      netAmount: 10000,
      taxAmount: 2100,
      exemptAmount: 500,
      totalAmount: 12600,
    });
    expect(ok).toBeNull();
  });

  it('combina advertencias de duplicado fiscal, CUIT inválido y descuadre', () => {
    const warnings = buildDocumentValidationWarnings(
      {
        issuerTaxId: '20-11111111-1',
        netAmount: 1000,
        taxAmount: 210,
        totalAmount: 1500,
      },
      { id: 42, originalName: 'factura_original.pdf' },
    );

    expect(warnings.map((w) => w.code)).toEqual([
      'DUPLICATE_FISCAL',
      'INVALID_CUIT',
      'AMOUNT_MISMATCH',
    ]);
    expect(warnings[0].relatedDocumentId).toBe(42);
  });

  it('asigna NOT_APPLICABLE por defecto a remitos, legajos, notas de crédito, retenciones, transferencias y presupuestos', () => {
    expect(resolveDefaultPaymentStatus('remito')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('legajo')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('nota_credito')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('certificado_retencion')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('transferencia_pago')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('presupuesto')).toBe('NOT_APPLICABLE');
    expect(resolveDefaultPaymentStatus('factura_a')).toBe('PENDING');
  });
});
