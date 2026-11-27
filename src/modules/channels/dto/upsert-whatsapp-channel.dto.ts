import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  WhatsappGroupPolicy,
  WhatsappSenderPolicy,
} from '../models/company-whatsapp-channel.model';

export class AllowedWhatsappGroupDto {
  @IsString()
  jid: string;

  @IsOptional()
  @IsString()
  name?: string;
}

export class UpsertWhatsappChannelDto {
  @IsOptional()
  @IsEnum(WhatsappSenderPolicy)
  senderPolicy?: WhatsappSenderPolicy;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedPhones?: string[];

  @IsOptional()
  @IsBoolean()
  ignoreGroups?: boolean;

  @IsOptional()
  @IsEnum(WhatsappGroupPolicy)
  groupPolicy?: WhatsappGroupPolicy;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllowedWhatsappGroupDto)
  allowedGroups?: AllowedWhatsappGroupDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  processImages?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReplyConfirmation?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyOnReceive?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyOnIndexed?: boolean;
}
