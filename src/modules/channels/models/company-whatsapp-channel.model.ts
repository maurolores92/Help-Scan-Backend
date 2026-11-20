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

export enum WhatsappSenderPolicy {
  ALL = 'ALL',
  WHITELIST = 'WHITELIST',
}

export enum WhatsappConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  QR_READY = 'QR_READY',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export enum WhatsappSyncStatus {
  IDLE = 'IDLE',
  OK = 'OK',
  ERROR = 'ERROR',
}

@Table({
  timestamps: true,
  tableName: 'company_whatsapp_channels',
  underscored: true,
})
export class CompanyWhatsappChannel extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    unique: true,
    field: 'company_id',
  })
  declare companyId: number;

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'session_key',
  })
  declare sessionKey: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: WhatsappConnectionStatus.DISCONNECTED,
    field: 'connection_status',
  })
  declare connectionStatus: WhatsappConnectionStatus;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'connected_phone',
  })
  declare connectedPhone: string | null;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'connected_name',
  })
  declare connectedName: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: WhatsappSenderPolicy.ALL,
    field: 'sender_policy',
  })
  declare senderPolicy: WhatsappSenderPolicy;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'allowed_phones',
  })
  declare allowedPhones: string[];

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'ignore_groups',
  })
  declare ignoreGroups: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_active',
  })
  declare isActive: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'process_images',
  })
  declare processImages: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'auto_reply_confirmation',
  })
  declare autoReplyConfirmation: boolean;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_qr_at',
  })
  declare lastQrAt: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_message_at',
  })
  declare lastMessageAt: Date | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: WhatsappSyncStatus.IDLE,
    field: 'last_sync_status',
  })
  declare lastSyncStatus: WhatsappSyncStatus;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'last_sync_message',
  })
  declare lastSyncMessage: string | null;
}
