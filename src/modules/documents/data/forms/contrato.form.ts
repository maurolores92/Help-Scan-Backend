import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const CONTRATO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'contrato',
  label: 'Contrato / Acuerdo Comercial',
  description:
    'Contratos de servicios, locación, mantenimiento, suministro o acuerdos marco con seguimiento de vigencia y renovación.',
  icon: 'tabler:file-text',
  displayOrder: 8,
  version: 1,
  matchAliases: ['contrato', 'acuerdo', 'convenio', 'anexo_contrato'],
  aiExtractionGuide:
    'Extraer categoría de contrato (Servicios, Locación, Suministro, Mantenimiento, NDA), partes firmantes y CUIT/DNI, fecha de firma, vigencia desde/hasta, renovación automática, plazo de preaviso, periodicidad y monto periódico o total.',
  sectionsSchema: [
    {
      id: 'contrato_header',
      title: '1. Identificación y Vigencia',
      icon: 'tabler:calendar-event',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° / Código Contrato', fieldType: 'text', colSpan: 4 },
        {
          key: 'contractCategory',
          target: 'custom',
          label: 'Categoría',
          fieldType: 'select',
          colSpan: 4,
          options: ['Servicios', 'Locación / Alquiler', 'Suministro', 'Mantenimiento', 'Confidencialidad (NDA)', 'Laboral', 'Otro'],
          aiAttrKeys: ['tipo_contrato', 'categoria_contrato'],
        },
        { key: 'documentDate', target: 'core', label: 'Fecha de Firma', fieldType: 'date', colSpan: 4, required: true },
        { key: 'startDate', target: 'custom', label: 'Inicio de Vigencia', fieldType: 'date', colSpan: 4, aiAttrKeys: ['fecha_inicio'] },
        { key: 'dueDate', target: 'core', label: 'Fin de Vigencia / Vencimiento', fieldType: 'date', colSpan: 4 },
        { key: 'autoRenewal', target: 'custom', label: 'Renovación Automática', fieldType: 'switch', colSpan: 4, aiAttrKeys: ['renovacion_automatica'] },
        { key: 'noticePeriodDays', target: 'custom', label: 'Preaviso Rescisión (días)', fieldType: 'number', colSpan: 4, aiAttrKeys: ['dias_preaviso'] },
        { key: 'adjustmentIndex', target: 'custom', label: 'Índice de Ajuste', fieldType: 'text', colSpan: 8, placeholder: 'Ej: IPC, ICL, trimestral, fijo', aiAttrKeys: ['indice_ajuste'] },
      ],
    },
    {
      id: 'contrato_parties',
      title: '2. Partes Firmantes y Condiciones Económicas',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Parte A (Locador / Prestador)', fieldType: 'text', colSpan: 7, required: true },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT / DNI Parte A', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Parte B (Locatario / Cliente)', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / DNI Parte B', fieldType: 'cuit', colSpan: 5 },
        { key: 'responsiblePerson', target: 'core', label: 'Firmante / Responsable Interno', fieldType: 'text', colSpan: 4 },
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 2, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'totalAmount', target: 'core', label: 'Monto / Abono', fieldType: 'currency', colSpan: 3 },
        { key: 'period', target: 'core', label: 'Periodicidad', fieldType: 'text', colSpan: 3, placeholder: 'Mensual / Anual / Único' },
      ],
    },
    {
      id: 'contrato_notes',
      title: '3. Objeto y Cláusulas Relevantes',
      icon: 'tabler:notes',
      fields: [
        { key: 'summary', target: 'core', label: 'Objeto del Contrato', fieldType: 'textarea', colSpan: 6, required: true },
        { key: 'keyObligations', target: 'custom', label: 'Cláusulas / Obligaciones Clave', fieldType: 'textarea', colSpan: 6, aiAttrKeys: ['clausulas_clave'] },
        { key: 'validationNotes', target: 'core', label: 'Observaciones Internas', fieldType: 'textarea', colSpan: 12 },
      ],
    },
  ],
};
