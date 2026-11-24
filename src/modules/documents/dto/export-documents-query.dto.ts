import { IsIn, IsOptional, IsString } from 'class-validator';
import { QueryDocumentDto } from './query-document.dto';

export type DocumentExportFormat = 'xlsx' | 'csv' | 'pdf' | 'zip';

export class ExportDocumentsQueryDto extends QueryDocumentDto {
  @IsOptional()
  @IsIn(['xlsx', 'csv', 'pdf', 'zip'])
  format?: DocumentExportFormat = 'xlsx';

  @IsOptional()
  @IsString()
  ids?: string;
}
