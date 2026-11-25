import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const RECIBO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'recibo',
  label: 'Recibo / Orden de Pago (Fiscal ARCA o Tesorería X)',
  description:
    'Soporta tanto Recibos Fiscales ARCA (A/B/C con CAE/CAI) como Recibos X de cobranza u Órdenes de Pago con valores y retenciones.',
  icon: 'tabler:receipt',
  displayOrder: 6,
  version: 1,
  matchAliases: ['recibo', 'recibo_x', 'recibo_c', 'orden_pago', 'orden_de_pago', 'comprobante_pago'],
  aiExtractionGuide:
    'Distinguir si es Recibo Fiscal ARCA (A/B/C con CAE/CAI) o Recibo X / Orden de Pago de tesorería. Extraer medio de pago, banco o billetera, N° transferencia/cheque, comprobantes cancelados/imputados, retenciones practicadas (Ganancias, IVA, IIBB, SUSS) e importe final.',
  sectionsSchema: [
    {
      id: 'recibo_header',
      title: '1. Tipo de Recibo y Numeración',
      icon: 'tabler:receipt',
      fields: [
        {
          key: 'receiptClass',
          target: 'custom',
          label: 'Naturaleza del Comprobante',
          fieldType: 'select',
          colSpan: 5,
          defaultValue: 'Recibo X (Cobranza / Interno)',
          options: [
            'Recibo X (Cobranza / Interno)',
            'Orden de Pago (Tesorería)',
            'Recibo Fiscal ARCA (Letra A/B/C)',
          ],
          aiAttrKeys: ['tipo_recibo', 'clase_recibo'],
        },
        { key: 'documentLetter', target: 'core', label: 'Letra', fieldType: 'select', colSpan: 2, options: ['X', 'A', 'B', 'C'] },
        { key: 'pointOfSale', target: 'core', label: 'Pto. Venta', fieldType: 'text', colSpan: 2, placeholder: '00001' },
        { key: 'documentNumber', target: 'core', label: 'N° Comprobante', fieldType: 'text', colSpan: 3, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha de Cobro / Pago', fieldType: 'date', colSpan: 4, required: true },
        { key: 'cae', target: 'core', label: 'CAE / CAI (solo si es Recibo Fiscal)', fieldType: 'text', colSpan: 4 },
        { key: 'caeDueDate', target: 'core', label: 'Vto. CAE / CAI', fieldType: 'date', colSpan: 4 },
      ],
    },
    {
      id: 'recibo_parties',
      title: '2. Partes Intervinientes',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Emisor / Cobrador', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Emisor', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Pagador / Beneficiario', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL / DNI', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA', fieldType: 'select', colSpan: 6, options: TAX_CONDITIONS },
        { key: 'responsiblePerson', target: 'core', label: 'Recibido / Emitido por', fieldType: 'text', colSpan: 6 },
      ],
    },
    {
      id: 'recibo_payment',
      title: '3. Medios de Pago, Retenciones e Imputación',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Importe Total Recibido / Abonado', fieldType: 'currency', colSpan: 5, required: true },
        { key: 'retentionsAmount', target: 'custom', label: 'Total Retenciones (IIBB/Gan/IVA/SUSS)', fieldType: 'currency', colSpan: 4, aiAttrKeys: ['retenciones', 'monto_retenciones'] },
        { key: 'paymentMethod', target: 'core', label: 'Medio de Pago Principal', fieldType: 'text', colSpan: 4, placeholder: 'Transferencia / Cheque / Efectivo' },
        { key: 'bankOrPlatform', target: 'custom', label: 'Banco / Entidad / Billetera', fieldType: 'text', colSpan: 4, aiAttrKeys: ['banco', 'entidad_financiera'] },
        { key: 'referenceNumber', target: 'core', label: 'N° Operación / Cheque / Referencia', fieldType: 'text', colSpan: 4 },
        {
          key: 'appliedInvoices',
          target: 'custom',
          label: 'Comprobantes Imputados / Cancelados',
          fieldType: 'textarea',
          colSpan: 12,
          placeholder: 'Ej: Factura A 0004-00001234 ($120.000), NC 0004-00000012',
          aiAttrKeys: ['comprobantes_imputados', 'facturas_canceladas'],
        },
        { key: 'summary', target: 'core', label: 'Concepto del Pago', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
