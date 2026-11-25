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
import { CompanyWhatsappChannel } from './company-whatsapp-channel.model';

export enum WhatsappMessageStatus {
  PROCESSED = 'PROCESSED',
  SKIPPED = 'SKIPPED',
  REJECTED_SENDER = 'REJECTED_SENDER',
  ERROR = 'ERROR',
}

@Table({
  timestamps: true,
  tableName: 'whatsapp_messages',
  underscored: true,
})
export class WhatsappMessage extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'company_id' })
  declare companyId: number;

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @ForeignKey(() => CompanyWhatsappChannel)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'channel_id' })
  declare channelId: number | null;

  @BelongsTo(() => CompanyWhatsappChannel, {
    foreignKey: 'channelId',
    constraints: false,
  })
  declare channel: CompanyWhatsappChannel | null;

  @Column({
    type: DataType.STRING(180),
    allowNull: false,
    field: 'external_message_id',
  })
  declare externalMessageId: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'sender_phone',
  })
  declare senderPhone: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: true,
    field: 'reply_jid',
  })
  declare replyJid: string | null;

  @Column({
    type: DataType.STRING(120),
    allowNull: true,
    field: 'group_jid',
  })
  declare groupJid: string | null;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'group_name',
  })
  declare groupName: string | null;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'sender_name',
  })
  declare senderName: string | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'document',
    field: 'message_type',
  })
  declare messageType: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
    field: 'file_name',
  })
  declare fileName: string | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'mime_type',
  })
  declare mimeType: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare caption: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'received_at',
  })
  declare receivedAt: Date;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: WhatsappMessageStatus.SKIPPED,
  })
  declare status: WhatsappMessageStatus;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'status_reason',
  })
  declare statusReason: string | null;

  @ForeignKey(() => Document)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'document_id' })
  declare documentId: number | null;

  @BelongsTo(() => Document, { foreignKey: 'documentId', constraints: false })
  declare document: Document | null;
}
