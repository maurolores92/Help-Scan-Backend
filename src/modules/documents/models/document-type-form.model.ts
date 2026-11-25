import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export type DocumentFormFieldType =
  | 'text'
  | 'cuit'
  | 'number'
  | 'currency'
  | 'date'
  | 'select'
  | 'textarea'
  | 'switch'
  | 'items_table';

export interface DocumentFormFieldSchema {
  /** Identificador de columna core de Document (cuando target='core') o clave JSON en formData (cuando target='custom'). */
  key: string;
  /** 'core' mapea a columnas directas de documents; 'custom' mapea a document_form_records.form_data. */
  target: 'core' | 'custom';
  label: string;
  fieldType: DocumentFormFieldType;
  colSpan?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 12;
  required?: boolean;
  placeholder?: string;
  helperText?: string;
  options?: Array<string | { value: string; label: string }>;
  defaultValue?: string | number | boolean | null;
  /** Claves alternativas posibles en extractedData.attributes para auto-completado desde IA/OCR. */
  aiAttrKeys?: string[];
  uppercase?: boolean;
  prefixIcon?: string;
}

export interface DocumentFormSectionSchema {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  fields: DocumentFormFieldSchema[];
}

@Table({
  timestamps: true,
  tableName: 'document_type_forms',
  underscored: true,
})
export class DocumentTypeForm extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  /**
   * NULL indica plantilla predefinida global del sistema; un ID permite personalización por compañía.
   */
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'company_id',
  })
  declare companyId: number | null;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
  })
  declare code: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: false,
  })
  declare label: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
  })
  declare description: string | null;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
  })
  declare icon: string | null;

  /**
   * Aliases o subtipos detectados por OCR/IA que resuelven hacia este formulario canónico.
   */
  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'match_aliases',
  })
  declare matchAliases: string[];

  /**
   * Definición declarativa de secciones y campos renderizados dinámicamente en el modal de validación.
   */
  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'sections_schema',
  })
  declare sectionsSchema: DocumentFormSectionSchema[];

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'ai_extraction_guide',
  })
  declare aiExtractionGuide: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 100,
    field: 'display_order',
  })
  declare displayOrder: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
  })
  declare version: number;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_active',
  })
  declare isActive: boolean;
}
