import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  AllowedWhatsappGroup,
  CompanyWhatsappChannel,
  WhatsappConnectionStatus,
  WhatsappGroupPolicy,
  WhatsappSenderPolicy,
  WhatsappSyncStatus,
} from '../models/company-whatsapp-channel.model';
import {
  WhatsappMessage,
  WhatsappMessageStatus,
} from '../models/whatsapp-message.model';
import { UpsertWhatsappChannelDto } from '../dto/upsert-whatsapp-channel.dto';
import { QueryWhatsappMessagesDto } from '../dto/query-whatsapp-messages.dto';
import { WhatsappBaileysService } from './whatsapp-baileys.service';
import { DocumentsService } from '../../documents/documents.service';
import { Document, DocumentSource } from '../../documents/document.model';
import { DocumentProcessingQueueService } from '../../documents/services/document-processing-queue.service';
import { Company, CompanyStatus } from '../../companies/company.model';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationsGateway } from '../../notifications/notifications.gateway';
import { isPlatformSuperAdmin } from '../../../common/utils/tenant-scope.util';
import { Users, UserStatus } from '../../users/users.model';
import {
  resolveChannelOwnerContext,
  resolveInboxFilterUserId,
} from '../helpers/channel-user-scope.helper';
import {
  buildWhatsappDuplicateNotification,
  buildWhatsappIndexedNotification,
  buildWhatsappReceivedNotification,
} from '../helpers/channel-reply-formatter.helper';
import { convertImageBufferToPdf } from '../helpers/email-pdf-synthesizer.helper';
import { extractWhatsappAttachmentInfo } from '../helpers/whatsapp-message.helper';

export function normalizeWhatsappPhone(raw: string): string {
  return String(raw || '')
    .split(':')[0]
    .split('@')[0]
    .replace(/\D+/g, '');
}

@Injectable()
export class WhatsappChannelService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappChannelService.name);

  constructor(
    @InjectModel(CompanyWhatsappChannel)
    private readonly whatsappChannelModel: typeof CompanyWhatsappChannel,
    @InjectModel(WhatsappMessage)
    private readonly whatsappMessageModel: typeof WhatsappMessage,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly baileysService: WhatsappBaileysService,
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
    this.baileysService.registerIncomingMessagesHandler(
      (channelId, companyId, userId, messages) =>
        this.handleIncomingBaileysMessages(channelId, companyId, userId, messages),
    );
    this.processingQueue.registerPostProcessHook(async (doc) => {
      if (doc.source !== DocumentSource.WHATSAPP) return;
      await this.handleDocumentIndexedNotification(doc);
    });
  }

  private assertTenantUser(user: {
    companyId?: number | null;
    role?: string;
  }): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no gestiona sesiones privadas de WhatsApp de compañías.',
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

  private async ensureOrGetChannelRecord(
    companyId: number,
    userId: number,
  ): Promise<CompanyWhatsappChannel> {
    const [channel] = await this.whatsappChannelModel.findOrCreate({
      where: { companyId, userId },
      defaults: {
        companyId,
        userId,
        sessionKey: `company_${companyId}_user_${userId}`,
        connectionStatus: WhatsappConnectionStatus.DISCONNECTED,
        senderPolicy: WhatsappSenderPolicy.ALL,
        allowedPhones: [],
        ignoreGroups: true,
        groupPolicy: WhatsappGroupPolicy.IGNORE,
        allowedGroups: [],
        isActive: true,
        processImages: true,
        autoReplyConfirmation: false,
        notifyOnReceive: false,
        notifyOnIndexed: false,
        lastSyncStatus: WhatsappSyncStatus.IDLE,
      } as never,
    });
    return channel;
  }

  private buildSafeStatusResponse(
    channel: CompanyWhatsappChannel | null,
    targetUserId?: number | null,
  ) {
    const runtime = channel
      ? this.baileysService.getRuntimeSnapshot(channel.id, channel)
      : this.baileysService.getRuntimeSnapshot(0, null);
    const plain = channel ? (channel.toJSON() as any) : null;
    const resolvedGroupPolicy = plain
      ? plain.groupPolicy ||
        (plain.ignoreGroups === false
          ? WhatsappGroupPolicy.ALL
          : WhatsappGroupPolicy.IGNORE)
      : WhatsappGroupPolicy.IGNORE;

    return {
      configured: Boolean(channel),
      targetUserId: channel?.userId ?? targetUserId ?? null,
      channel: plain
        ? {
            ...plain,
            groupPolicy: resolvedGroupPolicy,
            allowedGroups: Array.isArray(plain.allowedGroups)
              ? plain.allowedGroups
              : [],
            connectionStatus: runtime.connectionStatus,
            connectedPhone: runtime.connectedPhone || plain.connectedPhone,
            connectedName: runtime.connectedName || plain.connectedName,
          }
        : null,
      runtime,
    };
  }

  async getStatusAndConfig(user: any, requestedUserId?: number | string | null) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId: owner.companyId, userId: owner.userId },
    });
    return this.buildSafeStatusResponse(channel, owner.userId);
  }

  async listGroups(user: any, requestedUserId?: number | string | null) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId: owner.companyId, userId: owner.userId },
      attributes: ['id'],
    });
    if (!channel) {
      return { connected: false, groups: [] };
    }
    return this.baileysService.listParticipatingGroups(channel.id);
  }

  async connectQr(user: any, requestedUserId?: number | string | null) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.ensureOrGetChannelRecord(
      owner.companyId,
      owner.userId,
    );

    if (!channel.isActive) {
      await channel.update({ isActive: true });
    }

    await this.baileysService.startSession(channel.id);

    // Esperar brevemente (~1.5s) para devolver el QR en la misma respuesta si ya se emitió
    for (let i = 0; i < 6; i++) {
      const snap = this.baileysService.getRuntimeSnapshot(channel.id, channel);
      if (
        snap.qrDataUrl ||
        snap.connectionStatus === WhatsappConnectionStatus.CONNECTED
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const updated = await this.whatsappChannelModel.findByPk(channel.id);

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'CompanyWhatsappChannel',
      entityId: channel.id,
      companyId: owner.companyId,
      userId: owner.actorUserId,
      description: `Inició vinculación de WhatsApp por Código QR (usuario #${owner.userId})`,
    });

    return {
      message: 'Sesión WhatsApp iniciada. Escaneá el código QR desde tu celular.',
      ...this.buildSafeStatusResponse(updated, owner.userId),
    };
  }

  async disconnect(user: any, requestedUserId?: number | string | null) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId: owner.companyId, userId: owner.userId },
    });

    if (channel) {
      await this.baileysService.disconnectSession(channel.id, true);
      await this.auditService.log({
        action: AuditAction.UPDATE,
        entity: 'CompanyWhatsappChannel',
        entityId: channel.id,
        companyId: owner.companyId,
        userId: owner.actorUserId,
        description: `Desconectó la sesión de WhatsApp del usuario #${owner.userId}`,
      });
    }

    const updated = channel
      ? await this.whatsappChannelModel.findByPk(channel.id)
      : null;

    return {
      message: 'Sesión de WhatsApp desconectada correctamente.',
      ...this.buildSafeStatusResponse(updated, owner.userId),
    };
  }

  async upsertSettings(
    dto: UpsertWhatsappChannelDto,
    user: any,
    requestedUserId?: number | string | null,
  ) {
    const owner = await resolveChannelOwnerContext(
      user,
      requestedUserId,
      this.usersModel,
    );
    const channel = await this.ensureOrGetChannelRecord(
      owner.companyId,
      owner.userId,
    );

    const normalizedAllowedPhones = Array.isArray(dto.allowedPhones)
      ? Array.from(
          new Set(
            dto.allowedPhones
              .map((p) => normalizeWhatsappPhone(p))
              .filter((p) => p.length >= 7),
          ),
        )
      : channel.allowedPhones || [];

    const normalizedAllowedGroups: AllowedWhatsappGroup[] = Array.isArray(
      dto.allowedGroups,
    )
      ? Array.from(
          new Map(
            dto.allowedGroups
              .map((g) => ({
                jid: String(g?.jid || '').trim(),
                name: String(g?.name || g?.jid || '').trim(),
              }))
              .filter((g) => g.jid.endsWith('@g.us'))
              .map((g) => [g.jid, g]),
          ).values(),
        )
      : channel.allowedGroups || [];

    const nextGroupPolicy: WhatsappGroupPolicy =
      dto.groupPolicy !== undefined
        ? dto.groupPolicy
        : dto.ignoreGroups !== undefined
          ? dto.ignoreGroups
            ? WhatsappGroupPolicy.IGNORE
            : WhatsappGroupPolicy.ALL
          : channel.groupPolicy ||
            (channel.ignoreGroups === false
              ? WhatsappGroupPolicy.ALL
              : WhatsappGroupPolicy.IGNORE);

    const nextIgnoreGroups = nextGroupPolicy === WhatsappGroupPolicy.IGNORE;

    const nextActive =
      dto.isActive !== undefined ? dto.isActive : channel.isActive;
    const nextNotifyOnReceive =
      dto.notifyOnReceive !== undefined
        ? dto.notifyOnReceive
        : Boolean(channel.notifyOnReceive);
    const nextNotifyOnIndexed =
      dto.notifyOnIndexed !== undefined
        ? dto.notifyOnIndexed
        : Boolean(channel.notifyOnIndexed);

    await channel.update({
      senderPolicy: dto.senderPolicy ?? channel.senderPolicy,
      allowedPhones: normalizedAllowedPhones,
      ignoreGroups: nextIgnoreGroups,
      groupPolicy: nextGroupPolicy,
      allowedGroups: normalizedAllowedGroups,
      isActive: nextActive,
      processImages:
        dto.processImages !== undefined
          ? dto.processImages
          : channel.processImages,
      notifyOnReceive: nextNotifyOnReceive,
      notifyOnIndexed: nextNotifyOnIndexed,
      autoReplyConfirmation:
        dto.autoReplyConfirmation !== undefined
          ? dto.autoReplyConfirmation
          : nextNotifyOnReceive || nextNotifyOnIndexed,
    });

    if (!nextActive) {
      await this.baileysService.disconnectSession(channel.id, false);
    }

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'CompanyWhatsappChannel',
      entityId: channel.id,
      companyId: owner.companyId,
      userId: owner.actorUserId,
      payload: {
        targetUserId: owner.userId,
        senderPolicy: channel.senderPolicy,
        ignoreGroups: channel.ignoreGroups,
        isActive: channel.isActive,
        processImages: channel.processImages,
        notifyOnReceive: channel.notifyOnReceive,
        notifyOnIndexed: channel.notifyOnIndexed,
        autoReplyConfirmation: channel.autoReplyConfirmation,
      },
      description: `Actualizó reglas de recepción de WhatsApp (usuario #${owner.userId})`,
    });

    await this.notificationsService.dispatch({
      type: 'channel.whatsapp_configured',
      title: '💬 Configuración de WhatsApp actualizada',
      body: 'Se actualizaron las preferencias de recepción y procesamiento OCR para WhatsApp.',
      companyId: owner.companyId,
      actorUser: { id: owner.actorUserId },
      extraData: {
        channelId: channel.id,
        userId: owner.userId,
        link: '/channels',
      },
    });

    return {
      message: 'Preferencias de WhatsApp guardadas correctamente.',
      ...this.buildSafeStatusResponse(channel, owner.userId),
    };
  }

  async handleIncomingBaileysMessages(
    channelId: number,
    companyId: number,
    userId: number | null,
    messages: any[],
  ): Promise<void> {
    const channel = await this.whatsappChannelModel.findByPk(channelId);
    if (!channel || !channel.isActive) {
      return;
    }

    const ownerUserId = channel.userId ?? userId ?? null;
    if (this.usersModel && ownerUserId) {
      const ownerUser = await this.usersModel.findByPk(ownerUserId, {
        attributes: ['id', 'status'],
      });
      if (!ownerUser || ownerUser.status !== UserStatus.ACTIVE) {
        return;
      }
    }

    const resolvedCompanyId = channel.companyId ?? companyId;
    const company = await this.companyModel.findByPk(resolvedCompanyId, {
      attributes: ['id', 'status', 'enabledModules'],
    });
    if (!company || company.status !== CompanyStatus.ACTIVE) {
      return;
    }

    const enabledModules = Array.isArray(company.enabledModules)
      ? company.enabledModules
      : [];
    if (!enabledModules.includes('whatsapp')) {
      return;
    }

    for (const msg of messages) {
      const externalMessageId = String(msg?.key?.id || '').trim();
      const remoteJid = String(msg?.key?.remoteJid || '').trim();

      if (!externalMessageId || !remoteJid || remoteJid === 'status@broadcast') {
        continue;
      }

      const isGroup = remoteJid.endsWith('@g.us');
      const effectiveGroupPolicy: WhatsappGroupPolicy =
        channel.groupPolicy ||
        (channel.ignoreGroups === false
          ? WhatsappGroupPolicy.ALL
          : WhatsappGroupPolicy.IGNORE);

      // En chats privados 1-a-1 ignorar mensajes propios; en grupos autorizados sí se procesan aunque los envíe tu propia cuenta
      if (!isGroup && msg?.key?.fromMe) {
        continue;
      }

      if (isGroup) {
        if (effectiveGroupPolicy === WhatsappGroupPolicy.IGNORE) {
          this.logger.debug(
            `[WhatsApp channel_${channel.id}] Adjunto de grupo ${remoteJid} ignorado (groupPolicy=IGNORE).`,
          );
          continue;
        }
        if (effectiveGroupPolicy === WhatsappGroupPolicy.WHITELIST) {
          const allowedGroupSet = new Set(
            (channel.allowedGroups || []).map((g) => String(g?.jid || '').trim()),
          );
          if (!allowedGroupSet.has(remoteJid)) {
            this.logger.log(
              `[WhatsApp channel_${channel.id}] Adjunto de grupo ${remoteJid} omitido: no está en los ${allowedGroupSet.size} grupo(s) autorizado(s).`,
            );
            continue;
          }
        }
      }

      // Solo obtener y procesar mensajes que traen un documento o imagen adjunta
      const { content, docMsg, imgMsg, hasAttachment } =
        extractWhatsappAttachmentInfo(msg?.message);
      if (!content || !hasAttachment) {
        continue;
      }

      // Idempotencia por canal
      const alreadyExists = await this.whatsappMessageModel.findOne({
        where: { companyId: resolvedCompanyId, channelId: channel.id, externalMessageId },
        attributes: ['id'],
      });
      if (alreadyExists) {
        continue;
      }

      const rawSenderJid = String(
        msg?.key?.participantAlt ||
          msg?.key?.participant ||
          msg?.key?.remoteJidAlt ||
          (isGroup && msg?.key?.fromMe ? channel.connectedPhone || '' : '') ||
          remoteJid,
      );
      const senderPhone = (normalizeWhatsappPhone(rawSenderJid) || 'desconocido').slice(0, 40);
      const senderName = msg?.pushName ? String(msg.pushName).trim() : null;

      let groupName: string | null = null;
      if (isGroup) {
        const matchedSaved = (channel.allowedGroups || []).find(
          (g) => String(g?.jid || '').trim() === remoteJid,
        );
        groupName =
          matchedSaved?.name ||
          (await this.baileysService.resolveGroupSubject?.(channel.id, remoteJid)) ||
          remoteJid;
      }

      const tsSec = Number(msg?.messageTimestamp);
      const receivedAt =
        Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();

      const textBody = docMsg?.caption || imgMsg?.caption || null;
      const msgType = docMsg ? 'document' : 'image';

      // En chats privados 1-a-1 respetar Lista Blanca de teléfonos; dentro de un grupo autorizado se procesa de cualquier integrante
      if (!isGroup && channel.senderPolicy === WhatsappSenderPolicy.WHITELIST) {
        const allowedSet = new Set(
          (channel.allowedPhones || []).map((p) => normalizeWhatsappPhone(p)),
        );
        if (!allowedSet.has(senderPhone)) {
          await this.whatsappMessageModel.create({
            companyId: resolvedCompanyId,
            channelId: channel.id,
            userId: ownerUserId,
            externalMessageId,
            senderPhone,
            replyJid: remoteJid,
            senderName,
            messageType: msgType,
            caption: textBody ? String(textBody).slice(0, 1000) : null,
            receivedAt,
            status: WhatsappMessageStatus.REJECTED_SENDER,
            statusReason:
              'Número remitente no autorizado en la lista blanca de la compañía.',
          } as never);
          continue;
        }
      }

      if (imgMsg && !channel.processImages) {
        await this.whatsappMessageModel.create({
          companyId: resolvedCompanyId,
          channelId: channel.id,
          userId: ownerUserId,
          externalMessageId,
          senderPhone,
          replyJid: remoteJid,
          groupJid: isGroup ? remoteJid : null,
          groupName,
          senderName,
          messageType: 'image',
          mimeType: imgMsg.mimetype || 'image/jpeg',
          caption: imgMsg.caption || null,
          receivedAt,
          status: WhatsappMessageStatus.SKIPPED,
          statusReason: 'Conversión automática de imágenes desactivada en el canal.',
        } as never);
        continue;
      }

      const rawMime = String(
        docMsg?.mimetype || imgMsg?.mimetype || 'application/octet-stream',
      ).toLowerCase();
      const reportedFileName = docMsg
        ? String(
            docMsg.fileName ||
              `whatsapp_${externalMessageId.slice(-8)}.pdf`,
          )
        : `whatsapp_img_${externalMessageId.slice(-8)}.jpg`;

      const record = await this.whatsappMessageModel.create({
        companyId: resolvedCompanyId,
        channelId: channel.id,
        userId: ownerUserId,
        externalMessageId,
        senderPhone,
        replyJid: remoteJid,
        groupJid: isGroup ? remoteJid : null,
        groupName,
        senderName,
        messageType: msgType,
        fileName: reportedFileName.slice(0, 250),
        mimeType: rawMime.slice(0, 100),
        caption: textBody ? String(textBody).slice(0, 1000) : null,
        receivedAt,
        status: WhatsappMessageStatus.SKIPPED,
      } as never);

      try {
        const isPdfMime =
          rawMime.includes('pdf') ||
          reportedFileName.toLowerCase().endsWith('.pdf');
        const isImgMime =
          rawMime.includes('jpeg') ||
          rawMime.includes('jpg') ||
          rawMime.includes('png');

        if (!isPdfMime && !isImgMime) {
          await record.update({
            status: WhatsappMessageStatus.SKIPPED,
            statusReason: `Formato no soportado (${rawMime}). Solo se procesan PDF, JPG o PNG.`,
          });
          continue;
        }

        const mediaBuffer = await this.baileysService.downloadMessageMedia(
          channel.id,
          msg,
        );

        let pdfBuffer = mediaBuffer;
        let finalFileName = reportedFileName;

        if (!isPdfMime && isImgMime) {
          pdfBuffer = await convertImageBufferToPdf(
            mediaBuffer,
            rawMime,
            `${senderName || senderPhone}${textBody ? ` - ${textBody}` : ''}`,
          );
          finalFileName = `${reportedFileName.replace(/\.(png|jpe?g|webp)$/i, '')}.pdf`;
        }

        const { document, isDuplicate } =
          await this.documentsService.ingestPdfFromChannel({
            companyId: resolvedCompanyId,
            buffer: pdfBuffer,
            originalName: finalFileName,
            mimeType: 'application/pdf',
            source: DocumentSource.WHATSAPP,
            actorUserId: ownerUserId ?? undefined,
            channelContextLabel: groupName
              ? `WhatsApp Grupo '${groupName}' · ${senderName || `+${senderPhone}`}`
              : `WhatsApp ${senderName ? `${senderName} (+${senderPhone})` : `+${senderPhone}`}`,
          });

        await record.update({
          status: WhatsappMessageStatus.PROCESSED,
          documentId: document.id,
          fileName: finalFileName.slice(0, 250),
          statusReason: isDuplicate
            ? 'Archivo duplicado ya existente en la bóveda (vinculado).'
            : 'Archivo guardado en bóveda cifrada y enviado a extracción OCR + IA.',
        });

        await channel.update({
          lastMessageAt: new Date(),
          lastSyncStatus: WhatsappSyncStatus.OK,
          lastSyncMessage: `Último comprobante recibido de ${senderName || `+${senderPhone}`}${groupName ? ` (Grupo: ${groupName})` : ''}.`,
        });

        await this.notificationsService.dispatch({
          type: 'channel.whatsapp_received',
          title: '📲 Comprobante recibido por WhatsApp',
          body: `Se recibió '${finalFileName}' desde ${senderName || `+${senderPhone}`}${groupName ? ` en grupo '${groupName}'` : ''}.`,
          companyId: resolvedCompanyId,
          extraData: {
            documentId: document.id,
            whatsappMessageId: record.id,
            channelId: channel.id,
            userId: ownerUserId,
            link: '/whatsapp',
          },
        });

        const wsPayload = {
          companyId: resolvedCompanyId,
          channelId: channel.id,
          userId: ownerUserId,
          messageId: record.id,
          status: WhatsappMessageStatus.PROCESSED,
          documentId: document.id,
          fileName: finalFileName,
        };
        if (ownerUserId) {
          this.gateway?.emitEventToUser?.(
            ownerUserId,
            'whatsapp:message_received',
            wsPayload,
          );
        }
        this.gateway?.emitToCompany(
          resolvedCompanyId,
          'whatsapp:message_received',
          wsPayload,
        );

        if (channel.notifyOnReceive) {
          const receiveText = isDuplicate
            ? buildWhatsappDuplicateNotification()
            : buildWhatsappReceivedNotification();
          await this.sendShortWhatsappNotice(channel.id, remoteJid, receiveText);
        }
      } catch (err: any) {
        const errMsg =
          err?.message || 'Error al descargar o procesar archivo de WhatsApp';
        await record.update({
          status: WhatsappMessageStatus.ERROR,
          statusReason: errMsg,
        });
        await channel.update({
          lastMessageAt: new Date(),
          lastSyncStatus: WhatsappSyncStatus.ERROR,
          lastSyncMessage: errMsg,
        });

        const errPayload = {
          companyId: resolvedCompanyId,
          channelId: channel.id,
          userId: ownerUserId,
          messageId: record.id,
          status: WhatsappMessageStatus.ERROR,
          fileName: reportedFileName,
        };
        if (ownerUserId) {
          this.gateway?.emitEventToUser?.(
            ownerUserId,
            'whatsapp:message_received',
            errPayload,
          );
        }
        this.gateway?.emitToCompany(
          resolvedCompanyId,
          'whatsapp:message_received',
          errPayload,
        );
      }
    }
  }

  private async sendShortWhatsappNotice(
    channelId: number,
    targetJid: string,
    text: string,
  ): Promise<void> {
    if (!targetJid || !this.baileysService.sendTextMessage) return;
    try {
      await this.baileysService.sendTextMessage(channelId, targetJid, text);
    } catch (err: any) {
      this.logger.warn(
        `[WhatsApp ch_${channelId}] No se pudo enviar notificación a '${targetJid}': ${err?.message}`,
      );
    }
  }

  private async handleDocumentIndexedNotification(doc: Document): Promise<void> {
    try {
      const msg = await this.whatsappMessageModel.findOne({
        where: { companyId: doc.companyId, documentId: doc.id },
        order: [['id', 'DESC']],
      });
      if (!msg) return;

      const targetJid = msg.replyJid || msg.groupJid || msg.senderPhone;
      if (!targetJid) return;

      const channel = msg.channelId
        ? await this.whatsappChannelModel.findOne({
            where: { id: msg.channelId, isActive: true },
          })
        : await this.whatsappChannelModel.findOne({
            where: {
              companyId: doc.companyId,
              ...(msg.userId ? { userId: msg.userId } : {}),
              isActive: true,
            },
          });

      if (!channel || !channel.notifyOnIndexed) return;

      await this.sendShortWhatsappNotice(
        channel.id,
        targetJid,
        buildWhatsappIndexedNotification(),
      );
    } catch (err: any) {
      this.logger.warn(
        `Error enviando notificación WhatsApp post-indexado para doc #${doc.id}: ${err?.message}`,
      );
    }
  }

  async listMessages(query: QueryWhatsappMessagesDto, user: any) {
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
        { senderPhone: { [Op.iLike]: term } },
        { senderName: { [Op.iLike]: term } },
        { groupName: { [Op.iLike]: term } },
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
      this.whatsappMessageModel.findAndCountAll({
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
      this.whatsappMessageModel.count({ where: statsWhere }),
      this.whatsappMessageModel.count({
        where: { ...statsWhere, status: WhatsappMessageStatus.PROCESSED },
      }),
      this.whatsappMessageModel.count({
        where: { ...statsWhere, status: WhatsappMessageStatus.SKIPPED },
      }),
      this.whatsappMessageModel.count({
        where: { ...statsWhere, status: WhatsappMessageStatus.REJECTED_SENDER },
      }),
      this.whatsappMessageModel.count({
        where: { ...statsWhere, status: WhatsappMessageStatus.ERROR },
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
