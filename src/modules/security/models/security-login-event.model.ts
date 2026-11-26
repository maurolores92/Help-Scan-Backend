import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export enum SecurityLoginEventType {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_BLOCKED_ACTIVE_SESSION = 'LOGIN_BLOCKED_ACTIVE_SESSION',
  SESSION_FORCED_TAKEOVER = 'SESSION_FORCED_TAKEOVER',
  SESSION_REVOKED = 'SESSION_REVOKED',
  LOGOUT = 'LOGOUT',
}

@Table({
  timestamps: true,
  updatedAt: false,
  tableName: 'security_login_events',
  underscored: true,
})
export class SecurityLoginEvent extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'event_type',
  })
  declare eventType: SecurityLoginEventType;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'username_attempted',
  })
  declare usernameAttempted: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare userId: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'company_id' })
  declare companyId: number | null;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'user_role' })
  declare userRole: string | null;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'ip_address' })
  declare ipAddress: string;

  @Column({ type: DataType.STRING(10), allowNull: true, field: 'country_code' })
  declare countryCode: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'country_name' })
  declare countryName: string | null;

  @Column({ type: DataType.STRING(200), allowNull: true, field: 'isp_owner' })
  declare ispOwner: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'user_agent' })
  declare userAgent: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare browser: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare os: string | null;

  @Column({ type: DataType.STRING(40), allowNull: true, field: 'device_type' })
  declare deviceType: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'failure_reason' })
  declare failureReason: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true, field: 'session_id' })
  declare sessionId: string | null;
}
