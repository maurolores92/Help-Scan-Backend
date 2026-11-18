import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle } from '@nestjs/throttler';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CreateFtpDeviceDto } from './dto/create-ftp-device.dto';
import type { SftpGoWebhookPayload } from './dto/sftpgo-webhook.dto';
import { UpdateFtpDeviceDto } from './dto/update-ftp-device.dto';
import { FtpDevicesService } from './ftp-devices.service';

/**
 * @controller FtpDevicesController
 * Gestión multi-tenant de impresoras HP (ej. HP LaserJet Managed E52645) y sus
 * credenciales virtuales aisladas SFTP/FTPS/FTP sincronizadas con SFTPGo.
 */
@Controller('ftp-devices')
export class FtpDevicesController {
  constructor(private readonly ftpDevicesService: FtpDevicesService) {}

  @Get()
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('VIEW_FTP_DEVICES')
  async findAll(
    @GetUser() user: any,
    @Query('companyId') companyId?: string,
  ) {
    const parsedCompanyId = companyId ? Number(companyId) : undefined;
    return this.ftpDevicesService.findAll(
      user,
      Number.isInteger(parsedCompanyId) && (parsedCompanyId ?? 0) > 0
        ? parsedCompanyId
        : undefined,
    );
  }

  @Get(':id/credentials')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async getCredentials(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.ftpDevicesService.getCredentials(id, user);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async create(@Body() dto: CreateFtpDeviceDto, @GetUser() user: any) {
    return this.ftpDevicesService.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFtpDeviceDto,
    @GetUser() user: any,
  ) {
    return this.ftpDevicesService.update(id, dto, user);
  }

  @Post(':id/sync')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async retrySync(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    return this.ftpDevicesService.retrySync(id, user);
  }

  @Post(':id/scan-inbox')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async scanDeviceInbox(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.ftpDevicesService.scanDeviceInbox(id, user);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @RequirePermission('MANAGE_FTP_DEVICES')
  async remove(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    return this.ftpDevicesService.remove(id, user);
  }

  /**
   * Endpoint interno llamado exclusivamente por el contenedor SFTPGo cuando
   * finaliza una subida de PDF desde una impresora HP.
   */
  @Post('internal/sftpgo-webhook')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async handleSftpGoWebhook(
    @Headers('x-sftpgo-webhook-secret') headerSecret: string | undefined,
    @Query('secret') querySecret: string | undefined,
    @Body() payload: SftpGoWebhookPayload,
  ) {
    return this.ftpDevicesService.handleSftpGoWebhook(
      headerSecret,
      querySecret,
      payload,
    );
  }
}
