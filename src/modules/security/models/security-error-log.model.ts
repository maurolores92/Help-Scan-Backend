import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export enum SecurityErrorSource {
  BACKEND = 'BACKEND',
  FRONTEND = 'FRONTEND',
}

export enum SecurityErrorSeverity {
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

@Table({
  timestamps: true,
  updatedAt: false,
  tableName: 'security_error_logs',
  underscored: true,
})
export class SecurityErrorLog extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: SecurityErrorSource.BACKEND,
  })
  declare source: SecurityErrorSource;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'status_code',
  })
  declare statusCode: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: SecurityErrorSeverity.WARN,
  })
  declare severity: SecurityErrorSeverity;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare method: string | null;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare path: string;

  @Column({ type: DataType.STRING(300), allowNull: true, field: 'frontend_route' })
  declare frontendRoute: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'error_code' })
  declare errorCode: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare message: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'stack_trace' })
  declare stackTrace: string | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'sanitized_payload' })
  declare sanitizedPayload: Record<string, any> | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare userId: number | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare username: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'company_id' })
  declare companyId: number | null;

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
}
