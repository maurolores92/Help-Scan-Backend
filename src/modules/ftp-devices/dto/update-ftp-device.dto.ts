import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { FtpDeviceStatus, FtpProtocol } from '../ftp-device.model';
import { parseAllowedIpsInput } from '../helpers/ftp-device.helper';

/**
 * DTO para actualizar configuración, IPs permitidas, estado o rotar credenciales de una impresora HP.
 */
export class UpdateFtpDeviceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

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
  @IsEnum(FtpDeviceStatus, { message: 'El estado debe ser ACTIVE o SUSPENDED' })
  status?: FtpDeviceStatus;

  @IsOptional()
  @IsBoolean()
  regeneratePassword?: boolean;
}
