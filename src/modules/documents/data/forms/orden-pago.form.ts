import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const ORDEN_PAGO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'orden_pago',
  label: 'Orden de Pago (Tesorería / Proveedores)',
  description:
    'Comprobante de egreso y cancelación de múltiples facturas a proveedores con retenciones (Ganancias, IVA, IIBB, SUSS) y valores entregados.',
  icon: 'tabler:cash-banknote',
  displayOrder: 8,
  version: 1,
  matchAliases: ['orden_pago', 'orden_de_pago', 'op', 'liquidacion_pago'],
  aiExtractionGuide:
    'Orden de Pago emitida a un proveedor. Extraer N° OP, fecha emisión y pago efectivo, cuenta/caja origen, beneficiario + CUIT + CBU, retenciones practicadas (Ganancias, IVA, IIBB, SUSS), valores entregados (cheque/transferencia), importe neto pagado y arreglo "comprobantes_imputados" con las facturas canceladas.',
  sectionsSchema: [
    {
      id: 'op_header',
      title: '1. Datos de la Orden de Pago',
      icon: 'tabler:cash-banknote',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° Orden de Pago', fieldType: 'text', colSpan: 4, required: true, placeholder: 'Ej: OP-0001-00000452' },
        { key: 'documentDate', target: 'core', label: 'Fecha Emisión', fieldType: 'date', colSpan: 4, required: true },
        { key: 'dueDate', target: 'core', label: 'Fecha Pago Efectivo', fieldType: 'date', colSpan: 4 },
        { key: 'paymentOriginAccount', target: 'custom', label: 'Caja / Banco Origen', fieldType: 'text', colSpan: 5, placeholder: 'Ej: Banco Galicia Cta Cte / Caja Chica', aiAttrKeys: ['cuenta_origen', 'caja_banco'] },
        { key: 'responsiblePerson', target: 'core', label: 'Autorizado / Tesorería', fieldType: 'text', colSpan: 4 },
        { key: 'branch', target: 'core', label: 'Sucursal / Centro', fieldType: 'text', colSpan: 3 },
      ],
    },
    {
      id: 'op_parties',
      title: '2. Pagador y Proveedor Beneficiario',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Empresa Pagadora', fieldType: 'text', colSpan: 7 },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Pagadora', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Proveedor / Beneficiario', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT Proveedor', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA Proveedor', fieldType: 'select', colSpan: 6, options: TAX_CONDITIONS },
        { key: 'beneficiaryCbu', target: 'custom', label: 'CBU / Alias Destino', fieldType: 'text', colSpan: 6, aiAttrKeys: ['cbu_destino', 'cbu'] },
      ],
    },
    {
      id: 'op_retentions_values',
      title: '3. Retenciones Practicadas y Valores Entregados',
      icon: 'tabler:receipt-tax',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'netAmount', target: 'core', label: 'Subtotal Comprobantes', fieldType: 'currency', colSpan: 3 },
        { key: 'otherTaxesAmount', target: 'core', label: 'Total Retenciones Practicadas', fieldType: 'currency', colSpan: 3 },
        { key: 'totalAmount', target: 'core', label: 'Neto Abonado', fieldType: 'currency', colSpan: 3, required: true },
        { key: 'gananciasRetention', target: 'custom', label: 'Ret. Ganancias (RG 830)', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['retencion_ganancias', 'retenciones_ganancias'] },
        { key: 'ivaRetention', target: 'custom', label: 'Ret. IVA', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['retencion_iva', 'retenciones_iva'] },
        { key: 'iibbRetention', target: 'custom', label: 'Ret. IIBB (ARBA/AGIP/CM)', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['retencion_iibb', 'retenciones_iibb'] },
        { key: 'sussRetention', target: 'custom', label: 'Ret. SUSS', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['retencion_suss', 'retenciones_suss'] },
        { key: 'paymentMethod', target: 'core', label: 'Medio de Pago', fieldType: 'text', colSpan: 4, placeholder: 'Transferencia / E-Cheq / Cheque' },
        { key: 'bankOrPlatform', target: 'custom', label: 'Banco Pagador', fieldType: 'text', colSpan: 4, aiAttrKeys: ['banco'] },
        { key: 'referenceNumber', target: 'core', label: 'N° Cheque / E-Cheq / Op.', fieldType: 'text', colSpan: 4 },
      ],
    },
    {
      id: 'op_vouchers',
      title: '4. Comprobantes Imputados al Pago',
      icon: 'tabler:files',
      fields: [
        {
          key: 'appliedVouchers',
          target: 'custom',
          label: 'Facturas / ND / NC Canceladas',
          fieldType: 'vouchers_table',
          colSpan: 12,
          aiAttrKeys: ['comprobantes_imputados', 'facturas_canceladas'],
        },
        { key: 'summary', target: 'core', label: 'Resumen de Pago', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
