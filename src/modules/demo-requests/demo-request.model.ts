import {
  AutoIncrement,
  Column,
  DataType,
  Default,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export enum DemoRequestStatus {
  RECIBIDO = 'RECIBIDO',
  CONTACTADO = 'CONTACTADO',
  INTERESADO = 'INTERESADO',
  VENDIDO = 'VENDIDO',
  RECHAZADO = 'RECHAZADO',
}

@Table({
  tableName: 'demo_requests',
  timestamps: true,
  underscored: true,
})
export class DemoRequest extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare fullName: string;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare companyName: string;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare phone: string | null;

  @Column({ type: DataType.STRING(120), allowNull: true })
  declare managementSystem: string | null;

  @Column({ type: DataType.STRING(160), allowNull: true })
  declare selectedDemo: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare message: string | null;

  @Default('demo_modal')
  @Column({ type: DataType.STRING(40), allowNull: false })
  declare source: string;

  @Default(DemoRequestStatus.RECIBIDO)
  @Column({
    type: DataType.STRING(24),
    allowNull: false,
  })
  declare status: DemoRequestStatus;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare emailSent: boolean;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;
}
