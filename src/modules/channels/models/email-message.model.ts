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
import { Document } from '../../documents/document.model';
import { CompanyEmailChannel } from './company-email-channel.model';

export enum EmailMessageStatus {
  PROCESSED = 'PROCESSED',
  SYNTHESIZED_BODY = 'SYNTHESIZED_BODY',
  SKIPPED = 'SKIPPED',
  ERROR = 'ERROR',
}

@Table({
  timestamps: true,
  tableName: 'email_messages',
  underscored: true,
})
export class EmailMessage extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'company_id' })
  declare companyId: number;

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @ForeignKey(() => CompanyEmailChannel)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'channel_id' })
  declare channelId: number | null;

  @BelongsTo(() => CompanyEmailChannel, { foreignKey: 'channelId', constraints: false })
  declare channel: CompanyEmailChannel | null;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'message_id' })
  declare messageId: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'imap_uid' })
  declare imapUid: number | null;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'sender_name' })
  declare senderName: string | null;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'sender_email' })
  declare senderEmail: string;

  @Column({ type: DataType.STRING(500), allowNull: false, defaultValue: '(Sin asunto)' })
  declare subject: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'received_at' })
  declare receivedAt: Date;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'body_text' })
  declare bodyText: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'body_html_sanitized' })
  declare bodyHtmlSanitized: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'attachments_count',
  })
  declare attachmentsCount: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'attachment_names',
  })
  declare attachmentNames: string[];

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: EmailMessageStatus.SKIPPED,
  })
  declare status: EmailMessageStatus;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'status_reason' })
  declare statusReason: string | null;

  @ForeignKey(() => Document)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'document_id' })
  declare documentId: number | null;

  @BelongsTo(() => Document, { foreignKey: 'documentId', constraints: false })
  declare document: Document | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'generated_document_ids',
  })
  declare generatedDocumentIds: number[];
}
