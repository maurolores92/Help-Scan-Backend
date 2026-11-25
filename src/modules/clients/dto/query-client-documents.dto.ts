import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryClientDocumentsDto {
  @IsOptional()
  @IsString()
  documentType?: string;

  @IsOptional()
  @IsIn(['all', 'issuer', 'recipient', 'linked'])
  role?: 'all' | 'issuer' | 'recipient' | 'linked';

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsIn(['all', 'linked', 'unlinked'])
  linkState?: 'all' | 'linked' | 'unlinked';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 15;
}
