import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { DemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';
import { DemoRequest } from './demo-request.model';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [SequelizeModule.forFeature([DemoRequest]), AuditModule],
  controllers: [DemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
