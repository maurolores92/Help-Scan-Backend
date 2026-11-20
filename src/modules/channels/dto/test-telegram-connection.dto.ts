import { IsOptional, IsString } from 'class-validator';

export class TestTelegramConnectionDto {
  @IsOptional()
  @IsString()
  botToken?: string;
}
