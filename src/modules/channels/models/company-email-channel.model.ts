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
import { Users } from '../../users/users.model';

export enum EmailProviderType {
  GMAIL = 'GMAIL',
  OUTLOOK = 'OUTLOOK',
  CUSTOM = 'CUSTOM',
}

export enum EmailSenderPolicy {
  ALL = 'ALL',
  WHITELIST = 'WHITELIST',
}

export enum EmailSyncStatus {
  IDLE = 'IDLE',
  OK = 'OK',
  ERROR = 'ERROR',
}

@Table({
  timestamps: true,
  tableName: 'company_email_channels',
  underscored: true,
})
export class CompanyEmailChannel extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'company_id' })
  declare companyId: number;

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare userId: number | null;

  @BelongsTo(() => Users, { foreignKey: 'userId', constraints: false })
  declare user: Users | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: EmailProviderType.GMAIL,
  })
  declare provider: EmailProviderType;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare host: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 993 })
  declare port: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare secure: boolean;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'email_user' })
  declare emailUser: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'encrypted_password' })
  declare encryptedPassword: string;

  @Column({ type: DataType.STRING(100), allowNull: false, defaultValue: 'INBOX' })
  declare folder: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' })
  declare isActive: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'process_body_without_attachments',
  })
  declare processBodyWithoutAttachments: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'mark_as_read',
  })
  declare markAsRead: boolean;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 5,
    field: 'sync_interval_minutes',
  })
  declare syncIntervalMinutes: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_sync_at' })
  declare lastSyncAt: Date | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: EmailSyncStatus.IDLE,
    field: 'last_sync_status',
  })
  declare lastSyncStatus: EmailSyncStatus;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'last_sync_message' })
  declare lastSyncMessage: string | null;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'webhook_secret' })
  declare webhookSecret: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: EmailSenderPolicy.ALL,
    field: 'sender_policy',
  })
  declare senderPolicy: EmailSenderPolicy;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'allowed_senders',
  })
  declare allowedSenders: string[];
}
