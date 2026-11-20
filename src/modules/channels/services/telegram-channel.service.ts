import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
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
import {
  decryptFtpSecret,
  encryptFtpSecret,
} from '../../../common/utils/vault-crypto.util';
import { isPlatformSuperAdmin } from '../../../common/utils/tenant-scope.util';
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
      const activeChannels = await this.telegramChannelModel.findAll({
        where: { isActive: true },
      });

      for (const ch of activeChannels) {
        const company = await this.companyModel.findByPk(ch.companyId, {
          attributes: ['id', 'status', 'enabledModules'],
        });
        const modules = Array.isArray(company?.enabledModules)
          ? company.enabledModules
          : [];

        if (
          company &&
          company.status === CompanyStatus.ACTIVE &&
          modules.includes('telegram')
        ) {
          this.startPollingForCompany(ch.companyId);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `[Telegram] No se pudieron iniciar bots al arrancar: ${err?.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const companyId of Array.from(this.pollingWorkers.keys())) {
      this.stopPollingForCompany(companyId);
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

  private toSafeChannelResponse(channel: CompanyTelegramChannel | null) {
    if (!channel) {
      return {
        configured: false,
        channel: null,
      };
    }

    const plain = channel.toJSON() as any;
    const hasBotToken = Boolean(plain.encryptedBotToken);
    delete plain.encryptedBotToken;
    delete plain.botTokenHash;

    return {
      configured: true,
      channel: {
        ...plain,
        hasBotToken,
        isPollingActive: this.pollingWorkers.has(channel.companyId),
      },
    };
  }

  async getChannelConfig(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.telegramChannelModel.findOne({
      where: { companyId },
    });
    return this.toSafeChannelResponse(channel);
  }

  async testConnection(dto: TestTelegramConnectionDto, user: any) {
    const companyId = this.assertTenantUser(user);
    let plainToken = dto.botToken?.trim() || '';

    if (!plainToken) {
      const existing = await this.telegramChannelModel.findOne({
        where: { companyId },
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
        where: { companyId },
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

  async upsertChannelConfig(dto: UpsertTelegramChannelDto, user: any) {
    const companyId = this.assertTenantUser(user);
    const existing = await this.telegramChannelModel.findOne({
      where: { companyId },
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
        where: {
          botTokenHash,
          companyId: { [Op.ne]: companyId },
        },
      });
      if (collision) {
        throw new BadRequestException(
          'Este Bot Token ya está vinculado a otra compañía de la plataforma.',
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
      companyId,
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
    this.stopPollingForCompany(companyId);
    if (saved.isActive) {
      this.startPollingForCompany(companyId);
    }

    await this.auditService.log({
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: 'CompanyTelegramChannel',
      entityId: saved.id,
      companyId,
      userId: user.id,
      payload: {
        botUsername: saved.botUsername,
        senderPolicy: saved.senderPolicy,
        isActive: saved.isActive,
      },
      description: `${existing ? 'Actualizó' : 'Configuró'} el bot de Telegram (@${saved.botUsername})`,
    });

    await this.notificationsService.dispatch({
      type: 'channel.telegram_configured',
      title: '✈️ Bot de Telegram Configurado',
      body: `Se conectó el bot @${saved.botUsername} para recepción automática de comprobantes.`,
      companyId,
      actorUser: { id: user.id },
      extraData: { channelId: saved.id, link: '/channels' },
    });

    return {
      message: 'Configuración de Telegram Bot guardada correctamente',
      ...this.toSafeChannelResponse(saved),
    };
  }

  private startPollingForCompany(companyId: number): void {
    if (this.pollingWorkers.has(companyId)) return;

    const worker: PollingWorkerState = {
      abortController: new AbortController(),
      stopped: false,
    };
    this.pollingWorkers.set(companyId, worker);

    this.logger.log(
      `✈️ [Telegram] Iniciando escucha Long Polling para compañía #${companyId}`,
    );

    this.runPollingLoop(companyId, worker).catch((err) => {
      this.logger.warn(
        `[Telegram company_${companyId}] Loop detenido: ${err?.message}`,
      );
    });
  }

  private stopPollingForCompany(companyId: number): void {
    const worker = this.pollingWorkers.get(companyId);
    if (!worker) return;
    worker.stopped = true;
    worker.abortController.abort();
    this.pollingWorkers.delete(companyId);
  }

  private async runPollingLoop(
    companyId: number,
    worker: PollingWorkerState,
  ): Promise<void> {
    let errorStreak = 0;

    while (!worker.stopped) {
      try {
        const channel = await this.telegramChannelModel.findOne({
          where: { companyId },
        });
        if (!channel || !channel.isActive) {
          this.stopPollingForCompany(companyId);
          return;
        }

        const token = decryptFtpSecret(channel.encryptedBotToken);
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
                  `[Telegram company_${companyId}] Error procesando mensaje: ${msgErr?.message}`,
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
          `[Telegram company_${companyId}] Error de polling (reintento en ${backoffMs}ms): ${err?.message}`,
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
    const chatId = String(msg?.chat?.id ?? '').trim();
    const messageId = String(msg?.message_id ?? '').trim();
    if (!chatId || !messageId) return;

    const externalMessageId = `${chatId}:${messageId}`;
    const alreadyExists = await this.telegramMessageModel.findOne({
      where: { companyId, externalMessageId },
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
        extraData: { documentId: document.id, link: '/documents' },
      });

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

      const channel = await this.telegramChannelModel.findOne({
        where: { companyId: doc.companyId, isActive: true },
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

    const where: any = { companyId };
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
        ],
        order: [
          ['receivedAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit,
        offset,
      }),
      this.telegramMessageModel.count({ where: { companyId } }),
      this.telegramMessageModel.count({
        where: { companyId, status: TelegramMessageStatus.PROCESSED },
      }),
      this.telegramMessageModel.count({
        where: { companyId, status: TelegramMessageStatus.SKIPPED },
      }),
      this.telegramMessageModel.count({
        where: { companyId, status: TelegramMessageStatus.REJECTED_SENDER },
      }),
      this.telegramMessageModel.count({
        where: { companyId, status: TelegramMessageStatus.ERROR },
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
