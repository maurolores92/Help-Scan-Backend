import {
  buildArcaAmountsSection,
  buildArcaPartiesSection,
  DefaultDocumentFormSeed,
} from './form-shared.constants';

export const FACTURA_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'factura',
  label: 'Factura / FCE MiPyME (ARCA)',
  description:
    'Esquema fiscal unificado ARCA para Factura A/B/C/M/E y Factura de Crédito Electrónica (FCE MiPyME).',
  icon: 'tabler:file-invoice',
  displayOrder: 1,
  version: 3,
  matchAliases: [
    'factura',
    'factura_a',
    'factura_b',
    'factura_c',
    'factura_m',
    'factura_e',
    'fce',
    'invoice',
    'comprobante_fiscal',
  ],
  aiExtractionGuide:
    'Extraer campos fiscales ARCA de Factura: letra (A/B/C/M/E), afipVoucherCode (001,006,011,051,201,206,211), punto de venta (5 dígitos), autorización CAE/CAEA/CAI y vencimiento, concepto ARCA (Productos/Servicios/Productos y Servicios), período desde/hasta, IIBB e Inicio de Actividades del emisor, condición IVA de emisor y receptor, cotización si moneda es USD/EUR, alícuotas IVA (21%, 10.5%, 27%), exento y percepciones.',
  sectionsSchema: [
    {
      id: 'arca_header',
      title: '1. Comprobante Fiscal ARCA (ex AFIP)',
      icon: 'tabler:file-certificate',
      fields: [
        {
          key: 'fiscalSubtype',
          target: 'custom',
          label: 'Clase Fiscal',
          fieldType: 'select',
          colSpan: 4,
          defaultValue: 'Factura',
          options: ['Factura', 'Factura de Crédito Electrónica (FCE)'],
          aiAttrKeys: ['subtipo_fiscal', 'clase_comprobante'],
        },
        { key: 'documentLetter', target: 'core', label: 'Letra', fieldType: 'select', colSpan: 4, options: ['A', 'B', 'C', 'M', 'E'] },
        { key: 'afipVoucherCode', target: 'custom', label: 'Código ARCA', fieldType: 'text', colSpan: 4, placeholder: 'Ej: 001, 006, 011, 051, 201', aiAttrKeys: ['codigo_arca', 'codigo_afip', 'codigo_comprobante'] },
        { key: 'pointOfSale', target: 'core', label: 'Punto de Venta', fieldType: 'text', colSpan: 4, placeholder: 'Ej: 00004' },
        { key: 'documentNumber', target: 'core', label: 'N° de Comprobante', fieldType: 'text', colSpan: 4, required: true, placeholder: 'Ej: 00004-00041980' },
        { key: 'documentDate', target: 'core', label: 'Fecha de Emisión', fieldType: 'date', colSpan: 4, required: true },
        { key: 'authorizationType', target: 'custom', label: 'Tipo Autorización', fieldType: 'select', colSpan: 3, defaultValue: 'CAE', options: ['CAE', 'CAEA', 'CAI'], aiAttrKeys: ['tipo_autorizacion'] },
        { key: 'cae', target: 'core', label: 'N° CAE / CAI', fieldType: 'text', colSpan: 5, placeholder: '14 dígitos numéricos' },
        { key: 'caeDueDate', target: 'core', label: 'Vto. CAE / CAI', fieldType: 'date', colSpan: 4 },
        { key: 'concept', target: 'custom', label: 'Concepto ARCA', fieldType: 'select', colSpan: 4, options: ['Productos', 'Servicios', 'Productos y Servicios'], aiAttrKeys: ['concepto_arca', 'concepto'] },
        { key: 'servicePeriodFrom', target: 'custom', label: 'Período Servicio Desde', fieldType: 'date', colSpan: 4, aiAttrKeys: ['periodo_desde', 'fecha_desde_servicio'] },
        { key: 'servicePeriodTo', target: 'custom', label: 'Período Servicio Hasta', fieldType: 'date', colSpan: 4, aiAttrKeys: ['periodo_hasta', 'fecha_hasta_servicio'] },
        { key: 'dueDate', target: 'core', label: 'Vencimiento de Pago', fieldType: 'date', colSpan: 6 },
        { key: 'purchaseOrderNumber', target: 'core', label: 'N° Orden de Compra / Remito', fieldType: 'text', colSpan: 6, placeholder: 'Opcional' },
      ],
    },
    buildArcaPartiesSection(),
    buildArcaAmountsSection('Importe Total Facturado'),
    {
      id: 'items_and_notes',
      title: '4. Detalle de Artículos y Observaciones',
      icon: 'tabler:list-details',
      fields: [
        { key: 'items', target: 'core', label: 'Artículos', fieldType: 'items_table', colSpan: 12 },
        { key: 'summary', target: 'core', label: 'Resumen Ejecutivo', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas de Validación', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
