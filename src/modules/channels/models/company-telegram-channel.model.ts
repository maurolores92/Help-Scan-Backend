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

export enum TelegramSenderPolicy {
  ALL = 'ALL',
  WHITELIST = 'WHITELIST',
}

export enum TelegramSyncStatus {
  IDLE = 'IDLE',
  OK = 'OK',
  ERROR = 'ERROR',
}

@Table({
  timestamps: true,
  tableName: 'company_telegram_channels',
  underscored: true,
})
export class CompanyTelegramChannel extends Model {
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

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @ForeignKey(() => Users)
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'user_id',
  })
  declare userId: number | null;

  @BelongsTo(() => Users, { foreignKey: 'userId', constraints: false })
  declare user: Users | null;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'encrypted_bot_token',
  })
  declare encryptedBotToken: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    unique: true,
    field: 'bot_token_hash',
  })
  declare botTokenHash: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'bot_username',
  })
  declare botUsername: string | null;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'bot_display_name',
  })
  declare botDisplayName: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: TelegramSenderPolicy.ALL,
    field: 'sender_policy',
  })
  declare senderPolicy: TelegramSenderPolicy;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'allowed_chat_ids',
  })
  declare allowedChatIds: string[];

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
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
    type: DataType.BIGINT,
    allowNull: false,
    defaultValue: 0,
    field: 'last_poll_offset',
  })
  declare lastPollOffset: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_message_at',
  })
  declare lastMessageAt: Date | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: TelegramSyncStatus.IDLE,
    field: 'last_sync_status',
  })
  declare lastSyncStatus: TelegramSyncStatus;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'last_sync_message',
  })
  declare lastSyncMessage: string | null;
}
