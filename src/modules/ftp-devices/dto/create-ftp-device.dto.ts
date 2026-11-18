import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FtpProtocol } from '../ftp-device.model';
import { parseAllowedIpsInput } from '../helpers/ftp-device.helper';

/**
 * DTO para dar de alta una impresora HP / acceso FTP-SFTP-FTPS aislado por compañía.
 */
export class CreateFtpDeviceDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  companyId?: number;

  @IsString()
  @IsNotEmpty({ message: 'El nombre del equipo es obligatorio' })
  @MaxLength(120)
  deviceName: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceModel?: string;

  @IsOptional()
  @IsEnum(FtpProtocol, { message: 'El protocolo debe ser SFTP, FTPS o FTP' })
  protocol?: FtpProtocol;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  subFolder?: string;

  @IsOptional()
  @Transform(({ value }) => parseAllowedIpsInput(value))
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];

  @IsOptional()
  @IsString()
  @MinLength(10, {
    message: 'La contraseña manual debe tener al menos 10 caracteres',
  })
  @MaxLength(64)
  customPassword?: string;
}
