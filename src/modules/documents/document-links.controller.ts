import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DocumentLinksService } from './services/document-links.service';
import {
  BatchDocumentLinksDto,
  CreateDocumentLinkDto,
  UpdateDocumentLinkDto,
} from './dto/document-link.dto';
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
 * @controller DocumentLinksController
 * Conciliación y vinculación N:M entre comprobantes (Recibos/OP <-> Facturas,
 * Notas de Crédito/Débito <-> Facturas, Remitos <-> Facturas).
 */
@Controller('documents')
@UseGuards(AuthGuard('jwt'), PermissionsGuard, TenantModuleGuard)
@RequireTenantModule('documents')
export class DocumentLinksController {
  constructor(private readonly documentLinksService: DocumentLinksService) {}

  private assertTenantCompany(user: any): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no gestiona vínculos de documentos.',
      );
    }
    return requireTenantCompanyId(user);
  }

  /**
   * Crea múltiples vínculos documentales en lote (conciliación desde ficha de cliente o recibo).
   * @permissions ['UPLOAD_DOCUMENT']
   */
  @Post('links/batch')
  @RequirePermission('UPLOAD_DOCUMENT')
  createBatchLinks(@Body() dto: BatchDocumentLinksDto, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.createBatchLinks(companyId, user.id, dto);
  }

  /**
   * Lista vínculos activos, saldo pendiente calculado y sugerencias inteligentes de matching.
   * @permissions ['VIEW_DOCUMENTS']
   */
  @Get(':id/links')
  @RequirePermission('VIEW_DOCUMENTS')
  getLinks(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.getDocumentLinksAndSuggestions(id, companyId);
  }

  /**
   * Vincula un documento manualmente o aceptando una sugerencia inteligente.
   * @permissions ['UPLOAD_DOCUMENT']
   */
  @Post(':id/links')
  @RequirePermission('UPLOAD_DOCUMENT')
  createLink(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateDocumentLinkDto,
    @GetUser() user: any,
  ) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.createLink(id, companyId, user.id, dto);
  }

  /**
   * Re-ejecuta la conciliación automática determinística para el documento.
   * @permissions ['UPLOAD_DOCUMENT']
   */
  @Post(':id/links/auto-match')
  @RequirePermission('UPLOAD_DOCUMENT')
  autoMatch(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.runAutoExactMatchingForDocument(id, companyId, user.id);
  }

  /**
   * Actualiza monto imputado, tipo de relación o notas de un vínculo existente.
   * @permissions ['UPLOAD_DOCUMENT']
   */
  @Patch(':id/links/:linkId')
  @RequirePermission('UPLOAD_DOCUMENT')
  updateLink(
    @Param('id', ParseIntPipe) id: number,
    @Param('linkId', ParseIntPipe) linkId: number,
    @Body() dto: UpdateDocumentLinkDto,
    @GetUser() user: any,
  ) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.updateLink(id, linkId, companyId, user.id, dto);
  }

  /**
   * Desvincula dos comprobantes y recalcula automáticamente el saldo pendiente afectado.
   * @permissions ['UPLOAD_DOCUMENT']
   */
  @Delete(':id/links/:linkId')
  @RequirePermission('UPLOAD_DOCUMENT')
  removeLink(
    @Param('id', ParseIntPipe) id: number,
    @Param('linkId', ParseIntPipe) linkId: number,
    @GetUser() user: any,
  ) {
    const companyId = this.assertTenantCompany(user);
    return this.documentLinksService.removeLink(id, linkId, companyId, user.id);
  }
}
