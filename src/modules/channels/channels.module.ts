import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { CompanyEmailChannel } from './models/company-email-channel.model';
import { EmailMessage } from './models/email-message.model';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './services/channels.service';
import { ImapClientService } from './services/imap-client.service';
import { EmailIngestionSchedulerService } from './services/email-ingestion-scheduler.service';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    SequelizeModule.forFeature([CompanyEmailChannel, EmailMessage]),
    DocumentsModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [ChannelsController],
  providers: [
    ImapClientService,
    ChannelsService,
    EmailIngestionSchedulerService,
  ],
  exports: [ChannelsService],
})
export class ChannelsModule {}
