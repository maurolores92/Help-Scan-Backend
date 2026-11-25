import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const NOTA_PEDIDO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'nota_pedido',
  label: 'Nota de Pedido',
  description:
    'Pedido comercial de cliente con prioridad, vendedor asignado, domicilio de entrega y detalle de productos.',
  icon: 'tabler:clipboard-list',
  displayOrder: 5,
  version: 1,
  matchAliases: ['nota_pedido', 'nota_de_pedido', 'pedido', 'solicitud_pedido'],
  aiExtractionGuide:
    'Extraer N° de Nota de Pedido, fecha, fecha de entrega deseada, cliente y su CUIT/CUIL, domicilio y localidad de entrega, vendedor/responsable, canal/prioridad y detalle de artículos pedidos.',
  sectionsSchema: [
    {
      id: 'np_header',
      title: '1. Datos del Pedido Comercial',
      icon: 'tabler:clipboard-check',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° Nota de Pedido', fieldType: 'text', colSpan: 4, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha del Pedido', fieldType: 'date', colSpan: 4, required: true },
        { key: 'dueDate', target: 'core', label: 'Entrega Deseada', fieldType: 'date', colSpan: 4 },
        {
          key: 'orderChannel',
          target: 'custom',
          label: 'Canal de Ingreso',
          fieldType: 'select',
          colSpan: 4,
          options: ['Mostrador / Presencial', 'WhatsApp', 'Email', 'Web / E-Commerce', 'Vendedor / Campo'],
          aiAttrKeys: ['canal_pedido', 'canal'],
        },
        {
          key: 'priority',
          target: 'custom',
          label: 'Prioridad',
          fieldType: 'select',
          colSpan: 4,
          defaultValue: 'Normal',
          options: ['Baja', 'Normal', 'Alta', 'Urgente'],
          aiAttrKeys: ['prioridad'],
        },
        { key: 'branch', target: 'core', label: 'Depósito / Sucursal Despacho', fieldType: 'text', colSpan: 4 },
      ],
    },
    {
      id: 'np_parties',
      title: '2. Cliente y Vendedor',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Empresa Emisora', fieldType: 'text', colSpan: 6 },
        { key: 'responsiblePerson', target: 'core', label: 'Vendedor / Responsable', fieldType: 'text', colSpan: 6 },
        { key: 'recipientName', target: 'core', label: 'Cliente', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL Cliente', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA Cliente', fieldType: 'select', colSpan: 4, options: TAX_CONDITIONS },
        { key: 'recipientPhone', target: 'core', label: 'Teléfono', fieldType: 'text', colSpan: 4 },
        { key: 'recipientEmail', target: 'core', label: 'Email', fieldType: 'text', colSpan: 4 },
        { key: 'deliveryAddress', target: 'core', label: 'Domicilio de Entrega', fieldType: 'text', colSpan: 12 },
      ],
    },
    {
      id: 'np_amounts_items',
      title: '3. Condiciones, Ítems e Importe',
      icon: 'tabler:list-details',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Importe Estimado', fieldType: 'currency', colSpan: 4 },
        { key: 'paymentTerms', target: 'core', label: 'Condición de Venta', fieldType: 'text', colSpan: 5 },
        { key: 'items', target: 'core', label: 'Artículos Solicitados', fieldType: 'items_table', colSpan: 12 },
        { key: 'summary', target: 'core', label: 'Observaciones de Armado', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
