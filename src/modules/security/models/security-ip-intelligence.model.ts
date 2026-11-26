import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

@Table({
  timestamps: true,
  tableName: 'security_ip_intelligence',
  underscored: true,
})
export class SecurityIpIntelligence extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    unique: true,
    field: 'ip_address',
  })
  declare ipAddress: string;

  @Column({ type: DataType.STRING(10), allowNull: true, field: 'country_code' })
  declare countryCode: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'country_name' })
  declare countryName: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare region: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare city: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare isp: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare organization: string | null;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare asn: string | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_blocked',
  })
  declare isBlocked: boolean;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'block_reason' })
  declare blockReason: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'blocked_by_user_id' })
  declare blockedByUserId: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'blocked_at' })
  declare blockedAt: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'first_seen_at',
  })
  declare firstSeenAt: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'last_seen_at',
  })
  declare lastSeenAt: Date;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'total_requests',
  })
  declare totalRequests: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'failed_logins_count',
  })
  declare failedLoginsCount: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'error_count',
  })
  declare errorCount: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'last_user_id' })
  declare lastUserId: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'last_company_id' })
  declare lastCompanyId: number | null;

  @Column({ type: DataType.STRING(300), allowNull: true, field: 'last_path' })
  declare lastPath: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'last_user_agent' })
  declare lastUserAgent: string | null;

  @Column({ type: DataType.STRING(40), allowNull: true, field: 'lookup_provider' })
  declare lookupProvider: string | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'lookup_expires_at' })
  declare lookupExpiresAt: Date | null;
}
