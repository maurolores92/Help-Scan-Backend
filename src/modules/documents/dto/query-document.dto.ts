import { IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DocumentPaymentStatus, DocumentSource, DocumentStatus } from '../document.model';

export class QueryDocumentDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @IsOptional()
  @IsEnum(DocumentPaymentStatus)
  paymentStatus?: DocumentPaymentStatus;

  @IsOptional()
  @IsIn(['OVERDUE', 'DUE_SOON'])
  dueFilter?: 'OVERDUE' | 'DUE_SOON';

  @IsOptional()
  @IsEnum(DocumentSource)
  source?: DocumentSource;

  @IsOptional()
  @IsString()
  documentType?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  purchaseOrderNumber?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  documentLetter?: string;

  @IsOptional()
  @IsString()
  recipientTaxId?: string;

  @IsOptional()
  @Type(() => Number)
  minAmount?: number;

  @IsOptional()
  @Type(() => Number)
  maxAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  filterCompanyId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  clientId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
