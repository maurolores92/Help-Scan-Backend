import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { WhatsappSenderPolicy } from '../models/company-whatsapp-channel.model';

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
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  processImages?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReplyConfirmation?: boolean;
}
