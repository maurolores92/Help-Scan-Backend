import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as crypto from 'crypto';
import { Op } from 'sequelize';
import {
  CompanyTelegramChannel,
  TelegramSenderPolicy,
  TelegramSyncStatus,
} from '../models/company-telegram-channel.model';
import {
  TelegramMessage,
  TelegramMessageStatus,
} from '../models/telegram-message.model';
import { UpsertTelegramChannelDto } from '../dto/upsert-telegram-channel.dto';
import { TestTelegramConnectionDto } from '../dto/test-telegram-connection.dto';
import { QueryTelegramMessagesDto } from '../dto/query-telegram-messages.dto';
import { TelegramBotClientService } from './telegram-bot-client.service';
import { DocumentsService } from '../../documents/documents.service';
import { Document, DocumentSource } from '../../documents/document.model';
import { DocumentProcessingQueueService } from '../../documents/services/document-processing-queue.service';
import { Company, CompanyStatus } from '../../companies/company.model';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationsGateway } from '../../notifications/notifications.gateway';
import {
  decryptFtpSecret,
  encryptFtpSecret,
} from '../../../common/utils/vault-crypto.util';
import { isPlatformSuperAdmin } from '../../../common/utils/tenant-scope.util';
import { Users, UserStatus } from '../../users/users.model';
import {
  resolveChannelOwnerContext,
  resolveInboxFilterUserId,
} from '../helpers/channel-user-scope.helper';
import { convertImageBufferToPdf } from '../helpers/email-pdf-synthesizer.helper';
import {
  buildDuplicateNoticeMessage,
  buildIngestErrorMessage,
  buildOcrCompletedMessage,
  buildReceiptAckMessage,
} from '../helpers/channel-reply-formatter.helper';

export function normalizeTelegramIdentifier(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

interface PollingWorkerState {
  abortController: AbortController;
  stopped: boolean;
}

@Injectable()
export class TelegramChannelService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramChannelService.name);
  private readonly pollingWorkers = new Map<number, PollingWorkerState>();
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(CompanyTelegramChannel)
    private readonly telegramChannelModel: typeof CompanyTelegramChannel,
    @InjectModel(TelegramMessage)
    private readonly telegramMessageModel: typeof TelegramMessage,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly botClient: TelegramBotClientService,
    private readonly documentsService: DocumentsService,
    private readonly processingQueue: DocumentProcessingQueueService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly gateway?: NotificationsGateway,
    @Optional()
    @InjectModel(Users)
    private readonly usersModel?: typeof Users,
  ) {}

  onModuleInit(): void {
    this.processingQueue.registerPostProcessHook(async (doc) => {
      if (doc.source !== DocumentSource.TELEGRAM) return;
      await this.handleDocumentProcessedAutoReply(doc);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_TELEGRAM_BOT === 'true'
    ) {
      return;
    }

    try {
      await this.reconcileActiveBots();
      this.reconcileTimer = setInterval(() => {
        this.reconcileActiveBots().catch(() => {});
      }, 60_000);
    } catch (err: any) {
      this.logger.warn(
        `[Telegram] No se pudieron iniciar bots al arrancar: ${err?.message}`,
      );
    }
  }

  async reconcileActiveBots(): Promise<void> {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_TELEGRAM_BOT === 'true'
    ) {
      return;
    }

    try {
      const activeChannels = await this.telegramChannelModel.findAll({
        where: { isActive: true },
      });

      const activeEligible = new Set<number>();
      for (const ch of activeChannels) {
        const company = await this.companyModel.findByPk(ch.companyId, {
          attributes: ['id', 'status', 'enabledModules'],
        });
        const modules = Array.isArray(company?.enabledModules)
          ? company.enabledModules
          : [];

        let ownerActive = true;
        if (this.usersModel && ch.userId) {
          const owner = await this.usersModel.findByPk(ch.userId, {
            attributes: ['id', 'status'],
          });
          ownerActive = Boolean(owner && owner.status === UserStatus.ACTIVE);
        }

        if (
          company &&
          company.status === CompanyStatus.ACTIVE &&
          modules.includes('telegram') &&
          ownerActive
        ) {
          activeEligible.add(ch.id);
          this.startPollingForChannel(ch.id);
        }
      }

      for (const runningId of Array.from(this.pollingWorkers.keys())) {
        if (!activeEligible.has(runningId)) {
          this.stopPollingForChannel(runningId);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `[Telegram] Error reconciliando bots activos: ${err?.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const channelId of Array.from(this.pollingWorkers.keys())) {
      this.stopPollingForChannel(channelId);
    }
  }

  async stopPollingForUser(userId: number): Promise<void> {
    const channels = await this.telegramChannelModel.findAll({
      where: { userId },
      attributes: ['id'],
    });
    for (const ch of channels) {
      this.stopPollingForChannel(ch.id);
    }
  }

  private assertTenantUser(user: {
    companyId?: number | null;
    role?: string;
  }): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no gestiona bots privados de Telegram de compañías.',
      );
    }
    const companyId = Number(user?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new ForbiddenException(
        'Acceso denegado: Se requiere pertenecer a una compañía activa.',
      );
    }
    return companyId;
  }

  private toSafeChannelResponse(
    channel: CompanyTelegramChannel | null,
    targetUserId?: number | null,
  ) {
    if (!channel) {
      return {
        configured: false,
        targetUserId: targetUserId ?? null,
        channel: null,
      };
    }

    const plain = channel.toJSON() as any;
    const hasBotToken = Boolean(plain.encryptedBotToken);
    delete plain.encryptedBotToken;
    delete plain.botTokenHash;

    return {
      configured: true,
      targetUserId: channel.userId ?? targetUserId ?? null,
      channel: {
        ...plain,
        hasBotToken,
        isPollingActive: this.pollingWorkers.has(channel.id),
      },
    };
  }

  async getChannelConfig(user: any, requestedUserId?: number | string | null) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.telegramChannelModel.findOne({
      where: { companyId: owner.companyId, userId: owner.userId },
    });
    return this.toSafeChannelResponse(channel, owner.userId);
  }

  async testConnection(
    dto: TestTelegramConnectionDto,
    user: any,
    requestedUserId?: number | string | null,
  ) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    let plainToken = dto.botToken?.trim() || '';

    if (!plainToken) {
      const existing = await this.telegramChannelModel.findOne({
        where: { companyId: owner.companyId, userId: owner.userId },
      });
      if (!existing?.encryptedBotToken) {
        throw new BadRequestException(
          'Ingresá el Bot Token generado en @BotFather para probar la conexión.',
        );
      }
      plainToken = decryptFtpSecret(existing.encryptedBotToken);
    }

    try {
      const info = await this.botClient.getMe(plainToken);
      const existing = await this.telegramChannelModel.findOne({
        where: { companyId: owner.companyId, userId: owner.userId },
      });
      if (existing) {
        await existing.update({
          botUsername: info.botUsername,
          botDisplayName: info.botDisplayName,
          lastSyncStatus: TelegramSyncStatus.OK,
          lastSyncMessage: info.message,
        });
      }
      return info;
    } catch (err: any) {
      throw new BadRequestException(
        err?.message || 'No se pudo conectar con Telegram Bot API',
      );
    }
  }

  async upsertChannelConfig(
    dto: UpsertTelegramChannelDto,
    user: any,
    requestedUserId?: number | string | null,
  ) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const existing = await this.telegramChannelModel.findOne({
      where: { companyId: owner.companyId, userId: owner.userId },
    });

    let plainToken = dto.botToken?.trim() || '';
    let encryptedBotToken = existing?.encryptedBotToken || '';
    let botTokenHash = existing?.botTokenHash || '';

    if (plainToken) {
      botTokenHash = crypto
        .createHash('sha256')
        .update(plainToken)
        .digest('hex');

      const collision = await this.telegramChannelModel.findOne({
        where: existing
          ? { botTokenHash, id: { [Op.ne]: existing.id } }
          : { botTokenHash },
      });
      if (collision) {
        throw new BadRequestException(
          'Este Bot Token ya está vinculado a otro canal o usuario en la plataforma.',
        );
      }

      encryptedBotToken = encryptFtpSecret(plainToken);
    } else if (!existing) {
      throw new BadRequestException(
        'Debés ingresar el Bot Token obtenido en @BotFather.',
      );
    } else {
      plainToken = decryptFtpSecret(existing.encryptedBotToken);
    }

    // Validar el token y traer nombre/@username reales del bot
    let botUsername = existing?.botUsername || null;
    let botDisplayName = existing?.botDisplayName || null;
    try {
      const botInfo = await this.botClient.getMe(plainToken);
      botUsername = botInfo.botUsername;
      botDisplayName = botInfo.botDisplayName;
    } catch (err: any) {
      throw new BadRequestException(
        err?.message || 'El Bot Token ingresado no es válido.',
      );
    }

    const normalizedAllowed = Array.isArray(dto.allowedChatIds)
      ? Array.from(
          new Set(
            dto.allowedChatIds
              .map((v) => normalizeTelegramIdentifier(v))
              .filter(Boolean),
          ),
        )
      : existing?.allowedChatIds || [];

    const isActive =
      dto.isActive !== undefined
        ? dto.isActive
        : existing?.isActive ?? true;

    const payload = {
      companyId: owner.companyId,
      userId: owner.userId,
      encryptedBotToken,
      botTokenHash,
      botUsername,
      botDisplayName,
      senderPolicy:
        dto.senderPolicy || existing?.senderPolicy || TelegramSenderPolicy.ALL,
      allowedChatIds: normalizedAllowed,
      ignoreGroups:
        dto.ignoreGroups !== undefined
          ? dto.ignoreGroups
          : existing?.ignoreGroups ?? false,
      isActive,
      processImages:
        dto.processImages !== undefined
          ? dto.processImages
          : existing?.processImages ?? true,
      autoReplyConfirmation:
        dto.autoReplyConfirmation !== undefined
          ? dto.autoReplyConfirmation
          : existing?.autoReplyConfirmation ?? true,
      lastSyncStatus: TelegramSyncStatus.OK,
      lastSyncMessage: `Bot @${botUsername} ${isActive ? 'activo y escuchando' : 'pausado'}.`,
    };

    let saved: CompanyTelegramChannel;
    if (existing) {
      await existing.update(payload);
      saved = existing;
    } else {
      saved = await this.telegramChannelModel.create(payload as never);
    }

    // Reiniciar o detener polling en vivo según configuración
    this.stopPollingForChannel(saved.id);
    if (saved.isActive) {
      this.startPollingForChannel(saved.id);
    }

    await this.auditService.log({
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: 'CompanyTelegramChannel',
      entityId: saved.id,
      companyId: owner.companyId,
      userId: owner.actorUserId,
      payload: {
        targetUserId: owner.userId,
        botUsername: saved.botUsername,
        senderPolicy: saved.senderPolicy,
        isActive: saved.isActive,
      },
      description: `${existing ? 'Actualizó' : 'Configuró'} el bot de Telegram (@${saved.botUsername}) para usuario #${owner.userId}`,
    });

    await this.notificationsService.dispatch({
      type: 'channel.telegram_configured',
      title: '✈️ Bot de Telegram Configurado',
      body: `Se conectó el bot @${saved.botUsername} para recepción automática de comprobantes.`,
      companyId: owner.companyId,
      actorUser: { id: owner.actorUserId },
      extraData: {
        channelId: saved.id,
        userId: owner.userId,
        link: '/channels',
      },
    });

    return {
      message: 'Configuración de Telegram Bot guardada correctamente',
      ...this.toSafeChannelResponse(saved, owner.userId),
    };
  }

  private startPollingForChannel(channelId: number): void {
    if (this.pollingWorkers.has(channelId)) return;

    const worker: PollingWorkerState = {
      abortController: new AbortController(),
      stopped: false,
    };
    this.pollingWorkers.set(channelId, worker);

    this.logger.log(
      `✈️ [Telegram] Iniciando escucha Long Polling para canal #${channelId}`,
    );

    this.runPollingLoop(channelId, worker).catch((err) => {
      this.logger.warn(
        `[Telegram channel_${channelId}] Loop detenido: ${err?.message}`,
      );
    });
  }

  private stopPollingForChannel(channelId: number): void {
    const worker = this.pollingWorkers.get(channelId);
    if (!worker) return;
    worker.stopped = true;
    worker.abortController.abort();
    this.pollingWorkers.delete(channelId);
  }

  private async runPollingLoop(
    channelId: number,
    worker: PollingWorkerState,
  ): Promise<void> {
    let errorStreak = 0;
    let webhookCleared = false;

    while (!worker.stopped) {
      try {
        const channel = await this.telegramChannelModel.findByPk(channelId);
        if (!channel || !channel.isActive) {
          this.stopPollingForChannel(channelId);
          return;
        }

        if (this.usersModel && channel.userId) {
          const ownerUser = await this.usersModel.findByPk(channel.userId, {
            attributes: ['id', 'status'],
          });
          if (!ownerUser || ownerUser.status !== UserStatus.ACTIVE) {
            this.stopPollingForChannel(channelId);
            return;
          }
        }

        const token = decryptFtpSecret(channel.encryptedBotToken);
        if (!webhookCleared) {
          await this.botClient.deleteWebhook(token).catch(() => {});
          webhookCleared = true;
        }
        const offset = Number(channel.lastPollOffset || 0);

        const updates = await this.botClient.getUpdates(
          token,
          offset,
          20,
          worker.abortController.signal,
        );

        errorStreak = 0;

        if (updates.length > 0) {
          let maxUpdateId = offset - 1;
          for (const upd of updates) {
            const updId = Number(upd?.update_id);
            if (Number.isFinite(updId) && updId > maxUpdateId) {
              maxUpdateId = updId;
            }
            if (upd?.message) {
              await this.handleIncomingMessage(
                channel,
                token,
                upd.message,
              ).catch((msgErr) => {
                this.logger.warn(
                  `[Telegram channel_${channelId}] Error procesando mensaje: ${msgErr?.message}`,
                );
              });
            }
          }

          if (maxUpdateId >= offset) {
            await channel.update({ lastPollOffset: maxUpdateId + 1 });
          }
        }
      } catch (err: any) {
        if (worker.stopped || err?.name === 'AbortError') {
          return;
        }
        errorStreak++;
        const backoffMs = Math.min(30000, errorStreak * 3000);
        this.logger.warn(
          `[Telegram channel_${channelId}] Error de polling (reintento en ${backoffMs}ms): ${err?.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  async handleIncomingMessage(
    channel: CompanyTelegramChannel,
    botToken: string,
    msg: any,
  ): Promise<void> {
    const companyId = channel.companyId;
    const ownerUserId = channel.userId ?? null;
    const chatId = String(msg?.chat?.id ?? '').trim();
    const messageId = String(msg?.message_id ?? '').trim();
    if (!chatId || !messageId) return;

    const externalMessageId = `${chatId}:${messageId}`;
    const alreadyExists = await this.telegramMessageModel.findOne({
      where: { companyId, channelId: channel.id, externalMessageId },
      attributes: ['id'],
    });
    if (alreadyExists) return;

    // Verificar estado de la compañía y módulo habilitado
    const company = await this.companyModel.findByPk(companyId, {
      attributes: ['id', 'name', 'status', 'enabledModules'],
    });
    const enabledModules = Array.isArray(company?.enabledModules)
      ? company.enabledModules
      : [];
    if (
      !company ||
      company.status !== CompanyStatus.ACTIVE ||
      !enabledModules.includes('telegram')
    ) {
      return;
    }

    const chatType = String(msg?.chat?.type || 'private');
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    if (isGroup && channel.ignoreGroups) {
      return;
    }

    const fromUser = msg?.from;
    const senderUsername = fromUser?.username
      ? String(fromUser.username).trim()
      : null;
    const senderName =
      [fromUser?.first_name, fromUser?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      msg?.chat?.title ||
      null;

    const textBody = String(msg?.text || msg?.caption || '').trim();
    const trimmedCmd = textBody.toLowerCase();

    // Comandos útiles /start o /id (no consumen ni generan documento)
    if (trimmedCmd === '/start' || trimmedCmd.startsWith('/start ') || trimmedCmd === '/id') {
      await this.botClient
        .sendMessage(
          botToken,
          chatId,
          [
            `👋 *Bienvenido a HC-SCAN (${company.name})*`,
            ``,
            `Enviá un archivo *PDF* o una *foto de factura/remito/ticket* por este chat para digitalizarlo automáticamente con OCR e IA.`,
            ``,
            `🆔 *ID de este chat:* \`${chatId}\`${senderUsername ? ` (@${senderUsername})` : ''}`,
          ].join('\n'),
        )
        .catch(() => {});
      return;
    }

    // Verificar lista blanca si está activa
    if (channel.senderPolicy === TelegramSenderPolicy.WHITELIST) {
      const allowedSet = new Set(
        (channel.allowedChatIds || []).map((v) =>
          normalizeTelegramIdentifier(v),
        ),
      );
      const candidates = [
        normalizeTelegramIdentifier(chatId),
        normalizeTelegramIdentifier(String(fromUser?.id || '')),
        senderUsername ? normalizeTelegramIdentifier(senderUsername) : '',
      ].filter(Boolean);

      const isAllowed = candidates.some((c) => allowedSet.has(c));
      if (!isAllowed) {
        await this.telegramMessageModel.create({
          companyId,
          channelId: channel.id,
          userId: ownerUserId,
          externalMessageId,
          chatId,
          senderUsername,
          senderName,
          messageType: msg?.document ? 'document' : msg?.photo ? 'photo' : 'text',
          caption: textBody ? textBody.slice(0, 1000) : null,
          receivedAt: msg?.date ? new Date(Number(msg.date) * 1000) : new Date(),
          status: TelegramMessageStatus.REJECTED_SENDER,
          statusReason: `Chat/Usuario no autorizado (${chatId}${senderUsername ? ` / @${senderUsername}` : ''}).`,
        } as never);
        return;
      }
    }

    const receivedAt = msg?.date
      ? new Date(Number(msg.date) * 1000)
      : new Date();
    const docObj = msg?.document || null;
    const photosArr = Array.isArray(msg?.photo) ? msg.photo : null;
    const bestPhoto =
      photosArr && photosArr.length > 0
        ? photosArr[photosArr.length - 1]
        : null;

    if (!docObj && !bestPhoto) {
      await this.telegramMessageModel.create({
        companyId,
        channelId: channel.id,
        userId: ownerUserId,
        externalMessageId,
        chatId,
        senderUsername,
        senderName,
        messageType: 'text',
        caption: textBody ? textBody.slice(0, 1000) : null,
        receivedAt,
        status: TelegramMessageStatus.SKIPPED,
        statusReason: 'Mensaje de texto sin archivo PDF ni fotografía adjunta.',
      } as never);
      return;
    }

    if (bestPhoto && !channel.processImages) {
      await this.telegramMessageModel.create({
        companyId,
        channelId: channel.id,
        userId: ownerUserId,
        externalMessageId,
        chatId,
        senderUsername,
        senderName,
        messageType: 'photo',
        mimeType: 'image/jpeg',
        caption: textBody ? textBody.slice(0, 1000) : null,
        receivedAt,
        status: TelegramMessageStatus.SKIPPED,
        statusReason: 'Conversión automática de imágenes desactivada en el canal.',
      } as never);
      return;
    }

    const fileId = docObj ? String(docObj.file_id) : String(bestPhoto.file_id);
    const rawMime = docObj
      ? String(docObj.mime_type || 'application/octet-stream').toLowerCase()
      : 'image/jpeg';
    const reportedFileName = docObj
      ? String(docObj.file_name || `telegram_${messageId}.pdf`)
      : `telegram_foto_${messageId}.jpg`;

    const record = await this.telegramMessageModel.create({
      companyId,
      channelId: channel.id,
      userId: ownerUserId,
      externalMessageId,
      chatId,
      senderUsername,
      senderName,
      messageType: docObj ? 'document' : 'photo',
      fileName: reportedFileName.slice(0, 250),
      mimeType: rawMime.slice(0, 100),
      caption: textBody ? textBody.slice(0, 1000) : null,
      receivedAt,
      status: TelegramMessageStatus.SKIPPED,
    } as never);

    try {
      const isPdfMime =
        rawMime.includes('pdf') ||
        reportedFileName.toLowerCase().endsWith('.pdf');
      const isImgMime =
        rawMime.includes('jpeg') ||
        rawMime.includes('jpg') ||
        rawMime.includes('png') ||
        Boolean(bestPhoto);

      if (!isPdfMime && !isImgMime) {
        await record.update({
          status: TelegramMessageStatus.SKIPPED,
          statusReason: `Formato no soportado (${rawMime}). Solo se procesan PDF, JPG o PNG.`,
        });
        return;
      }

      const { buffer: rawBuffer } = await this.botClient.downloadFileBuffer(
        botToken,
        fileId,
      );

      let pdfBuffer = rawBuffer;
      let finalFileName = reportedFileName;

      if (!isPdfMime && isImgMime) {
        pdfBuffer = await convertImageBufferToPdf(
          rawBuffer,
          rawMime.includes('png') ? 'image/png' : 'image/jpeg',
          `${senderName || (senderUsername ? `@${senderUsername}` : chatId)}${textBody ? ` - ${textBody}` : ''}`,
        );
        finalFileName = `${reportedFileName.replace(/\.(png|jpe?g|webp)$/i, '')}.pdf`;
      }

      const { document, isDuplicate } =
        await this.documentsService.ingestPdfFromChannel({
          companyId,
          buffer: pdfBuffer,
          originalName: finalFileName,
          mimeType: 'application/pdf',
          source: DocumentSource.TELEGRAM,
          actorUserId: ownerUserId ?? undefined,
          channelContextLabel: `Telegram ${senderName || (senderUsername ? `@${senderUsername}` : chatId)}`,
        });

      await record.update({
        status: TelegramMessageStatus.PROCESSED,
        documentId: document.id,
        fileName: finalFileName.slice(0, 250),
        statusReason: isDuplicate
          ? 'Archivo duplicado ya existente en la bóveda (vinculado).'
          : 'Archivo guardado en bóveda cifrada y enviado a extracción OCR + IA.',
      });

      await channel.update({
        lastMessageAt: new Date(),
        lastSyncStatus: TelegramSyncStatus.OK,
        lastSyncMessage: `Último comprobante recibido de ${senderName || (senderUsername ? `@${senderUsername}` : chatId)}.`,
      });

      await this.notificationsService.dispatch({
        type: 'channel.telegram_received',
        title: '✈️ Comprobante recibido por Telegram',
        body: `Se recibió '${finalFileName}' desde ${senderName || (senderUsername ? `@${senderUsername}` : chatId)}.`,
        companyId,
        extraData: {
          documentId: document.id,
          telegramMessageId: record.id,
          channelId: channel.id,
          userId: ownerUserId,
          link: '/telegram',
        },
      });

      const okPayload = {
        companyId,
        channelId: channel.id,
        userId: ownerUserId,
        messageId: record.id,
        status: TelegramMessageStatus.PROCESSED,
        documentId: document.id,
        fileName: finalFileName,
      };
      if (ownerUserId) {
        this.gateway?.emitEventToUser?.(
          ownerUserId,
          'telegram:message_received',
          okPayload,
        );
      }
      this.gateway?.emitToCompany(
        companyId,
        'telegram:message_received',
        okPayload,
      );

      if (channel.autoReplyConfirmation) {
        const ackText = isDuplicate
          ? buildDuplicateNoticeMessage({
              fileName: finalFileName,
              documentId: document.id,
            })
          : buildReceiptAckMessage({
              fileName: finalFileName,
              documentId: document.id,
              channelName: 'Telegram',
            });
        await this.botClient
          .sendMessage(botToken, chatId, ackText)
          .catch(() => {});
      }
    } catch (err: any) {
      const errMsg =
        err?.message || 'Error al descargar o procesar archivo de Telegram';
      await record.update({
        status: TelegramMessageStatus.ERROR,
        statusReason: errMsg,
      });
      await channel.update({
        lastMessageAt: new Date(),
        lastSyncStatus: TelegramSyncStatus.ERROR,
        lastSyncMessage: errMsg,
      });

      await this.notificationsService.dispatch({
        type: 'document.error',
        title: '⚠️ Error al procesar archivo de Telegram',
        body: `'${reportedFileName}': ${errMsg}`,
        companyId,
        extraData: {
          telegramMessageId: record.id,
          channelId: channel.id,
          userId: ownerUserId,
          link: '/telegram',
        },
      });

      const errPayload = {
        companyId,
        channelId: channel.id,
        userId: ownerUserId,
        messageId: record.id,
        status: TelegramMessageStatus.ERROR,
        fileName: reportedFileName,
      };
      if (ownerUserId) {
        this.gateway?.emitEventToUser?.(
          ownerUserId,
          'telegram:message_received',
          errPayload,
        );
      }
      this.gateway?.emitToCompany(
        companyId,
        'telegram:message_received',
        errPayload,
      );

      if (channel.autoReplyConfirmation) {
        await this.botClient
          .sendMessage(
            botToken,
            chatId,
            buildIngestErrorMessage({
              fileName: reportedFileName,
              reason: errMsg,
            }),
          )
          .catch(() => {});
      }
    }
  }

  private async handleDocumentProcessedAutoReply(doc: Document): Promise<void> {
    try {
      const msg = await this.telegramMessageModel.findOne({
        where: { companyId: doc.companyId, documentId: doc.id },
      });
      if (!msg) return;

      const channel = msg.channelId
        ? await this.telegramChannelModel.findOne({
            where: { id: msg.channelId, isActive: true },
          })
        : await this.telegramChannelModel.findOne({
            where: {
              companyId: doc.companyId,
              ...(msg.userId ? { userId: msg.userId } : {}),
              isActive: true,
            },
          });
      if (!channel || !channel.autoReplyConfirmation) return;

      const botToken = decryptFtpSecret(channel.encryptedBotToken);
      await this.botClient.sendMessage(
        botToken,
        msg.chatId,
        buildOcrCompletedMessage(doc),
      );
    } catch (err: any) {
      this.logger.warn(
        `Error en respuesta automática post-OCR de Telegram para doc #${doc.id}: ${err?.message}`,
      );
    }
  }

  async listMessages(query: QueryTelegramMessagesDto, user: any) {
    const companyId = this.assertTenantUser(user);
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 25);
    const offset = (page - 1) * limit;

    const filterUserId = resolveInboxFilterUserId(user, query.userId);
    const statsWhere: any = { companyId };
    if (filterUserId !== undefined) {
      statsWhere.userId = filterUserId;
    }

    const where: any = { ...statsWhere };
    if (query.status) {
      where.status = query.status;
    }

    if (query.search && query.search.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { chatId: { [Op.iLike]: term } },
        { senderUsername: { [Op.iLike]: term } },
        { senderName: { [Op.iLike]: term } },
        { fileName: { [Op.iLike]: term } },
        { caption: { [Op.iLike]: term } },
      ];
    }

    const [
      { rows, count },
      totalAll,
      processedCount,
      skippedCount,
      rejectedCount,
      errorCount,
    ] = await Promise.all([
      this.telegramMessageModel.findAndCountAll({
        where,
        include: [
          {
            model: Document,
            as: 'document',
            attributes: ['id', 'originalName', 'documentType', 'totalAmount', 'status'],
            required: false,
          },
          {
            model: Users,
            as: 'user',
            attributes: ['id', 'name', 'lastName', 'username', 'email'],
            required: false,
          },
        ],
        order: [
          ['receivedAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit,
        offset,
      }),
      this.telegramMessageModel.count({ where: statsWhere }),
      this.telegramMessageModel.count({
        where: { ...statsWhere, status: TelegramMessageStatus.PROCESSED },
      }),
      this.telegramMessageModel.count({
        where: { ...statsWhere, status: TelegramMessageStatus.SKIPPED },
      }),
      this.telegramMessageModel.count({
        where: { ...statsWhere, status: TelegramMessageStatus.REJECTED_SENDER },
      }),
      this.telegramMessageModel.count({
        where: { ...statsWhere, status: TelegramMessageStatus.ERROR },
      }),
    ]);

    return {
      items: rows,
      total: count,
      page,
      limit,
      stats: {
        total: totalAll,
        processed: processedCount,
        skipped: skippedCount + rejectedCount,
        errors: errorCount,
      },
    };
  }
}
