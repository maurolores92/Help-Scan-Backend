import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const DOCUMENTO_GENERAL_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'documento_general',
  label: 'Documento General / Administrativo',
  description:
    'Plantilla flexible de respaldo para cualquier comprobante, nota, expediente o trámite administrativo.',
  icon: 'tabler:file',
  displayOrder: 10,
  version: 1,
  matchAliases: ['documento_general', 'otro', 'general', 'nota', 'constancia', 'certificado'],
  aiExtractionGuide:
    'Extraer tipo descriptivo sugerido, número o código de referencia, fecha, partes involucradas (emisor y receptor con CUIT si figuran), resumen ejecutivo e importe opcional.',
  sectionsSchema: [
    {
      id: 'gen_header',
      title: '1. Datos Generales',
      icon: 'tabler:file-info',
      fields: [
        { key: 'customCategory', target: 'custom', label: 'Subtipo / Clasificación', fieldType: 'text', colSpan: 4, placeholder: 'Ej: Constancia ARCA, Nota, Póliza', aiAttrKeys: ['categoria', 'subtipo'] },
        { key: 'documentNumber', target: 'core', label: 'N° de Referencia / Expediente', fieldType: 'text', colSpan: 4 },
        { key: 'documentDate', target: 'core', label: 'Fecha Principal', fieldType: 'date', colSpan: 4 },
        { key: 'dueDate', target: 'core', label: 'Fecha Vencimiento (si aplica)', fieldType: 'date', colSpan: 4 },
        { key: 'department', target: 'core', label: 'Sector / Área', fieldType: 'text', colSpan: 4 },
        { key: 'responsiblePerson', target: 'core', label: 'Responsable / Contacto', fieldType: 'text', colSpan: 4 },
      ],
    },
    {
      id: 'gen_parties_amounts',
      title: '2. Partes Involucradas e Importe (Opcional)',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Emisor / Origen', fieldType: 'text', colSpan: 7 },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Emisor', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Destinatario / Involucrado', fieldType: 'text', colSpan: 7 },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL / DNI', fieldType: 'cuit', colSpan: 5 },
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Importe (si aplica)', fieldType: 'currency', colSpan: 4 },
        { key: 'referenceNumber', target: 'core', label: 'Trámite / Ref. Relacionada', fieldType: 'text', colSpan: 5 },
      ],
    },
    {
      id: 'gen_content',
      title: '3. Resumen, Ítems Opcionales y Notas',
      icon: 'tabler:notes',
      fields: [
        { key: 'items', target: 'core', label: 'Ítems (si aplica)', fieldType: 'items_table', colSpan: 12 },
        { key: 'summary', target: 'core', label: 'Resumen Ejecutivo', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Notas Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
