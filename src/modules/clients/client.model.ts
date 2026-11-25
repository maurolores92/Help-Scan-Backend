import {
  AutoIncrement,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Company } from '../companies/company.model';
import { Document } from '../documents/document.model';

@Table({
  timestamps: true,
  tableName: 'clients',
  underscored: true,
})
export class Client extends Model {
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
    type: DataType.STRING(200),
    allowNull: false,
  })
  declare name: string;

  /**
   * Nombre de fantasía / comercial (opcional en sistemas administrativos).
   */
  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'trade_name',
  })
  declare tradeName: string | null;

  /**
   * Tipo de clave / documento fiscal (CUIT, CUIL, DNI, CDI, Pasaporte).
   */
  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'tax_id_type',
  })
  declare taxIdType: string | null;

  /**
   * CUIT / CUIL con formato visible (ej: 20-30405060-7 o 30-70841005-1).
   * Puede ser NULL si el cliente se registró desde un documento comercial (ej. presupuesto) que no informaba CUIT.
   */
  @Column({
    type: DataType.STRING(30),
    allowNull: true,
    field: 'tax_id',
  })
  declare taxId: string | null;

  /**
   * CUIT / CUIL solo dígitos para matching rápido e inequívoco contra documentos.
   */
  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'normalized_tax_id',
  })
  declare normalizedTaxId: string | null;

  @Column({
    type: DataType.STRING(60),
    allowNull: true,
    field: 'tax_condition',
  })
  declare taxCondition: string | null;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'iibb_number',
  })
  declare iibbNumber: string | null;

  @Column({
    type: DataType.STRING(60),
    allowNull: true,
    field: 'iibb_condition',
  })
  declare iibbCondition: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'erp_code',
  })
  declare erpCode: string | null;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'contact_name',
  })
  declare contactName: string | null;

  @Column({
    type: DataType.STRING(120),
    allowNull: true,
  })
  declare email: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
  })
  declare phone: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'secondary_phone',
  })
  declare secondaryPhone: string | null;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
  })
  declare address: string | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
  })
  declare city: string | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
  })
  declare province: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'postal_code',
  })
  declare postalCode: string | null;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
  })
  declare country: string | null;

  @Column({
    type: DataType.STRING(150),
    allowNull: true,
    field: 'payment_terms',
  })
  declare paymentTerms: string | null;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
  })
  declare cbu: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare notes: string | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_active',
  })
  declare isActive: boolean;

  @HasMany(() => Document, { foreignKey: 'clientId', constraints: false })
  declare documents: Document[];
}
