import {
  IsArray,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocumentPaymentStatus } from '../document.model';

export class ValidateDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  documentDate?: string;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  issuerTaxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  recipientTaxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  recipientPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  deliveryAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  responsiblePerson?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  netAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  taxAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  cae?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  taxCondition?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  documentLetter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  pointOfSale?: string;

  @IsOptional()
  @IsString()
  caeDueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  purchaseOrderNumber?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  exemptAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  otherTaxesAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  carrierName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  period?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  items?: any[];

  @IsOptional()
  @IsObject()
  extractedData?: Record<string, any>;

  @IsOptional()
  @IsString()
  validationNotes?: string;

  @IsOptional()
  @IsEnum(DocumentPaymentStatus)
  paymentStatus?: DocumentPaymentStatus;

  @IsOptional()
  @IsString()
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  paymentReference?: string;
}
