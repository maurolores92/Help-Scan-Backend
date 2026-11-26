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
  updatedAt: false,
  tableName: 'security_access_logs',
  underscored: true,
})
export class SecurityAccessLog extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'BACKEND',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    field: 'event_type',
  })
  declare eventType: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    field: 'ip_address',
  })
  declare ipAddress: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_private_ip',
  })
  declare isPrivateIp: boolean;

  @Column({
    type: DataType.STRING(10),
    allowNull: true,
    field: 'country_code',
  })
  declare countryCode: string | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'country_name',
  })
  declare countryName: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare region: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare city: string | null;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
    field: 'isp_org',
  })
  declare ispOrg: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'user_agent' })
  declare userAgent: string | null;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare method: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare path: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'status_code',
  })
  declare statusCode: number | null;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'username_attempted',
  })
  declare usernameAttempted: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare details: string | null;
}
