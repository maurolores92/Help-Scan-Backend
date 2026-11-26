import {
  CURRENCY_OPTIONS,
  DefaultDocumentFormSeed,
  TAX_CONDITIONS,
} from './form-shared.constants';

export const ORDEN_COMPRA_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'orden_compra',
  label: 'Orden de Compra',
  description:
    'Autorización formal de compra enviada al proveedor con condiciones comerciales, fecha de entrega y condición IVA del comprador.',
  icon: 'tabler:shopping-cart',
  displayOrder: 4,
  version: 2,
  matchAliases: ['orden_compra', 'orden_de_compra', 'purchase_order', 'oc'],
  aiExtractionGuide:
    'Identificar N° de Orden de Compra, proveedor (issuer) y comprador (recipient con su Condición IVA para futura facturación), fecha de emisión, fecha esperada de entrega, lugar de entrega, solicitante, aprobador y artículos solicitados.',
  sectionsSchema: [
    {
      id: 'oc_header',
      title: '1. Datos de la Orden de Compra',
      icon: 'tabler:shopping-cart',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° de Orden de Compra', fieldType: 'text', colSpan: 4, required: true },
        { key: 'documentDate', target: 'core', label: 'Fecha de Emisión', fieldType: 'date', colSpan: 4, required: true },
        { key: 'dueDate', target: 'core', label: 'Fecha de Entrega Requerida', fieldType: 'date', colSpan: 4 },
        { key: 'department', target: 'core', label: 'Sector / Centro de Costos', fieldType: 'text', colSpan: 4 },
        { key: 'branch', target: 'core', label: 'Sucursal / Depósito Receptor', fieldType: 'text', colSpan: 4 },
        { key: 'approvedBy', target: 'custom', label: 'Autorizado / Aprobado por', fieldType: 'text', colSpan: 4, aiAttrKeys: ['aprobado_por', 'autorizado_por'] },
      ],
    },
    {
      id: 'oc_parties',
      title: '2. Proveedor y Comprador (Datos para Facturación)',
      icon: 'tabler:building-store',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Proveedor Destinatario OC', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Proveedor', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Empresa Compradora', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT Comprador', fieldType: 'cuit', colSpan: 5 },
        { key: 'taxCondition', target: 'core', label: 'Condición IVA Comprador', fieldType: 'select', colSpan: 4, options: TAX_CONDITIONS },
        { key: 'responsiblePerson', target: 'core', label: 'Solicitante / Contacto Compras', fieldType: 'text', colSpan: 4 },
        { key: 'recipientEmail', target: 'core', label: 'Email Notificación', fieldType: 'text', colSpan: 4 },
        { key: 'deliveryAddress', target: 'core', label: 'Dirección de Entrega Pactada', fieldType: 'text', colSpan: 12 },
      ],
    },
    {
      id: 'oc_financial',
      title: '3. Condiciones e Importes',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'grossSubtotal', target: 'custom', label: 'Subtotal Bruto', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['subtotal_bruto'] },
        { key: 'discountAmount', target: 'custom', label: 'Descuento ($)', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['descuento', 'bonificacion'] },
        { key: 'discountPercent', target: 'custom', label: '% Descuento', fieldType: 'number', colSpan: 3, aiAttrKeys: ['descuento_porcentaje', 'bonificacion_porcentaje'] },
        { key: 'netAmount', target: 'core', label: 'Subtotal Neto', fieldType: 'currency', colSpan: 4 },
        { key: 'taxAmount', target: 'core', label: 'IVA Estimado', fieldType: 'currency', colSpan: 4 },
        { key: 'totalAmount', target: 'core', label: 'Total Autorizado', fieldType: 'currency', colSpan: 4 },
        { key: 'paymentTerms', target: 'core', label: 'Condición de Pago Pactada', fieldType: 'text', colSpan: 6 },
        { key: 'paymentMethod', target: 'core', label: 'Medio de Pago', fieldType: 'text', colSpan: 6 },
      ],
    },
    {
      id: 'oc_items',
      title: '4. Artículos / Servicios Solicitados',
      icon: 'tabler:list-details',
      fields: [
        { key: 'items', target: 'core', label: 'Ítems de Compra', fieldType: 'items_table', colSpan: 12 },
        { key: 'summary', target: 'core', label: 'Resumen / Condiciones', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
