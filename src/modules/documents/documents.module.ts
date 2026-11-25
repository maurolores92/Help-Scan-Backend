import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Document } from './document.model';
import { DocumentTypeForm } from './models/document-type-form.model';
import { DocumentFormRecord } from './models/document-form-record.model';
import { Company } from '../companies/company.model';
import { FtpDevice } from '../ftp-devices/ftp-device.model';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentAiExtractorService } from './services/document-ai-extractor.service';
import { DocumentDueAlertsService } from './services/document-due-alerts.service';
import { DocumentExportService } from './services/document-export.service';
import { DocumentFiscalChecksService } from './services/document-fiscal-checks.service';
import { DocumentFormsService } from './services/document-forms.service';
import { DocumentProcessingQueueService } from './services/document-processing-queue.service';
import { DocumentUploadQueueService } from './services/document-upload-queue.service';
import { TenantInboxWatcherService } from './services/tenant-inbox-watcher.service';
import { AuditModule } from '../audit/audit.module';
import { ClientsModule } from '../clients/clients.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    SequelizeModule.forFeature([
      Document,
      DocumentTypeForm,
      DocumentFormRecord,
      Company,
      FtpDevice,
    ]),
    AuditModule,
    ClientsModule,
    NotificationsModule,
    PlansModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentAiExtractorService,
    DocumentFiscalChecksService,
    DocumentFormsService,
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
    DocumentFormsService,
    TenantInboxWatcherService,
    DocumentProcessingQueueService,
    DocumentUploadQueueService,
    SequelizeModule,
  ],
})
export class DocumentsModule {}
