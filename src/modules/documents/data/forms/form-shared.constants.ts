import { DocumentFormSectionSchema } from '../../models/document-type-form.model';

export interface DefaultDocumentFormSeed {
  code: string;
  label: string;
  description: string;
  icon: string;
  displayOrder: number;
  version: number;
  matchAliases: string[];
  aiExtractionGuide: string;
  sectionsSchema: DocumentFormSectionSchema[];
}

export const TAX_CONDITIONS = [
  'Responsable Inscripto',
  'Monotributo',
  'Exento',
  'Consumidor Final',
  'No Responsable',
  'Sujeto No Categorizado',
];

export const CURRENCY_OPTIONS = [
  { value: 'ARS', label: 'ARS ($)' },
  { value: 'USD', label: 'USD (u$s)' },
  { value: 'EUR', label: 'EUR (€)' },
];

/**
 * Sección compartida de Emisor y Cliente para comprobantes fiscales ARCA (Factura, NC, ND).
 */
export function buildArcaPartiesSection(sectionTitle = '2. Datos Fiscales del Emisor y Cliente'): DocumentFormSectionSchema {
  return {
    id: 'parties_fiscal',
    title: sectionTitle,
    icon: 'tabler:users',
    fields: [
      { key: 'issuerName', target: 'core', label: 'Razón Social Emisor', fieldType: 'text', colSpan: 7, required: true },
      { key: 'issuerTaxId', target: 'core', label: 'CUIT Emisor', fieldType: 'cuit', colSpan: 5, placeholder: '30-XXXXXXXX-X' },
      { key: 'issuerTaxCondition', target: 'custom', label: 'Condición IVA Emisor', fieldType: 'select', colSpan: 4, options: TAX_CONDITIONS, aiAttrKeys: ['condicion_iva_emisor'] },
      { key: 'issuerIibb', target: 'custom', label: 'N° Ingresos Brutos Emisor', fieldType: 'text', colSpan: 4, placeholder: 'Ej: 901-123456-7 / CM', aiAttrKeys: ['ingresos_brutos_emisor', 'iibb_emisor', 'ingresos_brutos'] },
      { key: 'issuerActivityStartDate', target: 'custom', label: 'Inicio de Actividades', fieldType: 'text', colSpan: 4, placeholder: 'DD/MM/AAAA', aiAttrKeys: ['inicio_actividades', 'fecha_inicio_actividades'] },
      { key: 'recipientName', target: 'core', label: 'Cliente / Receptor', fieldType: 'text', colSpan: 7 },
      { key: 'recipientTaxId', target: 'core', label: 'CUIT / CUIL / DNI Cliente', fieldType: 'cuit', colSpan: 5, placeholder: 'XX-XXXXXXXX-X' },
      { key: 'taxCondition', target: 'core', label: 'Condición IVA Cliente', fieldType: 'select', colSpan: 6, options: TAX_CONDITIONS },
      { key: 'deliveryAddress', target: 'core', label: 'Domicilio Comercial / Cliente', fieldType: 'text', colSpan: 6 },
      { key: 'recipientEmail', target: 'core', label: 'Email Cliente', fieldType: 'text', colSpan: 6 },
      { key: 'recipientPhone', target: 'core', label: 'Teléfono Cliente', fieldType: 'text', colSpan: 6 },
    ],
  };
}

/**
 * Sección compartida de Importes y Tributos ARCA (Factura, NC, ND).
 */
export function buildArcaAmountsSection(
  totalLabel = 'Importe Total Final',
  sectionTitle = '3. Importes, Tributos y Condiciones de Venta',
): DocumentFormSectionSchema {
  return {
    id: 'amounts_taxes',
    title: sectionTitle,
    icon: 'tabler:cash',
    fields: [
      { key: 'currency', target: 'core', label: 'Moneda', fieldType: 'select', colSpan: 3, defaultValue: 'ARS', options: CURRENCY_OPTIONS },
      { key: 'exchangeRate', target: 'custom', label: 'Tipo de Cambio ARCA', fieldType: 'number', colSpan: 3, placeholder: '1.00 (obligatorio si USD/EUR)', aiAttrKeys: ['tipo_cambio', 'cotizacion'] },
      { key: 'netAmount', target: 'core', label: 'Importe Neto Gravado', fieldType: 'currency', colSpan: 3 },
      { key: 'taxAmount', target: 'core', label: 'Total IVA', fieldType: 'currency', colSpan: 3 },
      { key: 'iva21', target: 'custom', label: 'IVA 21%', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['iva_21'] },
      { key: 'iva105', target: 'custom', label: 'IVA 10,5%', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['iva_105', 'iva_10_5'] },
      { key: 'iva27', target: 'custom', label: 'IVA 27%', fieldType: 'currency', colSpan: 3, aiAttrKeys: ['iva_27'] },
      { key: 'exemptAmount', target: 'core', label: 'No Gravado / Exento', fieldType: 'currency', colSpan: 3 },
      { key: 'otherTaxesAmount', target: 'core', label: 'Percepciones / Otros Tributos', fieldType: 'currency', colSpan: 4 },
      { key: 'iibbPerception', target: 'custom', label: 'Percepción IIBB', fieldType: 'currency', colSpan: 4, aiAttrKeys: ['percepcion_iibb'] },
      { key: 'totalAmount', target: 'core', label: totalLabel, fieldType: 'currency', colSpan: 4, required: true },
      { key: 'paymentTerms', target: 'core', label: 'Condición de Venta', fieldType: 'text', colSpan: 4, placeholder: 'Contado / Cta. Cte. 30 días' },
      { key: 'paymentMethod', target: 'core', label: 'Medio de Pago', fieldType: 'text', colSpan: 4, placeholder: 'Transferencia / Cheque / Efectivo' },
      { key: 'fceCbu', target: 'custom', label: 'CBU Informado (FCE MiPyME)', fieldType: 'text', colSpan: 4, placeholder: '22 dígitos (opcional)', aiAttrKeys: ['cbu_informado', 'cbu'] },
      { key: 'department', target: 'core', label: 'Sector / Centro de Costos', fieldType: 'text', colSpan: 6 },
      { key: 'branch', target: 'core', label: 'Sucursal / Depósito', fieldType: 'text', colSpan: 6 },
    ],
  };
}
