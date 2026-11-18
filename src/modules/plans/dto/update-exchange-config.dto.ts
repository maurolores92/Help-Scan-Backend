import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateExchangeConfigDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'La cotización del dólar debe ser un número válido' })
  @Min(1, { message: 'La cotización del dólar debe ser mayor o igual a 1' })
  usdRate: number;

  @IsOptional()
  @IsBoolean({ message: 'El indicador de redondeo debe ser booleano' })
  roundPrices?: boolean;
}

