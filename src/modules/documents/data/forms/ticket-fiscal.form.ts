import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const TICKET_FISCAL_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'ticket_fiscal',
  label: 'Ticket / Tique Factura (Controlador Fiscal)',
  description:
    'Tickets fiscales y tiques factura A/B/C emitidos por controlador fiscal (combustibles, peajes, compras menores y gastos).',
  icon: 'tabler:ticket',
  displayOrder: 10,
  version: 1,
  matchAliases: [
    'ticket_fiscal',
    'ticket',
    'tique',
    'tique_factura',
    'ticket_a',
    'ticket_b',
    'ticket_c',
  ],
  aiExtractionGuide:
    'Ticket o Tique Factura de controlador fiscal ARCA (Cód. 081/082/083/111). Extraer letra (A/B/C/T), punto de venta, N° ticket, hora, N° serie controlador fiscal, comercio emisor + CUIT, receptor si figura, categoría de gasto (Combustible, Peaje, Viáticos, Insumos), impuestos internos/ITC, IVA y total.',
  sectionsSchema: [
    {
      id: 'ticket_header',
      title: '1. Datos del Controlador Fiscal (ARCA)',
      icon: 'tabler:ticket',
      fields: [
        {
          key: 'ticketSubtype',
          target: 'custom',
          label: 'Tipo de Ticket',
          fieldType: 'select',
          colSpan: 4,
          options: ['Tique Factura A', 'Tique Factura B', 'Tique Factura C', 'Tique Consumidor Final'],
          aiAttrKeys: ['tipo_ticket', 'subtipo_fiscal'],
        },
        { key: 'documentLetter', target: 'core', label: 'Letra', fieldType: 'select', colSpan: 2, options: ['A', 'B', 'C', 'T'] },
        { key: 'afipVoucherCode', target: 'custom', label: 'Código ARCA', fieldType: 'text', colSpan: 2, placeholder: '081/082/083', aiAttrKeys: ['codigo_arca', 'codigo_afip'] },
        { key: 'pointOfSale', target: 'core', label: 'Pto. Venta', fieldType: 'text', colSpan: 2, placeholder: '00001' },
        { key: 'documentNumber', target: 'core', label: 'N° Ticket', fieldType: 'text', colSpan: 2, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha', fieldType: 'date', colSpan: 4, required: true },
        { key: 'issueTime', target: 'custom', label: 'Hora Emisión', fieldType: 'text', colSpan: 3, placeholder: 'HH:MM', aiAttrKeys: ['hora', 'hora_emision'] },
        { key: 'fiscalPrinterSerial', target: 'custom', label: 'N° Serie Controlador Fiscal', fieldType: 'text', colSpan: 5, aiAttrKeys: ['serie_controlador', 'controlador_fiscal'] },
      ],
    },
    {
      id: 'ticket_parties',
      title: '2. Comercio Emisor y Receptor',
      icon: 'tabler:building-store',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Comercio / Emisor', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Comercio', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Cliente / Receptor', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / DNI Receptor', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA', fieldType: 'select', colSpan: 6, options: TAX_CONDITIONS },
        {
          key: 'expenseCategory',
          target: 'custom',
          label: 'Rubro / Categoría de Gasto',
          fieldType: 'select',
          colSpan: 6,
          options: ['Combustible / GNC', 'Peajes / Estacionamiento', 'Viáticos / Gastronomía', 'Librería / Insumos', 'Transporte', 'Otro'],
          aiAttrKeys: ['categoria_gasto', 'rubro'],
        },
      ],
    },
    {
      id: 'ticket_amounts',
      title: '3. Importes, Impuestos Internos e Ítems',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 2, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'netAmount', target: 'core', label: 'Neto Gravado', fieldType: 'currency', colSpan: 2 },
        { key: 'taxAmount', target: 'core', label: 'IVA', fieldType: 'currency', colSpan: 2 },
        { key: 'internalTaxesOrFuel', target: 'custom', label: 'Imp. Internos / ITC', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['impuestos_internos', 'itc'] },
        { key: 'totalAmount', target: 'core', label: 'Importe Total', fieldType: 'currency', colSpan: 3, required: true },
        { key: 'paymentMethod', target: 'core', label: 'Medio de Pago', fieldType: 'text', colSpan: 6 },
        { key: 'department', target: 'core', label: 'Sector / Centro de Costos', fieldType: 'text', colSpan: 6 },
        { key: 'items', target: 'core', label: 'Detalle del Ticket', fieldType: 'items_table', colSpan: 12 },
      ],
    },
  ],
};
