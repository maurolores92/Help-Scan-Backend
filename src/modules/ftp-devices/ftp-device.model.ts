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
import { Company } from '../companies/company.model';

export enum FtpProtocol {
  SFTP = 'SFTP',
  FTPS = 'FTPS',
  FTP = 'FTP',
}

export enum FtpDeviceStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

/**
 * Perfil de impresora / dispositivo autorizado (ej. HP LaserJet Managed E52645)
 * para enviar documentos escaneados hacia la carpeta aislada `inbox/` del cliente vía SFTPGo.
 */
@Table({
  timestamps: true,
  tableName: 'ftp_devices',
  underscored: true,
})
export class FtpDevice extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Company)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'company_id' })
  declare companyId: number;

  @BelongsTo(() => Company, { foreignKey: 'companyId' })
  declare company: Company;

  @Column({
    type: DataType.STRING(150),
    allowNull: false,
    field: 'device_name',
  })
  declare deviceName: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: true,
    defaultValue: 'HP LaserJet Managed E52645',
    field: 'device_model',
  })
  declare deviceModel: string | null;

  @Column({
    type: DataType.STRING(15),
    allowNull: false,
    defaultValue: FtpProtocol.SFTP,
  })
  declare protocol: FtpProtocol;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    unique: true,
  })
  declare username: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'password_encrypted',
  })
  declare passwordEncrypted: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'sub_folder',
  })
  declare subFolder: string;

  /**
   * Lista opcional de IPs públicas permitidas separadas por coma (ej. "190.12.34.56").
   */
  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    field: 'allowed_ips',
  })
  declare allowedIps: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: FtpDeviceStatus.ACTIVE,
  })
  declare status: FtpDeviceStatus;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'sftpgo_synced',
  })
  declare sftpgoSynced: boolean;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'last_sync_error',
  })
  declare lastSyncError: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_file_at',
  })
  declare lastFileAt: Date | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'scanned_count',
  })
  declare scannedCount: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'created_by',
  })
  declare createdBy: number | null;
}

