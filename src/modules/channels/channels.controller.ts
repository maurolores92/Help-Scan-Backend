import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { UpsertEmailChannelDto } from './dto/upsert-email-channel.dto';
import { TestEmailConnectionDto } from './dto/test-email-connection.dto';
import { QueryEmailMessagesDto } from './dto/query-email-messages.dto';
import { ChannelsService } from './services/channels.service';

@Controller('channels')
@UseGuards(AuthGuard('jwt'), PermissionsGuard)
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get('email')
  @RequirePermission('VIEW_CHANNELS')
  async getEmailConfig(@GetUser() user: any) {
    return this.channelsService.getEmailChannelConfig(user);
  }

  @Post('email')
  @RequirePermission('MANAGE_CHANNELS')
  async upsertEmailConfig(
    @Body() dto: UpsertEmailChannelDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.upsertEmailChannelConfig(dto, user);
  }

  @Post('email/test')
  @RequirePermission('MANAGE_CHANNELS')
  async testEmailConnection(
    @Body() dto: TestEmailConnectionDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.testEmailConnection(dto, user);
  }

  @Post('email/sync')
  @RequirePermission('MANAGE_CHANNELS')
  async syncEmailNow(@GetUser() user: any) {
    return this.channelsService.triggerManualSync(user);
  }

  @Get('emails')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async listEmails(
    @Query() query: QueryEmailMessagesDto,
    @GetUser() user: any,
  ) {
    return this.channelsService.listEmailMessages(query, user);
  }

  @Get('emails/:id')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async getEmailDetail(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.channelsService.getEmailMessageById(id, user);
  }

  @Post('emails/:id/rescue')
  @RequirePermission('VIEW_EMAIL_INBOX')
  async rescueEmail(
    @Param('id', ParseIntPipe) id: number,
    @GetUser() user: any,
  ) {
    return this.channelsService.rescueEmailMessageToDocument(id, user);
  }
}
