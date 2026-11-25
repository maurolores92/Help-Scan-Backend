import { DefaultDocumentFormSeed } from './form-shared.constants';

export const REMITO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'remito',
  label: 'Remito de Entrega / Traslado (ARCA R / X)',
  description:
    'Documento de respaldo de traslado y entrega de mercadería, con soporte para Remito R con CAI/COT y Remito X interno.',
  icon: 'tabler:truck-delivery',
  displayOrder: 3,
  version: 1,
  matchAliases: ['remito', 'remito_r', 'remito_x', 'guia_despacho', 'entrega'],
  aiExtractionGuide:
    'Identificar Letra (R fiscal con CAI o X interno), N° de Remito, CAI y Vto CAI si figura, código COT provincial, Orden de Compra asociada, transportista/expreso, CUIT del transportista, patente, cantidad de bultos, domicilio de entrega, quien recibe conforme y detalle de ítems.',
  sectionsSchema: [
    {
      id: 'remito_header',
      title: '1. Identificación Fiscal y Logística (ARCA)',
      icon: 'tabler:truck',
      fields: [
        { key: 'documentLetter', target: 'core', label: 'Letra Remito', fieldType: 'select', colSpan: 3, defaultValue: 'R', options: ['R', 'X', 'E'] },
        { key: 'pointOfSale', target: 'core', label: 'Punto de Venta', fieldType: 'text', colSpan: 3, placeholder: 'Ej: 00001' },
        { key: 'documentNumber', target: 'core', label: 'N° de Remito', fieldType: 'text', colSpan: 3, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha de Emisión / Traslado', fieldType: 'date', colSpan: 3, required: true },
        { key: 'cae', target: 'core', label: 'N° CAI (Talonario ARCA)', fieldType: 'text', colSpan: 4, placeholder: 'Código de Autorización de Impresión' },
        { key: 'caeDueDate', target: 'core', label: 'Fecha Vto. CAI', fieldType: 'date', colSpan: 4 },
        { key: 'cotCode', target: 'custom', label: 'COT (Código Operación Traslado)', fieldType: 'text', colSpan: 4, placeholder: 'ARBA / AGIP (si aplica)', aiAttrKeys: ['cot', 'codigo_cot'] },
      ],
    },
    {
      id: 'remito_parties',
      title: '2. Remitente, Destinatario y Transporte',
      icon: 'tabler:map-pin',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Remitente / Emisor', fieldType: 'text', colSpan: 7 },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Remitente', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Destinatario / Cliente', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL Destinatario', fieldType: 'cuit', colSpan: 5 },
        { key: 'deliveryAddress', target: 'core', label: 'Domicilio de Entrega / Destino', fieldType: 'text', colSpan: 8, required: true },
        { key: 'purchaseOrderNumber', target: 'core', label: 'Orden de Compra Asociada', fieldType: 'text', colSpan: 4 },
        { key: 'carrierName', target: 'core', label: 'Transportista / Expreso', fieldType: 'text', colSpan: 5 },
        { key: 'carrierTaxId', target: 'custom', label: 'CUIT Transportista', fieldType: 'cuit', colSpan: 4, aiAttrKeys: ['cuit_transporte', 'cuit_transportista'] },
        { key: 'vehiclePlate', target: 'custom', label: 'Dominio / Patente', fieldType: 'text', colSpan: 3, uppercase: true, aiAttrKeys: ['patente', 'dominio'] },
        { key: 'packagesCount', target: 'custom', label: 'Cantidad de Bultos', fieldType: 'number', colSpan: 3, aiAttrKeys: ['bultos', 'cantidad_bultos'] },
        { key: 'waybillNumber', target: 'custom', label: 'N° de Guía / Seguimiento', fieldType: 'text', colSpan: 3, aiAttrKeys: ['numero_guia', 'guia'] },
        { key: 'declaredValue', target: 'custom', label: 'Valor Declarado ($)', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['valor_declarado'] },
        { key: 'responsiblePerson', target: 'core', label: 'Recibió Conforme (Nombre / Firma)', fieldType: 'text', colSpan: 3 },
      ],
    },
    {
      id: 'remito_items',
      title: '3. Detalle de Mercadería Trasladada',
      icon: 'tabler:package',
      fields: [
        { key: 'items', target: 'core', label: 'Mercadería / Bultos', fieldType: 'items_table', colSpan: 12 },
        { key: 'summary', target: 'core', label: 'Resumen de Entrega', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Observaciones / Novedades', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
