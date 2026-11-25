import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const CERTIFICADO_RETENCION_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'certificado_retencion',
  label: 'Certificado de Retención (ARCA / ARBA / AGIP)',
  description:
    'Constancia impositiva de retención practicada o sufrida (Ganancias, IVA, SUSS, Ingresos Brutos ARBA/AGIP/SIFERE).',
  icon: 'tabler:certificate',
  displayOrder: 9,
  version: 1,
  matchAliases: [
    'certificado_retencion',
    'certificado_de_retencion',
    'constancia_retencion',
    'retencion',
    'sire',
    'sicore',
  ],
  aiExtractionGuide:
    'Extraer N° de Certificado de Retención, fecha de retención, período, impuesto retenido (Ganancias RG 830, IVA, SUSS, IIBB ARBA/AGIP), código de régimen, sistema (SIRE/SICORE/ARBA/AGIP), agente de retención + CUIT, sujeto retenido + CUIT + IIBB, comprobante/OP de origen, base imponible, alícuota (%) e importe retenido.',
  sectionsSchema: [
    {
      id: 'ret_header',
      title: '1. Datos del Certificado Impositivo',
      icon: 'tabler:certificate',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° Certificado Retención', fieldType: 'text', colSpan: 5, required: true, placeholder: 'Ej: 20260000123456' },
        { key: 'documentDate', target: 'core', label: 'Fecha de Retención', fieldType: 'date', colSpan: 4, required: true },
        { key: 'period', target: 'core', label: 'Período / Quincena', fieldType: 'text', colSpan: 3, placeholder: 'MM/AAAA' },
        {
          key: 'taxType',
          target: 'custom',
          label: 'Impuesto / Tributo',
          fieldType: 'select',
          colSpan: 4,
          options: [
            'Ganancias (RG 830)',
            'IVA',
            'SUSS (Seguridad Social)',
            'IIBB ARBA',
            'IIBB AGIP / CABA',
            'IIBB Convenio Multilateral / SIFERE',
            'Tasa Municipal / Otro',
          ],
          aiAttrKeys: ['impuesto_retenido', 'impuesto', 'tributo'],
        },
        { key: 'regimeCode', target: 'custom', label: 'Código Régimen / Norma', fieldType: 'text', colSpan: 4, placeholder: 'Ej: Rég. 94 - Locaciones', aiAttrKeys: ['codigo_regimen', 'regimen'] },
        {
          key: 'certificateSystem',
          target: 'custom',
          label: 'Sistema Emisor',
          fieldType: 'select',
          colSpan: 4,
          options: ['SIRE (ARCA)', 'SICORE (ARCA)', 'ARBA Web', 'AGIP / e-ARCIBA', 'Manual / ERP'],
          aiAttrKeys: ['sistema_emisor'],
        },
      ],
    },
    {
      id: 'ret_parties',
      title: '2. Agente de Retención y Sujeto Retenido',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Agente de Retención', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Agente Retención', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Sujeto Retenido', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT Sujeto Retenido', fieldType: 'cuit', colSpan: 5 },
        { key: 'retainedIibbNumber', target: 'custom', label: 'N° IIBB Sujeto Retenido', fieldType: 'text', colSpan: 6, aiAttrKeys: ['iibb_retenido', 'nro_iibb'] },
        { key: 'referenceNumber', target: 'core', label: 'Comprobante / OP de Origen', fieldType: 'text', colSpan: 6, placeholder: 'Factura / Orden de Pago asociada' },
      ],
    },
    {
      id: 'ret_amounts',
      title: '3. Base Imponible, Alícuota e Importe Retenido',
      icon: 'tabler:calculator',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'taxableBase', target: 'custom', label: 'Base Imponible Sujeta a Retención', fieldType: 'currency', colSpan: 4, aiAttrKeys: ['base_imponible', 'monto_sujeto_retencion'] },
        { key: 'aliquotPct', target: 'custom', label: 'Alícuota (%)', fieldType: 'number', colSpan: 2, placeholder: 'Ej: 2.5', aiAttrKeys: ['alicuota', 'porcentaje_retencion'] },
        { key: 'totalAmount', target: 'core', label: 'Importe Retenido', fieldType: 'currency', colSpan: 3, required: true },
        { key: 'summary', target: 'core', label: 'Concepto / Detalle', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
