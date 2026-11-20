import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequireTenantModule } from '../../common/decorators/require-tenant-module.decorator';
import { TenantModuleGuard } from '../../common/guards/tenant-module.guard';
import { UpsertEmailChannelDto } from './dto/upsert-email-channel.dto';
import { TestEmailConnectionDto } from './dto/test-email-connection.dto';
import { QueryEmailMessagesDto } from './dto/query-email-messages.dto';
import { UpsertWhatsappChannelDto } from './dto/upsert-whatsapp-channel.dto';
import { QueryWhatsappMessagesDto } from './dto/query-whatsapp-messages.dto';
import { ChannelsService } from './services/channels.service';
import { WhatsappChannelService } from './services/whatsapp-channel.service';

@Controller('channels')
@UseGuards(AuthGuard('jwt'), PermissionsGuard, TenantModuleGuard)
export class ChannelsController {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly whatsappChannelService: WhatsappChannelService,
  ) {}

  // =========================================================================
  // CANAL EMAIL (IMAP)
  // =========================================================================

  @Get('email')
  @RequireTenantModule('email')
  @RequirePermission('VIEW_CHANNELS')
  async getEmailConfig(@GetUser() user: any) {
    return this.channelsService.getEmailChannelConfig(user);
  }

  @Post('email')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS')
  async upsertEmailConfig(
    @Body() dto: UpsertEmailChannelDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.upsertEmailChannelConfig(dto, user);
  }

  @Post('email/test')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS')
  async testEmailConnection(
    @Body() dto: TestEmailConnectionDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.testEmailConnection(dto, user);
  }

  @Post('email/sync')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS')
  async syncEmailNow(@GetUser() user: any) {
    return this.channelsService.triggerManualSync(user);
  }

  @Get('emails')
  @RequireTenantModule('email')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async listEmails(
    @Query() query: QueryEmailMessagesDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.listEmailMessages(query, user);
  }

  @Get('emails/:id')
  @RequireTenantModule('email')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async getEmailDetail(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.channelsService.getEmailMessageById(id, user);
  }

  @Post('emails/:id/rescue')
  @RequireTenantModule('email')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async rescueEmail(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.channelsService.rescueEmailMessageToDocument(id, user);
  }

  // =========================================================================
  // CANAL WHATSAPP QR DIRECTO (BAILEYS MULTITENANT)
  // =========================================================================

  @Get('whatsapp')
  @RequireTenantModule('whatsapp')
  @RequirePermission('VIEW_CHANNELS')
  async getWhatsappConfig(@GetUser() user: any) {
    return this.whatsappChannelService.getStatusAndConfig(user);
  }

  @Post('whatsapp/connect')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS')
  async connectWhatsappQr(@GetUser() user: any) {
    return this.whatsappChannelService.connectQr(user);
  }

  @Post('whatsapp/disconnect')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS')
  async disconnectWhatsapp(@GetUser() user: any) {
    return this.whatsappChannelService.disconnect(user);
  }

  @Patch('whatsapp/settings')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS')
  async updateWhatsappSettings(
    @Body() dto: UpsertWhatsappChannelDto,
    @GetUser() user: any,
  ) {
    return this.whatsappChannelService.upsertSettings(dto, user);
  }

  @Post('whatsapp/settings')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS')
  async saveWhatsappSettings(
    @Body() dto: UpsertWhatsappChannelDto,
    @GetUser() user: any,
  ) {
    return this.whatsappChannelService.upsertSettings(dto, user);
  }

  @Get('whatsapp/messages')
  @RequireTenantModule('whatsapp')
  @RequirePermission('VIEW_WHATSAPP_INBOX')
  async listWhatsappMessages(
    @Query() query: QueryWhatsappMessagesDto,
    @GetUser() user: any,
  ) {
    return this.whatsappChannelService.listMessages(query, user);
  }
}
