import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Document } from './document.model';
import { Company } from '../companies/company.model';
import { FtpDevice } from '../ftp-devices/ftp-device.model';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentAiExtractorService } from './services/document-ai-extractor.service';
import { DocumentDueAlertsService } from './services/document-due-alerts.service';
import { DocumentExportService } from './services/document-export.service';
import { DocumentFiscalChecksService } from './services/document-fiscal-checks.service';
import { DocumentProcessingQueueService } from './services/document-processing-queue.service';
import { DocumentUploadQueueService } from './services/document-upload-queue.service';
import { TenantInboxWatcherService } from './services/tenant-inbox-watcher.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Document, Company, FtpDevice]),
    AuditModule,
    NotificationsModule,
    PlansModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentAiExtractorService,
    DocumentFiscalChecksService,
    DocumentDueAlertsService,
    DocumentExportService,
    DocumentProcessingQueueService,
    DocumentUploadQueueService,
    TenantInboxWatcherService,
    DocumentsService,
  ],
  exports: [
    DocumentsService,
    DocumentFiscalChecksService,
    TenantInboxWatcherService,
    DocumentProcessingQueueService,
    DocumentUploadQueueService,
    SequelizeModule,
  ],
})
export class DocumentsModule {}
