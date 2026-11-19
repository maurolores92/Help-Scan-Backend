import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { CompanyEmailChannel } from '../models/company-email-channel.model';
import { ChannelsService } from './channels.service';

@Injectable()
export class EmailIngestionSchedulerService {
  private readonly logger = new Logger(EmailIngestionSchedulerService.name);
  private isTickRunning = false;

  constructor(
    @InjectModel(CompanyEmailChannel)
    private readonly emailChannelModel: typeof CompanyEmailChannel,
    private readonly channelsService: ChannelsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handlePeriodicEmailSync() {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_EMAIL_SCHEDULER === 'true' ||
      this.isTickRunning
    ) {
      return;
    }

    this.isTickRunning = true;
    try {
      const activeChannels = await this.emailChannelModel.findAll({
        where: { isActive: true },
      });

      if (activeChannels.length === 0) {
        return;
      }

      const nowMs = Date.now();

      for (const ch of activeChannels) {
        const intervalMs = Math.max(1, Number(ch.syncIntervalMinutes || 5)) * 60 * 1000;
        const lastMs = ch.lastSyncAt ? new Date(ch.lastSyncAt).getTime() : 0;

        if (!ch.lastSyncAt || nowMs - lastMs >= intervalMs) {
          try {
            await this.channelsService.syncCompanyEmailChannel(ch.companyId, null);
          } catch (err: any) {
            this.logger.warn(
              `[EmailScheduler] Falló sync automático compañía #${ch.companyId}: ${err?.message}`,
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`[EmailScheduler] Error en ciclo periódico: ${err?.message}`);
    } finally {
      this.isTickRunning = false;
    }
  }
}
