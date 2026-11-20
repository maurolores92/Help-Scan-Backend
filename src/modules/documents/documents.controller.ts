import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Delete,
  Param,
  Query,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  ParseIntPipe,
  Res,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DocumentsService } from './documents.service';
import { QueryDocumentDto } from './dto/query-document.dto';
import { ValidateDocumentDto } from './dto/validate-document.dto';
import { RejectDocumentDto } from './dto/reject-document.dto';
import { BulkDeleteDocumentsDto } from './dto/bulk-delete-documents.dto';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequireTenantModule } from '../../common/decorators/require-tenant-module.decorator';
import { TenantModuleGuard } from '../../common/guards/tenant-module.guard';
import {
  isPlatformSuperAdmin,
  requireTenantCompanyId,
} from '../../common/utils/tenant-scope.util';

/**
 * @controller DocumentsController
 * Ingesta manual desde el portal, recepción automática vía FTP/SFTP,
 * búsqueda universal de comprobantes, visor de PDF y extracción de datos mediante OCR.
 */
@Controller('documents')
@UseGuards(AuthGuard('jwt'), PermissionsGuard, TenantModuleGuard)
@RequireTenantModule('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  private assertTenantCompany(user: any): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no sube ni accede a documentos de compañías.',
      );
    }
    return requireTenantCompanyId(user);
  }

  @Post('upload')
  @RequirePermission('UPLOAD_DOCUMENT')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.pdf')) {
          return cb(new BadRequestException('Solo se permiten archivos en formato PDF'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadFile(@UploadedFile() file: Express.Multer.File, @GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.uploadFromApp(file, { ...user, companyId: tenantCompanyId });
  }

  @Post('upload-multiple')
  @RequirePermission('UPLOAD_DOCUMENT')
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.pdf')) {
          return cb(new BadRequestException(`El archivo '${file.originalname}' no es un PDF`), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadMultipleFiles(
    @UploadedFiles() files: Express.Multer.File[],
    @GetUser() user: any,
  ) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.uploadMultipleFromApp(files, { ...user, companyId: tenantCompanyId });
  }

  @Post('sync-ftp')
  @RequireTenantModule('sftp')
  @RequirePermission('UPLOAD_DOCUMENT')
  syncFtp(@GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.scanFtpFolder(tenantCompanyId, user.id);
  }

  @Get('queue-status')
  @RequirePermission('VIEW_DOCUMENTS')
  getQueueStatus() {
    return this.documentsService.getUploadQueueStatus();
  }

  @Get('facets')
  @RequirePermission('VIEW_DOCUMENTS')
  getFacets(@GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.getFacets(tenantCompanyId);
  }

  @Get()
  @RequirePermission('VIEW_DOCUMENTS')
  findAll(@GetUser() user: any, @Query() query: QueryDocumentDto) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.findAll(tenantCompanyId, query);
  }

  @Get(':id')
  @RequirePermission('VIEW_DOCUMENTS')
  findOne(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.findById(id, tenantCompanyId);
  }

  @Post(':id/reprocess')
  @RequirePermission('UPLOAD_DOCUMENT')
  reprocess(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.reprocessDocument(id, tenantCompanyId, user.id);
  }

  @Patch(':id/validate')
  @RequirePermission('UPLOAD_DOCUMENT')
  validate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ValidateDocumentDto,
    @GetUser() user: any,
  ) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.validateDocument(id, tenantCompanyId, user.id, dto);
  }

  @Patch(':id/reject')
  @RequirePermission('UPLOAD_DOCUMENT')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectDocumentDto,
    @GetUser() user: any,
  ) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.rejectDocument(id, tenantCompanyId, user.id, dto);
  }

  @Get(':id/file')
  @RequirePermission('VIEW_DOCUMENTS')
  async getFile(@Param('id', ParseIntPipe) id: number, @GetUser() user: any, @Res() res: Response) {
    const tenantCompanyId = this.assertTenantCompany(user);
    const { stream, plainSize, document } = await this.documentsService.getFileStream(id, tenantCompanyId);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${encodeURIComponent(document.originalName)}"`,
      'Content-Length': String(plainSize ?? document.fileSize),
    });

    stream.pipe(res);
  }

  @Post('bulk-delete')
  @RequirePermission('DELETE_DOCUMENT')
  bulkRemove(@Body() dto: BulkDeleteDocumentsDto, @GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.bulkRemove(dto.ids, tenantCompanyId, user.id);
  }

  @Delete(':id')
  @RequirePermission('DELETE_DOCUMENT')
  remove(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const tenantCompanyId = this.assertTenantCompany(user);
    return this.documentsService.remove(id, tenantCompanyId, user.id);
  }
}
