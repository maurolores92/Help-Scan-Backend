import { CURRENCY_OPTIONS, DefaultDocumentFormSeed } from './form-shared.constants';

export const LEGAJO_FORM_SEED: DefaultDocumentFormSeed = {
  code: 'legajo',
  label: 'Legajo / RRHH / Haberes (Argentina)',
  description: 'Recibos de sueldo, altas tempranas ARCA, certificados laborales y documentación de personal.',
  icon: 'tabler:id-badge-2',
  displayOrder: 9,
  version: 1,
  matchAliases: ['legajo', 'recibo_haberes', 'recibo_sueldo', 'alta_temprana', 'rrhh', 'curriculum'],
  aiExtractionGuide:
    'Extraer subtipo laboral (Recibo de Haberes, Alta Temprana ARCA, Certificado, Contrato), empleador + CUIT, empleado + CUIL, puesto/categoría, período liquidado, fecha de ingreso, haberes brutos, retenciones/aportes, neto a cobrar y Obra Social/ART.',
  sectionsSchema: [
    {
      id: 'rrhh_header',
      title: '1. Documentación Laboral / RRHH',
      icon: 'tabler:id',
      fields: [
        {
          key: 'hrSubType',
          target: 'custom',
          label: 'Subtipo RRHH',
          fieldType: 'select',
          colSpan: 5,
          options: ['Recibo de Haberes', 'Alta Temprana ARCA', 'Contrato Laboral', 'Certificado Médico / Licencia', 'Documentación Personal', 'Otro'],
          aiAttrKeys: ['subtipo_rrhh', 'tipo_legajo'],
        },
        { key: 'documentNumber', target: 'core', label: 'N° Legajo / Recibo', fieldType: 'text', colSpan: 3 },
        { key: 'period', target: 'core', label: 'Período Liquidado', fieldType: 'text', colSpan: 2, placeholder: 'MM/AAAA' },
        { key: 'documentDate', target: 'core', label: 'Fecha Documento', fieldType: 'date', colSpan: 2, required: true },
      ],
    },
    {
      id: 'rrhh_parties',
      title: '2. Empleador y Empleado',
      icon: 'tabler:users',
      fields: [
        { key: 'issuerName', target: 'core', label: 'Empleador / Razón Social', fieldType: 'text', colSpan: 7 },
        { key: 'issuerTaxId', target: 'core', label: 'CUIT Empleador', fieldType: 'cuit', colSpan: 5 },
        { key: 'recipientName', target: 'core', label: 'Empleado / Apellido y Nombre', fieldType: 'text', colSpan: 7, required: true },
        { key: 'recipientTaxId', target: 'core', label: 'CUIL / DNI Empleado', fieldType: 'cuit', colSpan: 5, required: true },
        { key: 'jobTitle', target: 'custom', label: 'Puesto / Categoría CCT', fieldType: 'text', colSpan: 4, aiAttrKeys: ['puesto', 'categoria'] },
        { key: 'department', target: 'core', label: 'Área / Sector', fieldType: 'text', colSpan: 4 },
        { key: 'hireDate', target: 'custom', label: 'Fecha de Ingreso', fieldType: 'date', colSpan: 4, aiAttrKeys: ['fecha_ingreso'] },
        { key: 'socialSecurityOrArt', target: 'custom', label: 'Obra Social / ART', fieldType: 'text', colSpan: 6, aiAttrKeys: ['obra_social', 'art'] },
        { key: 'bankAccount', target: 'custom', label: 'Banco / CBU Acreditación', fieldType: 'text', colSpan: 6, aiAttrKeys: ['cbu', 'banco_acreditacion'] },
      ],
    },
    {
      id: 'rrhh_amounts',
      title: '3. Liquidación / Conceptos',
      icon: 'tabler:cash',
      fields: [
        { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
        { key: 'grossPay', target: 'custom', label: 'Total Haberes Brutos', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['haberes_brutos', 'sueldo_bruto'] },
        { key: 'deductionsAmount', target: 'custom', label: 'Total Deducciones / Aportes', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['deducciones', 'retenciones'] },
        { key: 'totalAmount', target: 'core', label: 'Neto a Percibir', fieldType: 'currency', colSpan: 3 },
        { key: 'summary', target: 'core', label: 'Resumen / Detalle', fieldType: 'textarea', colSpan: 6 },
        { key: 'validationNotes', target: 'core', label: 'Observaciones Internas', fieldType: 'textarea', colSpan: 6 },
      ],
    },
  ],
};
