import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const ORDEN_SERVICIO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'orden_servicio',
  label: 'Orden de Servicio / Parte Técnico',
  description:
    'Formulario multipropósito para servicios técnicos, mantenimiento, reparaciones o instalaciones de cualquier tipo de bien o activo.',
  icon: 'tabler:tool',
  displayOrder: 7,
  version: 1,
  matchAliases: [
    'orden_servicio',
    'orden_de_servicio',
    'servicio_tecnico',
    'parte_tecnico',
    'informe_tecnico',
    'mantenimiento',
  ],
  aiExtractionGuide:
    'Formulario general de servicio técnico o mantenimiento. Extraer cliente solicitante, técnico/responsable, tipo de bien o activo intervenido, serie/patente/identificador, marca/modelo, medición de uso (si figura), falla o motivo reportado, trabajo realizado, repuestos/mano de obra y costos.',
  sectionsSchema: [
    {
      id: 'os_header',
      title: '1. Datos de la Orden de Trabajo',
      icon: 'tabler:clipboard-list',
      fields: [
        { key: 'documentNumber', target: 'core', label: 'N° de Orden / Parte', fieldType: 'text', colSpan: 4 },
        { key: 'documentDate', target: 'core', label: 'Fecha de Ingreso / Servicio', fieldType: 'date', colSpan: 4, required: true },
        { key: 'dueDate', target: 'core', label: 'Fecha Entrega / Cierre', fieldType: 'date', colSpan: 4 },
        {
          key: 'serviceStatus',
          target: 'custom',
          label: 'Estado del Trabajo',
          fieldType: 'select',
          colSpan: 4,
          options: ['Finalizado / Entregado', 'En Diagnóstico', 'Pendiente de Repuesto', 'En Garantía', 'Presupuestado'],
          aiAttrKeys: ['estado_servicio'],
        },
        { key: 'responsiblePerson', target: 'core', label: 'Técnico / Responsable', fieldType: 'text', colSpan: 4 },
        { key: 'warrantyNote', target: 'custom', label: 'Garantía Aplicable', fieldType: 'text', colSpan: 4, placeholder: 'Ej: 90 días sobre mano de obra', aiAttrKeys: ['garantia'] },
      ],
    },
    {
      id: 'os_parties',
      title: '2. Prestador y Cliente Solicitante',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Prestador / Taller', fieldType: 'text', colSpan: 7 },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Prestador', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Cliente', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL / DNI Cliente', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientPhone', target: 'core', label: 'Teléfono / Contacto', fieldType: 'text', colSpan: 4 },
        { key: 'recipientEmail', target: 'core', label: 'Email', fieldType: 'text', colSpan: 4 },
        { key: 'deliveryAddress', target: 'core', label: 'Domicilio / Ubicación del Servicio', fieldType: 'text', colSpan: 4 },
      ],
    },
    {
      id: 'os_asset',
      title: '3. Bien / Activo Intervenido y Diagnóstico',
      icon: 'tabler:settings',
      fields: [
        { key: 'assetType', target: 'custom', label: 'Tipo de Bien / Activo', fieldType: 'text', colSpan: 3, placeholder: 'Equipo, Vehículo, Instalación, Sistema...', aiAttrKeys: ['tipo_equipo', 'tipo_activo'] },
        { key: 'assetModel', target: 'custom', label: 'Marca / Modelo', fieldType: 'text', colSpan: 4, aiAttrKeys: ['equipmentModel', 'equipo_modelo', 'modelo'] },
        { key: 'assetIdentifier', target: 'custom', label: 'N° Serie / ID / Patente', fieldType: 'text', colSpan: 3, aiAttrKeys: ['equipmentId', 'numero_serie', 'patente', 'serie'] },
        { key: 'usageMetric', target: 'custom', label: 'Lectura / Contador / Km', fieldType: 'text', colSpan: 2, placeholder: 'Opcional', aiAttrKeys: ['meterCount', 'contador', 'kilometraje'] },
        { key: 'reportedIssue', target: 'custom', label: 'Motivo / Falla Reportada', fieldType: 'textarea', colSpan: 6, aiAttrKeys: ['falla_reportada', 'motivo_ingreso'] },
        { key: 'workPerformed', target: 'custom', label: 'Diagnóstico y Trabajo Realizado', fieldType: 'textarea', colSpan: 6, aiAttrKeys: ['trabajo_realizado', 'diagnostico'] },
      ],
    },
    {
      id: 'os_items_amounts',
      title: '4. Repuestos, Mano de Obra e Importes',
      icon: 'tabler:list-details',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'netAmount', target: 'core', label: 'Subtotal Neto', fieldType: 'currency', colSpan: 3 },
        { key: 'taxAmount', target: 'core', label: 'IVA', fieldType: 'currency', colSpan: 3 },
        { key: 'totalAmount', target: 'core', label: 'Importe Total', fieldType: 'currency', colSpan: 3 },
        { key: 'items', target: 'core', label: 'Repuestos y Tareas', fieldType: 'items_table', colSpan: 12 },
        { key: 'validationNotes', target: 'core', label: 'Notas de Validación', fieldType: 'textarea', colSpan: 12 },
      ],
    },
  ],
};
