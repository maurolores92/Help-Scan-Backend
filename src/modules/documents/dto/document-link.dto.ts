import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DocumentLinkMatchSource, DocumentLinkType } from '../models/document-link.model';

export class CreateDocumentLinkDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetDocumentId: number;

  @IsOptional()
  @IsEnum(DocumentLinkType)
  linkType?: DocumentLinkType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  appliedAmount?: number | null;

  @IsOptional()
  @IsEnum(DocumentLinkMatchSource)
  matchSource?: DocumentLinkMatchSource;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  swapDirection?: boolean;
}

export class UpdateDocumentLinkDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  appliedAmount?: number | null;

  @IsOptional()
  @IsEnum(DocumentLinkType)
  linkType?: DocumentLinkType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class BatchLinkItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceDocumentId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetDocumentId: number;

  @IsOptional()
  @IsEnum(DocumentLinkType)
  linkType?: DocumentLinkType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  appliedAmount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class BatchDocumentLinksDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchLinkItemDto)
  links: BatchLinkItemDto[];
}
