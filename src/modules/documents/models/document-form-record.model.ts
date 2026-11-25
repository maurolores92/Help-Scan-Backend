import {
  AutoIncrement,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Company } from '../../companies/company.model';
import { Document } from '../document.model';
import { DocumentTypeForm } from './document-type-form.model';

@Table({
  timestamps: true,
  tableName: 'document_form_records',
  underscored: true,
})
export class DocumentFormRecord extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'company_id',
  })
  declare companyId: number;

  @ForeignKey(() => Document)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    unique: true,
    field: 'document_id',
  })
  declare documentId: number;

  @BelongsTo(() => Document, { foreignKey: 'documentId', onDelete: 'CASCADE' })
  declare document: Document;

  @ForeignKey(() => DocumentTypeForm)
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'form_schema_id',
  })
  declare formSchemaId: number | null;

  @BelongsTo(() => DocumentTypeForm, { foreignKey: 'formSchemaId', constraints: false })
  declare formSchema: DocumentTypeForm | null;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'document_type',
  })
  declare documentType: string;

  /**
   * Valores específicos del tipo de documento (campos con target='custom' en el esquema).
   */
  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'form_data',
  })
  declare formData: Record<string, any>;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
    field: 'schema_version',
  })
  declare schemaVersion: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'validated_by_user_id',
  })
  declare validatedByUserId: number | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'validated_at',
  })
  declare validatedAt: Date | null;
}
