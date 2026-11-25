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
