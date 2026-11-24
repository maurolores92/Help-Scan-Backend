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
  CompanyWhatsappChannel,
  WhatsappConnectionStatus,
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
  ) {}

  onModuleInit(): void {
    this.baileysService.registerIncomingMessagesHandler(
      (companyId, messages) =>
        this.handleIncomingBaileysMessages(companyId, messages),
    );
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
  ): Promise<CompanyWhatsappChannel> {
    const [channel] = await this.whatsappChannelModel.findOrCreate({
      where: { companyId },
      defaults: {
        companyId,
        sessionKey: `company_${companyId}`,
        connectionStatus: WhatsappConnectionStatus.DISCONNECTED,
        senderPolicy: WhatsappSenderPolicy.ALL,
        allowedPhones: [],
        ignoreGroups: true,
        isActive: true,
        processImages: true,
        autoReplyConfirmation: false,
        lastSyncStatus: WhatsappSyncStatus.IDLE,
      } as never,
    });
    return channel;
  }

  private buildSafeStatusResponse(
    channel: CompanyWhatsappChannel | null,
    companyId: number,
  ) {
    const runtime = this.baileysService.getRuntimeSnapshot(companyId, channel);
    const plain = channel ? (channel.toJSON() as any) : null;

    return {
      configured: Boolean(channel),
      channel: plain
        ? {
            ...plain,
            connectionStatus: runtime.connectionStatus,
            connectedPhone: runtime.connectedPhone || plain.connectedPhone,
            connectedName: runtime.connectedName || plain.connectedName,
          }
        : null,
      runtime,
    };
  }

  async getStatusAndConfig(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId },
    });
    return this.buildSafeStatusResponse(channel, companyId);
  }

  async connectQr(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.ensureOrGetChannelRecord(companyId);

    if (!channel.isActive) {
      await channel.update({ isActive: true });
    }

    await this.baileysService.startSession(companyId);

    // Esperar brevemente (~1.5s) para devolver el QR en la misma respuesta si ya se emitió
    for (let i = 0; i < 6; i++) {
      const snap = this.baileysService.getRuntimeSnapshot(companyId, channel);
      if (
        snap.qrDataUrl ||
        snap.connectionStatus === WhatsappConnectionStatus.CONNECTED
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const updated = await this.whatsappChannelModel.findOne({
      where: { companyId },
    });

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'CompanyWhatsappChannel',
      entityId: channel.id,
      companyId,
      userId: user.id,
      description: 'Inició vinculación de WhatsApp por Código QR',
    });

    return {
      message: 'Sesión WhatsApp iniciada. Escaneá el código QR desde tu celular.',
      ...this.buildSafeStatusResponse(updated, companyId),
    };
  }

  async disconnect(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId },
    });

    await this.baileysService.disconnectSession(companyId, true);

    if (channel) {
      await this.auditService.log({
        action: AuditAction.UPDATE,
        entity: 'CompanyWhatsappChannel',
        entityId: channel.id,
        companyId,
        userId: user.id,
        description: 'Desconectó la sesión de WhatsApp de la compañía',
      });
    }

    const updated = await this.whatsappChannelModel.findOne({
      where: { companyId },
    });

    return {
      message: 'Sesión de WhatsApp desconectada correctamente.',
      ...this.buildSafeStatusResponse(updated, companyId),
    };
  }

  async upsertSettings(dto: UpsertWhatsappChannelDto, user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.ensureOrGetChannelRecord(companyId);

    const normalizedAllowedPhones = Array.isArray(dto.allowedPhones)
      ? Array.from(
          new Set(
            dto.allowedPhones
              .map((p) => normalizeWhatsappPhone(p))
              .filter((p) => p.length >= 7),
          ),
        )
      : channel.allowedPhones || [];

    const nextActive =
      dto.isActive !== undefined ? dto.isActive : channel.isActive;

    await channel.update({
      senderPolicy: dto.senderPolicy ?? channel.senderPolicy,
      allowedPhones: normalizedAllowedPhones,
      ignoreGroups:
        dto.ignoreGroups !== undefined ? dto.ignoreGroups : channel.ignoreGroups,
      isActive: nextActive,
      processImages:
        dto.processImages !== undefined
          ? dto.processImages
          : channel.processImages,
      autoReplyConfirmation:
        dto.autoReplyConfirmation !== undefined
          ? dto.autoReplyConfirmation
          : channel.autoReplyConfirmation,
    });

    if (!nextActive) {
      await this.baileysService.disconnectSession(companyId, false);
    }

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'CompanyWhatsappChannel',
      entityId: channel.id,
      companyId,
      userId: user.id,
      payload: {
        senderPolicy: channel.senderPolicy,
        ignoreGroups: channel.ignoreGroups,
        isActive: channel.isActive,
        processImages: channel.processImages,
        autoReplyConfirmation: channel.autoReplyConfirmation,
      },
      description: 'Actualizó reglas de recepción de WhatsApp de la compañía',
    });

    await this.notificationsService.dispatch({
      type: 'channel.whatsapp_configured',
      title: '💬 Configuración de WhatsApp actualizada',
      body: 'Se actualizaron las preferencias de recepción y procesamiento OCR para WhatsApp.',
      companyId,
      actorUser: { id: user.id },
      extraData: { channelId: channel.id, link: '/channels' },
    });

    return {
      message: 'Preferencias de WhatsApp guardadas correctamente.',
      ...this.buildSafeStatusResponse(channel, companyId),
    };
  }

  async handleIncomingBaileysMessages(
    companyId: number,
    messages: any[],
  ): Promise<void> {
    const channel = await this.whatsappChannelModel.findOne({
      where: { companyId },
    });
    if (!channel || !channel.isActive) {
      return;
    }

    const company = await this.companyModel.findByPk(companyId, {
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

      // Ignorar mensajes salientes propios
      if (msg?.key?.fromMe) {
        continue;
      }

      const isGroup = remoteJid.endsWith('@g.us');
      if (isGroup && channel.ignoreGroups) {
        continue;
      }

      // Solo obtener y procesar mensajes que traen un documento o imagen adjunta
      const { content, docMsg, imgMsg, hasAttachment } =
        extractWhatsappAttachmentInfo(msg?.message);
      if (!content || !hasAttachment) {
        continue;
      }

      // Idempotencia
      const alreadyExists = await this.whatsappMessageModel.findOne({
        where: { companyId, externalMessageId },
        attributes: ['id'],
      });
      if (alreadyExists) {
        continue;
      }

      const rawSenderJid = String(
        msg?.key?.participantAlt ||
          msg?.key?.participant ||
          msg?.key?.remoteJidAlt ||
          remoteJid,
      );
      const senderPhone = normalizeWhatsappPhone(rawSenderJid) || 'desconocido';
      const senderName = msg?.pushName ? String(msg.pushName).trim() : null;

      const tsSec = Number(msg?.messageTimestamp);
      const receivedAt =
        Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();

      const textBody = docMsg?.caption || imgMsg?.caption || null;
      const msgType = docMsg ? 'document' : 'image';

      // Validar lista blanca si está configurada
      if (channel.senderPolicy === WhatsappSenderPolicy.WHITELIST) {
        const allowedSet = new Set(
          (channel.allowedPhones || []).map((p) => normalizeWhatsappPhone(p)),
        );
        if (!allowedSet.has(senderPhone)) {
          await this.whatsappMessageModel.create({
            companyId,
            channelId: channel.id,
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
          companyId,
          channelId: channel.id,
          externalMessageId,
          senderPhone,
          replyJid: remoteJid,
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
        companyId,
        channelId: channel.id,
        externalMessageId,
        senderPhone,
        replyJid: remoteJid,
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
          companyId,
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
            companyId,
            buffer: pdfBuffer,
            originalName: finalFileName,
            mimeType: 'application/pdf',
            source: DocumentSource.WHATSAPP,
            channelContextLabel: `WhatsApp ${senderName ? `${senderName} (+${senderPhone})` : `+${senderPhone}`}`,
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
          lastSyncMessage: `Último comprobante recibido de ${senderName || `+${senderPhone}`}.`,
        });

        await this.notificationsService.dispatch({
          type: 'channel.whatsapp_received',
          title: '📲 Comprobante recibido por WhatsApp',
          body: `Se recibió '${finalFileName}' desde ${senderName || `+${senderPhone}`}.`,
          companyId,
          extraData: { documentId: document.id, whatsappMessageId: record.id, link: '/whatsapp' },
        });

        this.gateway?.emitToCompany(companyId, 'whatsapp:message_received', {
          companyId,
          messageId: record.id,
          status: WhatsappMessageStatus.PROCESSED,
          documentId: document.id,
          fileName: finalFileName,
        });
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

        this.gateway?.emitToCompany(companyId, 'whatsapp:message_received', {
          companyId,
          messageId: record.id,
          status: WhatsappMessageStatus.ERROR,
          fileName: reportedFileName,
        });
      }
    }
  }

  async listMessages(query: QueryWhatsappMessagesDto, user: any) {
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
        { senderPhone: { [Op.iLike]: term } },
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
      this.whatsappMessageModel.findAndCountAll({
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
      this.whatsappMessageModel.count({ where: { companyId } }),
      this.whatsappMessageModel.count({
        where: { companyId, status: WhatsappMessageStatus.PROCESSED },
      }),
      this.whatsappMessageModel.count({
        where: { companyId, status: WhatsappMessageStatus.SKIPPED },
      }),
      this.whatsappMessageModel.count({
        where: { companyId, status: WhatsappMessageStatus.REJECTED_SENDER },
      }),
      this.whatsappMessageModel.count({
        where: { companyId, status: WhatsappMessageStatus.ERROR },
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
