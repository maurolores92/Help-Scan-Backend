import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { CompanyEmailChannel } from './models/company-email-channel.model';
import { EmailMessage } from './models/email-message.model';
import { CompanyWhatsappChannel } from './models/company-whatsapp-channel.model';
import { WhatsappMessage } from './models/whatsapp-message.model';
import { CompanyTelegramChannel } from './models/company-telegram-channel.model';
import { TelegramMessage } from './models/telegram-message.model';
import { Company } from '../companies/company.model';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './services/channels.service';
import { ImapClientService } from './services/imap-client.service';
import { EmailIngestionSchedulerService } from './services/email-ingestion-scheduler.service';
import { WhatsappBaileysService } from './services/whatsapp-baileys.service';
import { WhatsappChannelService } from './services/whatsapp-channel.service';
import { TelegramBotClientService } from './services/telegram-bot-client.service';
import { TelegramChannelService } from './services/telegram-channel.service';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    SequelizeModule.forFeature([
      CompanyEmailChannel,
      EmailMessage,
      CompanyWhatsappChannel,
      WhatsappMessage,
      CompanyTelegramChannel,
      TelegramMessage,
      Company,
    ]),
    DocumentsModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [ChannelsController],
  providers: [
    ImapClientService,
    ChannelsService,
    EmailIngestionSchedulerService,
    WhatsappBaileysService,
    WhatsappChannelService,
    TelegramBotClientService,
    TelegramChannelService,
  ],
  exports: [ChannelsService, WhatsappChannelService, TelegramChannelService],
})
export class ChannelsModule {}
