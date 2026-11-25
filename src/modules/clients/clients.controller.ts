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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { QueryClientDocumentsDto } from './dto/query-client-documents.dto';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequireTenantModule } from '../../common/decorators/require-tenant-module.decorator';
import { TenantModuleGuard } from '../../common/guards/tenant-module.guard';
import {
  isPlatformSuperAdmin,
  requireTenantCompanyId,
} from '../../common/utils/tenant-scope.util';

@Controller('clients')
@UseGuards(AuthGuard('jwt'), PermissionsGuard, TenantModuleGuard)
@RequireTenantModule('documents')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  private assertTenantCompany(user: any): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no gestiona clientes de compañías.',
      );
    }
    return requireTenantCompanyId(user);
  }

  @Get()
  @RequirePermission('VIEW_CLIENTS')
  findAll(@GetUser() user: any, @Query() query: QueryClientDto) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.findAll(companyId, query);
  }

  @Get(':id/documents')
  @RequirePermission('VIEW_CLIENTS')
  findClientDocuments(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: QueryClientDocumentsDto,
    @GetUser() user: any,
  ) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.findClientDocuments(id, companyId, query);
  }

  @Get(':id')
  @RequirePermission('VIEW_CLIENTS')
  findOne(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.findById(id, companyId);
  }

  @Post()
  @RequirePermission('CREATE_CLIENT')
  create(@Body() dto: CreateClientDto, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.create(dto, companyId, user.id);
  }

  @Patch(':id')
  @RequirePermission('UPDATE_CLIENT')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClientDto,
    @GetUser() user: any,
  ) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.update(id, dto, companyId, user.id);
  }

  @Post(':id/sync-documents')
  @RequirePermission('UPDATE_CLIENT')
  syncDocuments(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.syncDocumentsByTaxId(id, companyId, user.id);
  }

  @Delete(':id')
  @RequirePermission('DELETE_CLIENT')
  remove(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    const companyId = this.assertTenantCompany(user);
    return this.clientsService.remove(id, companyId, user.id);
  }
}
