import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const RECIBO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'recibo',
  label: 'Recibo de Cobro (X / Recibo Fiscal ARCA)',
  description:
    'Recibos de cobranza sobre múltiples facturas (pagos totales o parciales), con valores recibidos y retenciones sufridas.',
  icon: 'tabler:receipt',
  displayOrder: 7,
  version: 3,
  matchAliases: ['recibo', 'recibo_x', 'recibo_c', 'recibo_b', 'recibo_a', 'comprobante_cobro'],
  aiExtractionGuide:
    'Recibo de cobranza emitido o recibido (Recibo X o Recibo Fiscal ARCA A/B/C con CAE/CAI). Extraer medio de pago, banco/billetera, retenciones sufridas, importe total recibido y el arreglo estructurado "comprobantes_imputados" con cada factura o comprobante cancelado (voucherType, voucherNumber, voucherDate, originalAmount, appliedAmount).',
  sectionsSchema: [
    {
      id: 'recibo_header',
      title: '1. Tipo de Recibo y Numeración',
      icon: 'tabler:receipt',
      fields: [
        {
          key: 'receiptClass',
          target: 'custom',
          label: 'Naturaleza del Recibo',
          fieldType: 'select',
          colSpan: 5,
          defaultValue: 'Recibo X (Cobranza / Interno)',
          options: ['Recibo X (Cobranza / Interno)', 'Recibo Fiscal ARCA (Letra A/B/C)'],
          aiAttrKeys: ['tipo_recibo', 'clase_recibo'],
        },
        { key: 'documentLetter', target: 'core', label: 'Letra', fieldType: 'select', colSpan: 2, options: ['X', 'A', 'B', 'C'] },
        { key: 'pointOfSale', target: 'core', label: 'Pto. Venta', fieldType: 'text', colSpan: 2, placeholder: '00001' },
        { key: 'documentNumber', target: 'core', label: 'N° de Recibo', fieldType: 'text', colSpan: 3, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha de Cobro', fieldType: 'date', colSpan: 4, required: true },
        { key: 'cae', target: 'core', label: 'CAE / CAI (solo Recibo Fiscal)', fieldType: 'text', colSpan: 4 },
        { key: 'caeDueDate', target: 'core', label: 'Vto. CAE / CAI', fieldType: 'date', colSpan: 4 },
      ],
    },
    {
      id: 'recibo_parties',
      title: '2. Cobrador y Cliente Pagador',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Emisor / Quien Cobra', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Emisor', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Cliente / Pagador', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL / DNI', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA', fieldType: 'select', colSpan: 6, options: TAX_CONDITIONS },
        { key: 'responsiblePerson', target: 'core', label: 'Recibido por / Cobrador', fieldType: 'text', colSpan: 6 },
      ],
    },
    {
      id: 'recibo_payment',
      title: '3. Medios de Cobro y Retenciones Sufridas',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Importe Total Cobrado', fieldType: 'currency', colSpan: 5, required: true },
        { key: 'retentionsAmount', target: 'custom', label: 'Retenciones Sufridas', fieldType: 'currency', colSpan: 4, aiAttrKeys: ['retenciones', 'monto_retenciones'] },
        { key: 'paymentMethod', target: 'core', label: 'Medio de Pago Principal', fieldType: 'text', colSpan: 4, placeholder: 'Transferencia / E-Cheq / Efectivo' },
        { key: 'bankOrPlatform', target: 'custom', label: 'Banco / Entidad / Billetera', fieldType: 'text', colSpan: 4, aiAttrKeys: ['banco', 'entidad_financiera'] },
        { key: 'referenceNumber', target: 'core', label: 'N° Operación / Cheque / Ref.', fieldType: 'text', colSpan: 4 },
      ],
    },
    {
      id: 'recibo_imputation',
      title: '4. Facturas y Comprobantes Imputados',
      icon: 'tabler:files',
      fields: [
        {
          key: 'appliedVouchers',
          target: 'custom',
          label: 'Comprobantes Imputados al Recibo',
          fieldType: 'vouchers_table',
          colSpan: 12,
          aiAttrKeys: ['comprobantes_imputados', 'facturas_canceladas'],
        },
        { key: 'summary', target: 'core', label: 'Concepto / Observaciones', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
