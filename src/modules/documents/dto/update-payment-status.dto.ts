import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DocumentPaymentStatus } from '../document.model';

export class UpdatePaymentStatusDto {
  @IsEnum(DocumentPaymentStatus)
  paymentStatus: DocumentPaymentStatus;

  @IsOptional()
  @IsString()
  paidAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  paymentReference?: string | null;
}
