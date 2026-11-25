import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const TRANSFERENCIA_PAGO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'transferencia_pago',
  label: 'Comprobante de Transferencia / Depósito',
  description:
    'Comprobantes bancarios, transferencias CBU/CVU, Mercado Pago o depósitos recibidos para imputar pagos.',
  icon: 'tabler:arrows-exchange',
  displayOrder: 11,
  version: 1,
  matchAliases: [
    'transferencia_pago',
    'transferencia',
    'comprobante_transferencia',
    'deposito',
    'deposito_bancario',
    'pago_electronico',
    'mercado_pago',
  ],
  aiExtractionGuide:
    'Comprobante bancario o billetera virtual (transferencia CBU/CVU, depósito o DEBIN). Extraer banco/billetera origen y destino, CBU/CVU/Alias origen y destino, N° operación o ID COELSA, originante + CUIT/CUIL, destinatario + CUIT, fecha, hora, concepto e importe transferido.',
  sectionsSchema: [
    {
      id: 'transf_header',
      title: '1. Datos de la Operación Bancaria / Digital',
      icon: 'tabler:arrows-exchange',
      fields: [
        {
          key: 'transferChannel',
          target: 'custom',
          label: 'Canal / Modalidad',
          fieldType: 'select',
          colSpan: 4,
          options: ['Transferencia Bancaria (CBU)', 'Billetera Virtual (CVU)', 'Depósito Bancario', 'DEBIN / Pago QR'],
          aiAttrKeys: ['modalidad_transferencia', 'canal_pago'],
        },
        { key: 'documentNumber', target: 'core', label: 'N° Operación / Referencia', fieldType: 'text', colSpan: 4, required: true },
        { key: 'coelsaId', target: 'custom', label: 'ID COELSA / Interbancario', fieldType: 'text', colSpan: 4, aiAttrKeys: ['coelsa_id', 'id_coelsa', 'id_operacion'] },
        { key: 'documentDate', target: 'core', label: 'Fecha Operación', fieldType: 'date', colSpan: 4, required: true },
        { key: 'operationTime', target: 'custom', label: 'Hora', fieldType: 'text', colSpan: 4, placeholder: 'HH:MM', aiAttrKeys: ['hora', 'hora_operacion'] },
        { key: 'referenceNumber', target: 'core', label: 'Factura / Ref. a Imputar', fieldType: 'text', colSpan: 4, placeholder: 'Opcional' },
      ],
    },
    {
      id: 'transf_parties',
      title: '2. Originante y Destinatario de los Fondos',
      icon: 'tabler:building-bank',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Originante / Remitente', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT / CUIL Originante', fieldType: 'cuit', colSpan: 5 },
        { key: 'originBank', target: 'custom', label: 'Banco / Billetera Origen', fieldType: 'text', colSpan: 6, aiAttrKeys: ['banco_origen', 'billetera_origen'] },
        { key: 'originCbuOrAlias', target: 'custom', label: 'CBU / CVU / Alias Origen', fieldType: 'text', colSpan: 6, aiAttrKeys: ['cbu_origen', 'cvu_origen', 'alias_origen'] },
        { key: 'recipientName', target: 'core', label: 'Destinatario / Beneficiario', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL Destinatario', fieldType: 'cuit', colSpan: 5 },
        { key: 'destBank', target: 'custom', label: 'Banco / Billetera Destino', fieldType: 'text', colSpan: 6, aiAttrKeys: ['banco_destino', 'billetera_destino'] },
        { key: 'destCbuOrAlias', target: 'custom', label: 'CBU / CVU / Alias Destino', fieldType: 'text', colSpan: 6, aiAttrKeys: ['cbu_destino', 'cvu_destino', 'alias_destino'] },
      ],
    },
    {
      id: 'transf_amount',
      title: '3. Importe y Concepto',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Importe Transferido', fieldType: 'currency', colSpan: 4, required: true },
        {
          key: 'transferConcept',
          target: 'custom',
          label: 'Concepto Bancario',
          fieldType: 'select',
          colSpan: 5,
          options: ['Varios', 'Factura', 'Alquileres', 'Honorarios', 'Haberes', 'Cuota', 'Préstamo', 'Otro'],
          aiAttrKeys: ['concepto_transferencia', 'concepto'],
        },
        { key: 'summary', target: 'core', label: 'Observaciones del Comprobante', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas de Conciliación', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
