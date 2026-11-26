import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { CompanyEmailChannel } from '../models/company-email-channel.model';
import { Company, CompanyStatus } from '../../companies/company.model';
import { Users, UserStatus } from '../../users/users.model';
import { ChannelsService } from './channels.service';
import { ImapClientService } from './imap-client.service';
import { decryptFtpSecret } from '../../../common/utils/vault-crypto.util';

interface IdleWatcherEntry {
  channelId: number;
  userId: number | null;
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
    @Optional()
    @InjectModel(Users)
    private readonly usersModel?: typeof Users,
  ) {}

  onModuleInit(): void {
    this.channelsService.registerChannelChangeListener((channelId) => {
      this.restartIdleWatcher(channelId).catch(() => {});
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
    for (const channelId of Array.from(this.idleWatchers.keys())) {
      this.stopIdleWatcher(channelId);
    }
  }

  stopIdleWatchersForUser(userId: number): void {
    for (const [channelId, entry] of this.idleWatchers.entries()) {
      if (entry.userId === userId) {
        this.stopIdleWatcher(channelId);
      }
    }
  }

  private stopIdleWatcher(channelId: number): void {
    const entry = this.idleWatchers.get(channelId);
    if (!entry) return;
    entry.stopped = true;
    entry.abortController.abort();
    this.idleWatchers.delete(channelId);
  }

  private async isChannelEligible(ch: CompanyEmailChannel): Promise<boolean> {
    if (!ch || !ch.isActive || !ch.host || !ch.encryptedPassword) return false;
    const company = await this.companyModel.findByPk(ch.companyId, {
      attributes: ['id', 'status', 'enabledModules'],
    });
    const modules = Array.isArray(company?.enabledModules)
      ? company.enabledModules
      : [];
    if (!company || company.status !== CompanyStatus.ACTIVE || !modules.includes('email')) {
      return false;
    }
    if (ch.userId && this.usersModel) {
      const owner = await this.usersModel.findByPk(ch.userId, {
        attributes: ['id', 'status'],
      });
      if (!owner || owner.status === UserStatus.INACTIVE || owner.status === UserStatus.SUSPENDED) {
        return false;
      }
    }
    return true;
  }

  private async restartIdleWatcher(channelId: number): Promise<void> {
    this.stopIdleWatcher(channelId);

    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_EMAIL_SCHEDULER === 'true'
    ) {
      return;
    }

    const channel = await this.emailChannelModel.findByPk(channelId);
    if (!channel || !(await this.isChannelEligible(channel))) {
      return;
    }

    this.startIdleWatcher(channel.id, channel.userId ?? null);
  }

  private startIdleWatcher(channelId: number, userId: number | null): void {
    if (this.idleWatchers.has(channelId)) return;

    const entry: IdleWatcherEntry = {
      channelId,
      userId,
      abortController: new AbortController(),
      stopped: false,
    };
    this.idleWatchers.set(channelId, entry);

    this.runIdleLoop(channelId, entry).catch((err) => {
      this.logger.warn(
        `[EmailIDLE channel_${channelId}] Listener detenido: ${err?.message}`,
      );
    });
  }

  private async runIdleLoop(
    channelId: number,
    entry: IdleWatcherEntry,
  ): Promise<void> {
    let errorStreak = 0;

    while (!entry.stopped) {
      try {
        const channel = await this.emailChannelModel.findByPk(channelId);
        if (!channel || !channel.isActive || !channel.host || !channel.encryptedPassword) {
          this.stopIdleWatcher(channelId);
          return;
        }

        const plainPassword = decryptFtpSecret(channel.encryptedPassword);
        // Al conectar IDLE, hacer una revisión inicial rápida por si entraron correos antes
        await this.channelsService
          .syncCompanyEmailChannel(channel.companyId, channel.userId ?? null, channel.id)
          .catch(() => {});

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
            await this.channelsService.syncCompanyEmailChannel(
              channel.companyId,
              channel.userId ?? null,
              channel.id,
            );
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
          `[EmailIDLE channel_${channelId}] Reconexión en ${backoffMs}ms: ${err?.message}`,
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
        if (await this.isChannelEligible(ch)) {
          activeEligible.add(ch.id);
          this.startIdleWatcher(ch.id, ch.userId ?? null);
        }
      }

      for (const runningChannelId of Array.from(this.idleWatchers.keys())) {
        if (!activeEligible.has(runningChannelId)) {
          this.stopIdleWatcher(runningChannelId);
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
        if (!(await this.isChannelEligible(ch))) continue;
        const intervalMs = Math.max(1, Number(ch.syncIntervalMinutes || 5)) * 60 * 1000;
        const lastMs = ch.lastSyncAt ? new Date(ch.lastSyncAt).getTime() : 0;

        if (!ch.lastSyncAt || nowMs - lastMs >= intervalMs) {
          try {
            await this.channelsService.syncCompanyEmailChannel(
              ch.companyId,
              ch.userId ?? null,
              ch.id,
            );
          } catch (err: any) {
            this.logger.warn(
              `[EmailScheduler] Falló sync automático canal #${ch.id}: ${err?.message}`,
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
