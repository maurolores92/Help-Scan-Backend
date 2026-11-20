import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DemoRequestStatus } from '../demo-request.model';

export class QueryDemoRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(DemoRequestStatus)
  status?: DemoRequestStatus;
}
