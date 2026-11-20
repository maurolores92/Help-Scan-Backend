import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { TelegramSenderPolicy } from '../models/company-telegram-channel.model';

export class UpsertTelegramChannelDto {
  @IsOptional()
  @IsString()
  botToken?: string;

  @IsOptional()
  @IsEnum(TelegramSenderPolicy)
  senderPolicy?: TelegramSenderPolicy;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedChatIds?: string[];

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
