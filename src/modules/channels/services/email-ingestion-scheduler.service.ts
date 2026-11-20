import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { CompanyEmailChannel } from '../models/company-email-channel.model';
import { Company, CompanyStatus } from '../../companies/company.model';
import { ChannelsService } from './channels.service';
import { ImapClientService } from './imap-client.service';
import { decryptFtpSecret } from '../../../common/utils/vault-crypto.util';

interface IdleWatcherEntry {
  abortController: AbortController;
  stopped: boolean;
}

@Injectable()
export class EmailIngestionSchedulerService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EmailIngestionSchedulerService.name);
  private isTickRunning = false;
  private readonly idleWatchers = new Map<number, IdleWatcherEntry>();

  constructor(
    @InjectModel(CompanyEmailChannel)
    private readonly emailChannelModel: typeof CompanyEmailChannel,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly channelsService: ChannelsService,
    private readonly imapClient: ImapClientService,
  ) {}

  onModuleInit(): void {
    this.channelsService.registerChannelChangeListener((companyId) => {
      this.restartIdleWatcher(companyId).catch(() => {});
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_EMAIL_SCHEDULER === 'true'
    ) {
      return;
    }

    await this.reconcileIdleWatchers();
  }

  onModuleDestroy(): void {
    for (const companyId of Array.from(this.idleWatchers.keys())) {
      this.stopIdleWatcher(companyId);
    }
  }

  private stopIdleWatcher(companyId: number): void {
    const entry = this.idleWatchers.get(companyId);
    if (!entry) return;
    entry.stopped = true;
    entry.abortController.abort();
    this.idleWatchers.delete(companyId);
  }

  private async restartIdleWatcher(companyId: number): Promise<void> {
    this.stopIdleWatcher(companyId);

    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_EMAIL_SCHEDULER === 'true'
    ) {
      return;
    }

    const channel = await this.emailChannelModel.findOne({ where: { companyId } });
    if (!channel || !channel.isActive || !channel.host || !channel.encryptedPassword) {
      return;
    }

    const company = await this.companyModel.findByPk(companyId, {
      attributes: ['id', 'status', 'enabledModules'],
    });
    const modules = Array.isArray(company?.enabledModules)
      ? company.enabledModules
      : [];
    if (!company || company.status !== CompanyStatus.ACTIVE || !modules.includes('email')) {
      return;
    }

    this.startIdleWatcher(companyId);
  }

  private startIdleWatcher(companyId: number): void {
    if (this.idleWatchers.has(companyId)) return;

    const entry: IdleWatcherEntry = {
      abortController: new AbortController(),
      stopped: false,
    };
    this.idleWatchers.set(companyId, entry);

    this.runIdleLoop(companyId, entry).catch((err) => {
      this.logger.warn(
        `[EmailIDLE company_${companyId}] Listener detenido: ${err?.message}`,
      );
    });
  }

  private async runIdleLoop(
    companyId: number,
    entry: IdleWatcherEntry,
  ): Promise<void> {
    let errorStreak = 0;

    while (!entry.stopped) {
      try {
        const channel = await this.emailChannelModel.findOne({ where: { companyId } });
        if (!channel || !channel.isActive || !channel.host || !channel.encryptedPassword) {
          this.stopIdleWatcher(companyId);
          return;
        }

        const plainPassword = decryptFtpSecret(channel.encryptedPassword);
        // Al conectar IDLE, hacer una revisión inicial rápida por si entraron correos antes
        await this.channelsService.syncCompanyEmailChannel(companyId, null).catch(() => {});

        errorStreak = 0;
        await this.imapClient.watchMailboxIdle(
          {
            host: channel.host,
            port: channel.port,
            secure: channel.secure,
            emailUser: channel.emailUser,
            password: plainPassword,
            folder: channel.folder,
          },
          async () => {
            await this.channelsService.syncCompanyEmailChannel(companyId, null);
          },
          entry.abortController.signal,
        );
      } catch (err: any) {
        if (entry.stopped || entry.abortController.signal.aborted) {
          return;
        }
        errorStreak++;
        const backoffMs = Math.min(60000, errorStreak * 5000);
        this.logger.warn(
          `[EmailIDLE company_${companyId}] Reconexión en ${backoffMs}ms: ${err?.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async reconcileIdleWatchers(): Promise<void> {
    try {
      const channels = await this.emailChannelModel.findAll({
        where: { isActive: true },
      });

      const activeEligible = new Set<number>();
      for (const ch of channels) {
        if (!ch.host || !ch.encryptedPassword) continue;
        const company = await this.companyModel.findByPk(ch.companyId, {
          attributes: ['id', 'status', 'enabledModules'],
        });
        const modules = Array.isArray(company?.enabledModules)
          ? company.enabledModules
          : [];
        if (company && company.status === CompanyStatus.ACTIVE && modules.includes('email')) {
          activeEligible.add(ch.companyId);
          this.startIdleWatcher(ch.companyId);
        }
      }

      for (const runningCompanyId of Array.from(this.idleWatchers.keys())) {
        if (!activeEligible.has(runningCompanyId)) {
          this.stopIdleWatcher(runningCompanyId);
        }
      }
    } catch (err: any) {
      this.logger.warn(`[EmailIDLE] Error reconciliando listeners: ${err?.message}`);
    }
  }

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
      await this.reconcileIdleWatchers();

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
