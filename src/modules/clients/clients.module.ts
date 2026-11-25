import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Client } from './client.model';
import { Document } from '../documents/document.model';
import { DocumentLink } from '../documents/models/document-link.model';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Client, Document, DocumentLink]),
    AuditModule,
    NotificationsModule,
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [SequelizeModule, ClientsService],
})
export class ClientsModule {}
