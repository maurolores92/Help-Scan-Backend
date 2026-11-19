import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmailProviderType } from '../models/company-email-channel.model';

export class UpsertEmailChannelDto {
  @IsEnum(EmailProviderType)
  provider: EmailProviderType;

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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  processBodyWithoutAttachments?: boolean;

  @IsOptional()
  @IsBoolean()
  markAsRead?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  syncIntervalMinutes?: number;
}
