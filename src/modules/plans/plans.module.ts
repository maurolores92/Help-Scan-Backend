import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Plan } from './plan.model';
import { CompanyMonthlyUsage } from './models/company-monthly-usage.model';
import { PlanExchangeConfig } from './models/plan-exchange-config.model';
import { Company } from '../companies/company.model';
import { Users } from '../users/users.model';
import { Document } from '../documents/document.model';
import { FtpDevice } from '../ftp-devices/ftp-device.model';
import { CompanyEmailChannel } from '../channels/models/company-email-channel.model';
import { CompanyWhatsappChannel } from '../channels/models/company-whatsapp-channel.model';
import { CompanyTelegramChannel } from '../channels/models/company-telegram-channel.model';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansService } from './plans.service';
import { CompanyQuotaSummaryService } from './services/company-quota-summary.service';
import { TenantQuotasService } from './services/tenant-quotas.service';
import { ExchangeRateService } from './services/exchange-rate.service';
import { AiQuotaGuard } from './guards/ai-quota.guard';
import { PlansController } from './plans.controller';

@Module({
  imports: [
    SequelizeModule.forFeature([
      Plan,
      PlanExchangeConfig,
      CompanyMonthlyUsage,
      Company,
      Users,
      Document,
      FtpDevice,
      CompanyEmailChannel,
      CompanyWhatsappChannel,
      CompanyTelegramChannel,
    ]),
    AuditModule,
    NotificationsModule,
  ],
  controllers: [PlansController],
  providers: [
    PlansService,
    CompanyQuotaSummaryService,
    TenantQuotasService,
    AiQuotaGuard,
    ExchangeRateService,
  ],
  exports: [
    SequelizeModule,
    PlansService,
    CompanyQuotaSummaryService,
    TenantQuotasService,
    AiQuotaGuard,
    ExchangeRateService,
  ],
})
export class PlansModule {}
