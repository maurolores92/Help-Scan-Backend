import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuditModule } from '../audit/audit.module';
import { Company } from '../companies/company.model';
import { DocumentsModule } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';
import { FtpDevice } from './ftp-device.model';
import { FtpDevicesController } from './ftp-devices.controller';
import { FtpDevicesService } from './ftp-devices.service';
import { SftpGoClientService } from './services/sftpgo-client.service';

@Module({
  imports: [
    SequelizeModule.forFeature([FtpDevice, Company]),
    AuditModule,
    NotificationsModule,
    PlansModule,
    DocumentsModule,
  ],
  controllers: [FtpDevicesController],
  providers: [FtpDevicesService, SftpGoClientService],
  exports: [FtpDevicesService],
})
export class FtpDevicesModule {}

