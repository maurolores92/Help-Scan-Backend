import {
  extractUniversalHeuristicsFromText,
  refineArcaDocumentType,
} from './local-pdf-heuristics.helper';

describe('local-pdf-heuristics.helper', () => {
  it('clasifica como nota_debito cuando el PDF local contiene Nota de Débito y CAE', () => {
    const sample = [
      'ACME S.A. - CUIT: 30-71234567-9',
      'NOTA DE DÉBITO B - COD. 007',
      'Punto de Venta: 00004 Comp. Nro: 00000089',
      'Fecha de Emisión: 25/11/2026',
      'CAE N°: 74481234567890',
      'Importe Total: $ 18.500,00',
    ].join('\n');

    const res = extractUniversalHeuristicsFromText(sample, 'nd_mora.pdf', 1);
    expect(res.documentType).toBe('nota_debito');
  });

  it('clasifica como nota_credito cuando el PDF local contiene Nota de Crédito y CAE', () => {
    const sample = [
      'ACME S.A. - CUIT: 30-71234567-9',
      'NOTA DE CRÉDITO A - COD. 003',
      'Punto de Venta: 00004 Comp. Nro: 00000120',
      'CAE N°: 74481234567891',
      'Importe Total: $ 25.000,00',
    ].join('\n');

    const res = extractUniversalHeuristicsFromText(sample, 'nc_devolucion.pdf', 1);
    expect(res.documentType).toBe('nota_credito');
  });

  it('corrige factura hacia nota_debito si codigo_arca o cabecera corresponden a ND ARCA', () => {
    expect(
      refineArcaDocumentType('factura_a', 'ORIGINAL NOTA DE DEBITO A COD. 002', {
        codigo_arca: '002',
      }),
    ).toBe('nota_debito');

    expect(
      refineArcaDocumentType('factura', 'NOTA DE CREDITO ELECTRONICA MiPyME COD. 203', {
        subtipo_fiscal: 'Nota de Crédito',
      }),
    ).toBe('nota_credito');

    expect(
      refineArcaDocumentType('transferencia_pago', 'Help Copies A Codigo 01 COMPROBANTE FACTURA', {
        codigo_arca: '001',
      }),
    ).toBe('factura');
  });

  it('clasifica como factura aunque el pie mencione transferencia bancaria y columna REMITO', () => {
    const sample = [
      'Help Copies S.R.L. - A - Codigo 01 - Nro. 00008-00041950',
      'COMPROBANTE FACTURA - FECHA 01/10/2026',
      'Señores: GIOLA HNOS MDQ S.A. - CUIT: 30-71719467-1',
      'CONDICIONES DE VENTA | FECHA VTO. | REMITO | N° CUENTA',
      'CTA. CTE. 15 DIAS F.F.',
      'Pagará por transferencia bancaria a CBU 0720000000000000000000',
      'CAE N°: 74481234567890',
    ].join('\n');

    const res = extractUniversalHeuristicsFromText(sample, 'FAC_A0000800041950.pdf', 1);
    expect(res.documentType).toBe('factura');
  });
});
