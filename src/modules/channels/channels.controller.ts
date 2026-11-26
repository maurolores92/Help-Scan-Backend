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
import { UpsertTelegramChannelDto } from './dto/upsert-telegram-channel.dto';
import { TestTelegramConnectionDto } from './dto/test-telegram-connection.dto';
import { QueryTelegramMessagesDto } from './dto/query-telegram-messages.dto';
import { ChannelsService } from './services/channels.service';
import { WhatsappChannelService } from './services/whatsapp-channel.service';
import { TelegramChannelService } from './services/telegram-channel.service';

@Controller('channels')
@UseGuards(AuthGuard('jwt'), PermissionsGuard, TenantModuleGuard)
export class ChannelsController {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly whatsappChannelService: WhatsappChannelService,
    private readonly telegramChannelService: TelegramChannelService,
  ) {}

  @Get('users-overview')
  @RequirePermission(
    'VIEW_CHANNELS',
    'MANAGE_CHANNELS',
    'VIEW_USERS',
    'MANAGE_OWN_EMAIL',
    'MANAGE_OWN_WHATSAPP',
    'MANAGE_OWN_TELEGRAM',
  )
  async getUsersChannelsOverview(@GetUser() user: any) {
    return this.channelsService.getCompanyUsersChannelsOverview(user);
  }

  // =========================================================================
  // CANAL EMAIL (IMAP)
  // =========================================================================

  @Get('email')
  @RequireTenantModule('email')
  @RequirePermission('VIEW_CHANNELS', 'MANAGE_CHANNELS', 'MANAGE_OWN_EMAIL', 'VIEW_EMAIL_INBOX')
  async getEmailConfig(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.channelsService.getEmailChannelConfig(user, targetUserId);
  }

  @Post('email')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_EMAIL')
  async upsertEmailConfig(
    @Body() dto: UpsertEmailChannelDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.channelsService.upsertEmailChannelConfig(dto, user, targetUserId);
  }

  @Post('email/test')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_EMAIL')
  async testEmailConnection(
    @Body() dto: TestEmailConnectionDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.channelsService.testEmailConnection(dto, user, targetUserId);
  }

  @Post('email/sync')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_EMAIL')
  async syncEmailNow(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.channelsService.triggerManualSync(user, targetUserId);
  }

  @Post('email/webhook-secret')
  @RequireTenantModule('email')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_EMAIL')
  async regenerateEmailWebhookSecret(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.channelsService.regenerateWebhookSecret(user, targetUserId);
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
  @RequirePermission('VIEW_CHANNELS', 'MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP', 'VIEW_WHATSAPP_INBOX')
  async getWhatsappConfig(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.getStatusAndConfig(user, targetUserId);
  }

  @Get('whatsapp/groups')
  @RequireTenantModule('whatsapp')
  @RequirePermission('VIEW_CHANNELS', 'MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP', 'VIEW_WHATSAPP_INBOX')
  async listWhatsappGroups(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.listGroups(user, targetUserId);
  }

  @Post('whatsapp/connect')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP')
  async connectWhatsappQr(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.connectQr(user, targetUserId);
  }

  @Post('whatsapp/disconnect')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP')
  async disconnectWhatsapp(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.disconnect(user, targetUserId);
  }

  @Patch('whatsapp/settings')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP')
  async updateWhatsappSettings(
    @Body() dto: UpsertWhatsappChannelDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.upsertSettings(dto, user, targetUserId);
  }

  @Post('whatsapp/settings')
  @RequireTenantModule('whatsapp')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_WHATSAPP')
  async saveWhatsappSettings(
    @Body() dto: UpsertWhatsappChannelDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.whatsappChannelService.upsertSettings(dto, user, targetUserId);
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

  // =========================================================================
  // CANAL TELEGRAM BOT PROPIO POR USUARIO (@BotFather)
  // =========================================================================

  @Get('telegram')
  @RequireTenantModule('telegram')
  @RequirePermission('VIEW_CHANNELS', 'MANAGE_CHANNELS', 'MANAGE_OWN_TELEGRAM', 'VIEW_TELEGRAM_INBOX')
  async getTelegramConfig(
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.telegramChannelService.getChannelConfig(user, targetUserId);
  }

  @Post('telegram')
  @RequireTenantModule('telegram')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_TELEGRAM')
  async upsertTelegramConfig(
    @Body() dto: UpsertTelegramChannelDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.telegramChannelService.upsertChannelConfig(dto, user, targetUserId);
  }

  @Post('telegram/test')
  @RequireTenantModule('telegram')
  @RequirePermission('MANAGE_CHANNELS', 'MANAGE_OWN_TELEGRAM')
  async testTelegramConnection(
    @Body() dto: TestTelegramConnectionDto,
    @GetUser() user: any,
    @Query('userId') targetUserId?: string,
  ) {
    return this.telegramChannelService.testConnection(dto, user, targetUserId);
  }

  @Get('telegram/messages')
  @RequireTenantModule('telegram')
  @RequirePermission('VIEW_TELEGRAM_INBOX')
  async listTelegramMessages(
    @Query() query: QueryTelegramMessagesDto,
    @GetUser() user: any,
  ) {
    return this.telegramChannelService.listMessages(query, user);
  }
}
