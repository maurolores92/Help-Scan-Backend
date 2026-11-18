import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * Modelo de Configuración de Cotización y Redondeo de Moneda.
 * Almacena la tasa de cambio de referencia (USD a ARS) y la política de redondeo de precios.
 * Registro único administrado por el Super Administrador de la plataforma.
 */
@Table({
  timestamps: true,
  tableName: 'plan_exchange_config',
  underscored: true,
})
export class PlanExchangeConfig extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  /**
   * Cotización oficial de referencia: 1 USD expresado en Pesos Argentinos (ARS).
   */
  @Column({
    type: DataType.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 1250.0,
    field: 'usd_rate',
  })
  declare usdRate: number;

  /**
   * Si es true, redondea los precios finales en ARS hacia el entero superior (Math.ceil).
   * Si es false, conserva los centavos (dos decimales).
   */
  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'round_prices',
  })
  declare roundPrices: boolean;

  /**
   * ID del Super Administrador que realizó la última modificación.
   */
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'updated_by',
  })
  declare updatedBy: number | null;
}

