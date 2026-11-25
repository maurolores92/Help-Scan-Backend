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
import { Document } from '../document.model';

export enum DocumentLinkType {
  PAYMENT_IMPUTATION = 'PAYMENT_IMPUTATION',
  CREDIT_NOTE_ADJUSTMENT = 'CREDIT_NOTE_ADJUSTMENT',
  DEBIT_NOTE_ADJUSTMENT = 'DEBIT_NOTE_ADJUSTMENT',
  BILLING_FROM_DELIVERY = 'BILLING_FROM_DELIVERY',
  ORDER_FULFILLMENT = 'ORDER_FULFILLMENT',
  PAYMENT_EXECUTION = 'PAYMENT_EXECUTION',
  GENERAL_RELATED = 'GENERAL_RELATED',
}

export enum DocumentLinkMatchSource {
  AUTO_EXACT = 'AUTO_EXACT',
  SUGGESTED_ACCEPTED = 'SUGGESTED_ACCEPTED',
  MANUAL = 'MANUAL',
}

export const DOCUMENT_LINK_TYPE_LABELS: Record<DocumentLinkType, string> = {
  [DocumentLinkType.PAYMENT_IMPUTATION]: 'Imputación de Pago / Cobro',
  [DocumentLinkType.CREDIT_NOTE_ADJUSTMENT]: 'Ajuste Nota de Crédito',
  [DocumentLinkType.DEBIT_NOTE_ADJUSTMENT]: 'Ajuste Nota de Débito',
  [DocumentLinkType.BILLING_FROM_DELIVERY]: 'Facturación de Remito',
  [DocumentLinkType.ORDER_FULFILLMENT]: 'Cumplimiento de Orden / Presupuesto',
  [DocumentLinkType.PAYMENT_EXECUTION]: 'Medio de Pago de Orden / Recibo',
  [DocumentLinkType.GENERAL_RELATED]: 'Relación Documental',
};

@Table({
  timestamps: true,
  tableName: 'document_links',
  underscored: true,
})
export class DocumentLink extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

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
    field: 'source_document_id',
  })
  declare sourceDocumentId: number;

  @BelongsTo(() => Document, {
    foreignKey: 'sourceDocumentId',
    as: 'sourceDocument',
    onDelete: 'CASCADE',
  })
  declare sourceDocument: Document;

  @ForeignKey(() => Document)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'target_document_id',
  })
  declare targetDocumentId: number;

  @BelongsTo(() => Document, {
    foreignKey: 'targetDocumentId',
    as: 'targetDocument',
    onDelete: 'CASCADE',
  })
  declare targetDocument: Document;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: DocumentLinkType.GENERAL_RELATED,
    field: 'link_type',
  })
  declare linkType: DocumentLinkType;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: true,
    field: 'applied_amount',
  })
  declare appliedAmount: number | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: DocumentLinkMatchSource.MANUAL,
    field: 'match_source',
  })
  declare matchSource: DocumentLinkMatchSource;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
  })
  declare confidence: number | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare notes: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'created_by_user_id',
  })
  declare createdByUserId: number | null;
}
