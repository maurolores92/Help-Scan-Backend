import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class TestEmailConnectionDto {
  @IsString()
  host: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsEmail({}, { message: 'El correo electrónico ingresado no es válido' })
  emailUser: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  folder?: string;
}
