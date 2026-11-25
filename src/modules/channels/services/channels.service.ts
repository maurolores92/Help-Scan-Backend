import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as crypto from 'crypto';
import { Op } from 'sequelize';
import {
  CompanyEmailChannel,
  EmailProviderType,
  EmailSenderPolicy,
  EmailSyncStatus,
} from '../models/company-email-channel.model';
import { EmailMessage, EmailMessageStatus } from '../models/email-message.model';
import { UpsertEmailChannelDto } from '../dto/upsert-email-channel.dto';
import { TestEmailConnectionDto } from '../dto/test-email-connection.dto';
import { QueryEmailMessagesDto } from '../dto/query-email-messages.dto';
import { FetchedEmailItem, ImapClientService } from './imap-client.service';
import { DocumentsService } from '../../documents/documents.service';
import { Document, DocumentSource } from '../../documents/document.model';
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
import { detectReceiptInEmailBody } from '../helpers/email-receipt-detector.helper';
import {
  convertImageBufferToPdf,
  synthesizeEmailBodyToPdf,
} from '../helpers/email-pdf-synthesizer.helper';
import { normalizeInboundEmailWebhookPayload } from '../helpers/inbound-email-webhook.helper';
import {
  isEmailSenderAuthorized,
  normalizeAllowedEmailSenders,
  normalizeEmailSenderRule,
} from '../helpers/email-sender-policy.helper';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly syncingCompanies = new Set<number>();
  private channelChangeListeners: Array<(companyId: number) => void> = [];

  constructor(
    @InjectModel(CompanyEmailChannel)
    private readonly emailChannelModel: typeof CompanyEmailChannel,
    @InjectModel(EmailMessage)
    private readonly emailMessageModel: typeof EmailMessage,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly imapClient: ImapClientService,
    private readonly documentsService: DocumentsService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly notificationsGateway?: NotificationsGateway,
  ) {}

  registerChannelChangeListener(listener: (companyId: number) => void): void {
    this.channelChangeListeners.push(listener);
  }

  private notifyChannelChanged(companyId: number): void {
    for (const listener of this.channelChangeListeners) {
      try {
        listener(companyId);
      } catch { }
    }
  }

  private generateWebhookSecret(): string {
    return crypto.randomBytes(20).toString('hex');
  }

  private assertTenantUser(user: { companyId?: number | null; role?: string }): number {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no gestiona buzones de correo privados de compañías.',
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

  private toSafeChannelResponse(channel: CompanyEmailChannel | null) {
    if (!channel) {
      return null;
    }
    const plain = channel.toJSON() as any;
    const hasPassword = Boolean(plain.encryptedPassword);
    delete plain.encryptedPassword;
    return {
      ...plain,
      senderPolicy: plain.senderPolicy || EmailSenderPolicy.ALL,
      allowedSenders: Array.isArray(plain.allowedSenders) ? plain.allowedSenders : [],
      hasPassword,
    };
  }

  async getEmailChannelConfig(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.emailChannelModel.findOne({
      where: { companyId },
    });

    if (channel && !channel.webhookSecret) {
      await channel.update({ webhookSecret: this.generateWebhookSecret() });
    }

    return {
      configured: Boolean(channel),
      channel: this.toSafeChannelResponse(channel),
    };
  }

  async upsertEmailChannelConfig(dto: UpsertEmailChannelDto, user: any) {
    const companyId = this.assertTenantUser(user);
    const existing = await this.emailChannelModel.findOne({ where: { companyId } });

    let encryptedPassword = existing?.encryptedPassword || '';
    if (dto.password && dto.password.trim().length > 0) {
      encryptedPassword = encryptFtpSecret(dto.password.trim());
    } else if (!existing) {
      throw new BadRequestException(
        'Debe ingresar la contraseña o Contraseña de Aplicación para conectar el correo.',
      );
    }

    const webhookSecret = existing?.webhookSecret || this.generateWebhookSecret();
    const senderPolicy =
      dto.senderPolicy || existing?.senderPolicy || EmailSenderPolicy.ALL;

    let allowedSenders: string[] = Array.isArray(existing?.allowedSenders)
      ? existing.allowedSenders
      : [];

    if (dto.allowedSenders !== undefined) {
      for (const rawEntry of dto.allowedSenders) {
        const trimmed = String(rawEntry || '').trim();
        if (!trimmed) continue;
        if (!normalizeEmailSenderRule(trimmed)) {
          throw new BadRequestException(
            `El remitente o dominio '${trimmed}' no es válido. Usá un correo exacto (ej: facturas@empresa.com) o un dominio (ej: @empresa.com).`,
          );
        }
      }
      allowedSenders = normalizeAllowedEmailSenders(dto.allowedSenders);
    }

    if (
      senderPolicy === EmailSenderPolicy.WHITELIST &&
      allowedSenders.length === 0
    ) {
      throw new BadRequestException(
        'Agregá al menos un correo o dominio autorizado para activar la lista blanca.',
      );
    }

    const payload = {
      companyId,
      provider: dto.provider || EmailProviderType.GMAIL,
      host: dto.host.trim(),
      port: Number(dto.port) || 993,
      secure: dto.secure !== false,
      emailUser: dto.emailUser.trim().toLowerCase(),
      encryptedPassword,
      folder: (dto.folder || 'INBOX').trim() || 'INBOX',
      isActive: dto.isActive !== undefined ? dto.isActive : true,
      processBodyWithoutAttachments:
        dto.processBodyWithoutAttachments !== undefined
          ? dto.processBodyWithoutAttachments
          : true,
      markAsRead: dto.markAsRead !== undefined ? dto.markAsRead : true,
      syncIntervalMinutes: dto.syncIntervalMinutes || 5,
      senderPolicy,
      allowedSenders,
      webhookSecret,
    };

    let saved: CompanyEmailChannel;
    if (existing) {
      await existing.update(payload);
      saved = existing;
    } else {
      saved = await this.emailChannelModel.create(payload as never);
    }

    this.notifyChannelChanged(companyId);

    await this.auditService.log({
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: 'CompanyEmailChannel',
      entityId: saved.id,
      companyId,
      userId: user.id,
      payload: {
        provider: saved.provider,
        host: saved.host,
        port: saved.port,
        emailUser: saved.emailUser,
        isActive: saved.isActive,
        senderPolicy: saved.senderPolicy,
        allowedSendersCount: saved.allowedSenders?.length || 0,
      },
      description: `${existing ? 'Actualizó' : 'Configuró'} el canal de correo IMAP/Webhook (${saved.emailUser})`,
    });

    await this.notificationsService.dispatch({
      type: 'channel.email_configured',
      title: '📧 Canal de Correo Configurado',
      body: `Se conectó la casilla '${saved.emailUser}' para ingesta automática por correo o webhook.`,
      companyId,
      extraData: { channelId: saved.id, link: '/channels' },
    });

    return {
      message: 'Configuración de correo electrónico guardada correctamente',
      channel: this.toSafeChannelResponse(saved),
    };
  }

  async regenerateWebhookSecret(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.emailChannelModel.findOne({ where: { companyId } });
    if (!channel) {
      throw new NotFoundException(
        'Primero configurá y guardá tu canal de correo para generar la URL del webhook.',
      );
    }

    const newSecret = this.generateWebhookSecret();
    await channel.update({ webhookSecret: newSecret });

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'CompanyEmailChannel',
      entityId: channel.id,
      companyId,
      userId: user.id,
      description: 'Regeneró el token secreto del Webhook de correo entrante',
    });

    return {
      message: 'Token de webhook regenerado correctamente',
      channel: this.toSafeChannelResponse(channel),
    };
  }

  async testEmailConnection(dto: TestEmailConnectionDto, user: any) {
    const companyId = this.assertTenantUser(user);
    let plainPassword = dto.password?.trim() || '';

    if (!plainPassword) {
      const existing = await this.emailChannelModel.findOne({ where: { companyId } });
      if (!existing?.encryptedPassword) {
        throw new BadRequestException(
          'Ingresa la contraseña o Contraseña de Aplicación para probar la conexión.',
        );
      }
      plainPassword = decryptFtpSecret(existing.encryptedPassword);
    }

    try {
      return await this.imapClient.testConnection({
        host: dto.host,
        port: dto.port,
        secure: dto.secure !== false,
        emailUser: dto.emailUser,
        password: plainPassword,
        folder: dto.folder || 'INBOX',
      });
    } catch (err: any) {
      throw new BadRequestException(err?.message || 'Error al probar conexión IMAP');
    }
  }

  async triggerManualSync(user: any) {
    const companyId = this.assertTenantUser(user);
    return this.syncCompanyEmailChannel(companyId, user.id);
  }

  /**
   * Procesa un correo individual proveniente tanto de sincronización IMAP como de Webhook entrante,
   * generando documentos PDF, enviando notificaciones push/WebSocket y actualizando la bandeja en vivo.
   */
  private async processFetchedEmailItem(
    channel: CompanyEmailChannel,
    companyId: number,
    item: FetchedEmailItem,
    actorUserId?: number | null,
    originLabel: 'IMAP' | 'WEBHOOK' = 'IMAP',
  ): Promise<{
    alreadyStored: boolean;
    ignoredUnauthorized?: boolean;
    createdDocuments: number;
    synthesized: number;
    skipped: number;
    errors: number;
    emailRecordId?: number;
  }> {
    if (
      !isEmailSenderAuthorized(
        item.senderEmail,
        channel.senderPolicy,
        channel.allowedSenders,
      )
    ) {
      return {
        alreadyStored: false,
        ignoredUnauthorized: true,
        createdDocuments: 0,
        synthesized: 0,
        skipped: 0,
        errors: 0,
      };
    }

    const alreadyStored = await this.emailMessageModel.findOne({
      where: { companyId, messageId: item.messageId },
      attributes: ['id'],
    });
    if (alreadyStored) {
      return {
        alreadyStored: true,
        createdDocuments: 0,
        synthesized: 0,
        skipped: 0,
        errors: 0,
      };
    }

    const attachmentNames = item.attachments.map((a) => a.filename);
    const emailRecord = await this.emailMessageModel.create({
      companyId,
      channelId: channel.id,
      messageId: item.messageId,
      imapUid: item.uid || 0,
      senderName: item.senderName,
      senderEmail: item.senderEmail,
      subject: item.subject,
      receivedAt: item.receivedAt,
      bodyText: item.bodyText ? item.bodyText.slice(0, 40000) : null,
      bodyHtmlSanitized: item.bodyHtmlSanitized
        ? item.bodyHtmlSanitized.slice(0, 80000)
        : null,
      attachmentsCount: item.attachments.length,
      attachmentNames,
      status: EmailMessageStatus.SKIPPED,
      generatedDocumentIds: [],
    } as never);

    const generatedIds: number[] = [];
    const errorsList: string[] = [];
    let createdDocuments = 0;
    let synthesized = 0;
    let skipped = 0;
    let errors = 0;

    // 1. Procesar adjuntos PDF o imágenes escaneadas
    for (const att of item.attachments) {
      const lowerName = att.filename.toLowerCase();
      const isPdf =
        att.contentType.includes('pdf') || lowerName.endsWith('.pdf');
      const isImage =
        att.contentType.includes('jpeg') ||
        att.contentType.includes('jpg') ||
        att.contentType.includes('png') ||
        lowerName.endsWith('.jpg') ||
        lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png');

      if (!isPdf && !isImage) {
        continue;
      }

      try {
        let pdfBuffer = att.content;
        let finalFileName = att.filename;

        if (isImage) {
          pdfBuffer = await convertImageBufferToPdf(
            att.content,
            att.contentType,
            att.filename,
          );
          finalFileName = `${att.filename.replace(/\.(png|jpe?g)$/i, '')}.pdf`;
        }

        const result = await this.documentsService.ingestPdfFromChannel({
          companyId,
          buffer: pdfBuffer,
          originalName: finalFileName,
          mimeType: 'application/pdf',
          source: DocumentSource.EMAIL,
          sourceEmailId: emailRecord.id,
          actorUserId,
          channelContextLabel: `${originLabel === 'WEBHOOK' ? 'Webhook ' : ''}De: ${item.senderEmail}`,
        });

        generatedIds.push(result.document.id);
        if (!result.isDuplicate) {
          createdDocuments++;
        }
      } catch (attErr: any) {
        errorsList.push(`${att.filename}: ${attErr?.message}`);
      }
    }

    // 2. Si no hubo documentos desde adjuntos, evaluar cuerpo transaccional sin adjuntos
    if (generatedIds.length === 0 && errorsList.length === 0) {
      if (channel.processBodyWithoutAttachments) {
        const detection = detectReceiptInEmailBody(
          item.subject,
          item.bodyText || '',
        );

        if (detection.isReceipt) {
          try {
            const synthesizedBuffer = await synthesizeEmailBodyToPdf({
              senderName: item.senderName,
              senderEmail: item.senderEmail,
              subject: item.subject,
              receivedAt: item.receivedAt,
              bodyText: item.bodyText || item.subject,
            });

            const safeTitle = (item.subject || 'comprobante')
              .replace(/[^a-zA-Z0-9_-]+/g, '_')
              .slice(0, 45);
            const result = await this.documentsService.ingestPdfFromChannel({
              companyId,
              buffer: synthesizedBuffer,
              originalName: `email_${safeTitle}_${emailRecord.id}.pdf`,
              mimeType: 'application/pdf',
              source: DocumentSource.EMAIL,
              sourceEmailId: emailRecord.id,
              actorUserId,
              channelContextLabel: `Cuerpo Email - ${item.senderEmail}`,
            });

            generatedIds.push(result.document.id);
            synthesized = 1;
            if (!result.isDuplicate) {
              createdDocuments++;
            }

            await emailRecord.update({
              status: EmailMessageStatus.SYNTHESIZED_BODY,
              statusReason: detection.reason,
              documentId: result.document.id,
              generatedDocumentIds: generatedIds,
            });
          } catch (synthErr: any) {
            errorsList.push(`Síntesis PDF: ${synthErr?.message}`);
          }
        } else {
          skipped = 1;
          await emailRecord.update({
            status: EmailMessageStatus.SKIPPED,
            statusReason: detection.reason,
          });
        }
      } else {
        skipped = 1;
        await emailRecord.update({
          status: EmailMessageStatus.SKIPPED,
          statusReason:
            'Correo sin adjuntos PDF válidos (conversión de cuerpo desactivada).',
        });
      }
    }

    if (generatedIds.length > 0 && synthesized === 0) {
      await emailRecord.update({
        status: EmailMessageStatus.PROCESSED,
        statusReason:
          errorsList.length > 0
            ? `Procesado parcialmente (${errorsList.join('; ')})`
            : `${generatedIds.length} archivo(s) guardado(s) en bóveda.`,
        documentId: generatedIds[0],
        generatedDocumentIds: generatedIds,
      });
    } else if (generatedIds.length === 0 && errorsList.length > 0) {
      errors = 1;
      await emailRecord.update({
        status: EmailMessageStatus.ERROR,
        statusReason: errorsList.join('; ') || 'Error al procesar adjuntos',
      });
    }

    // 3. Emitir notificación y evento WebSocket en vivo hacia el frontend de la compañía
    if (generatedIds.length > 0) {
      await this.notificationsService.dispatch({
        type: 'channel.email_received',
        title: '📬 Comprobante recibido por Correo',
        body: `Se recibió '${item.subject}' desde ${item.senderName || item.senderEmail}.`,
        companyId,
        extraData: {
          documentId: generatedIds[0],
          emailMessageId: emailRecord.id,
          origin: originLabel,
          link: '/emails',
        },
      });
    } else if (errors > 0) {
      await this.notificationsService.dispatch({
        type: 'document.error',
        title: '⚠️ Error al procesar correo recibido',
        body: `'${item.subject}' de ${item.senderEmail}: ${errorsList[0] || 'Error'}`,
        companyId,
        extraData: { emailMessageId: emailRecord.id, link: '/emails' },
      });
    }

    this.notificationsGateway?.emitToCompany(companyId, 'email:received', {
      companyId,
      emailMessageId: emailRecord.id,
      status: emailRecord.status,
      documentIds: generatedIds,
      senderEmail: item.senderEmail,
      subject: item.subject,
      origin: originLabel,
    });

    return {
      alreadyStored: false,
      createdDocuments,
      synthesized,
      skipped,
      errors,
      emailRecordId: emailRecord.id,
    };
  }

  /**
   * Endpoint Webhook público para ingesta instantánea de correos sin depender del botón Sincronizar.
   */
  async ingestEmailFromWebhook(
    companyId: number,
    providedToken: string,
    rawBody: any,
  ) {
    const channel = await this.emailChannelModel.findOne({ where: { companyId } });
    if (!channel) {
      throw new NotFoundException('La compañía no tiene un canal de correo configurado.');
    }

    const expectedToken = (channel.webhookSecret || '').trim();
    const cleanToken = (providedToken || '').trim();
    if (
      !expectedToken ||
      !cleanToken ||
      expectedToken.length !== cleanToken.length ||
      !crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(cleanToken))
    ) {
      throw new UnauthorizedException('Token de webhook inválido para esta compañía.');
    }

    const company = await this.companyModel.findByPk(companyId, {
      attributes: ['id', 'status', 'enabledModules'],
    });
    const enabledModules = Array.isArray(company?.enabledModules)
      ? company.enabledModules
      : [];
    if (
      !company ||
      company.status !== CompanyStatus.ACTIVE ||
      !enabledModules.includes('email')
    ) {
      throw new ForbiddenException(
        'El módulo de correo no está habilitado o la compañía se encuentra inactiva.',
      );
    }

    const normalizedItem = normalizeInboundEmailWebhookPayload(rawBody, (html) =>
      this.imapClient.sanitizeEmailHtml(html),
    );

    const outcome = await this.processFetchedEmailItem(
      channel,
      companyId,
      normalizedItem,
      null,
      'WEBHOOK',
    );

    await channel.update({
      lastSyncAt: new Date(),
      lastSyncStatus: outcome.errors > 0 ? EmailSyncStatus.ERROR : EmailSyncStatus.OK,
      lastSyncMessage: outcome.ignoredUnauthorized
        ? `Webhook ignorado (remitente ${normalizedItem.senderEmail} no autorizado).`
        : outcome.alreadyStored
          ? 'Webhook duplicado ignorado (correo ya procesado).'
          : `Webhook recibido: '${normalizedItem.subject}' de ${normalizedItem.senderEmail}.`,
    });

    return {
      ok: true,
      duplicate: outcome.alreadyStored,
      ignoredUnauthorized: Boolean(outcome.ignoredUnauthorized),
      emailMessageId: outcome.emailRecordId ?? null,
      createdDocuments: outcome.createdDocuments,
      synthesizedCount: outcome.synthesized,
      skippedCount: outcome.skipped,
      errorsCount: outcome.errors,
    };
  }

  async syncCompanyEmailChannel(companyId: number, actorUserId?: number | null) {
    if (this.syncingCompanies.has(companyId)) {
      return {
        skipped: true,
        message: 'Ya existe una sincronización en curso para esta compañía.',
      };
    }

    const channel = await this.emailChannelModel.findOne({ where: { companyId } });
    if (!channel) {
      throw new NotFoundException('La compañía no tiene un canal de correo configurado.');
    }

    this.syncingCompanies.add(companyId);
    const syncStartedAt = new Date();
    let processedEmails = 0;
    let createdDocuments = 0;
    let synthesizedCount = 0;
    let skippedCount = 0;
    let errorsCount = 0;

    try {
      const plainPassword = decryptFtpSecret(channel.encryptedPassword);
      const shouldProcessSender =
        channel.senderPolicy === EmailSenderPolicy.WHITELIST
          ? (senderEmail: string) =>
              isEmailSenderAuthorized(
                senderEmail,
                channel.senderPolicy,
                channel.allowedSenders,
              )
          : undefined;

      const unreadEmails = await this.imapClient.fetchUnreadEmails(
        {
          host: channel.host,
          port: channel.port,
          secure: channel.secure,
          emailUser: channel.emailUser,
          password: plainPassword,
          folder: channel.folder,
        },
        {
          maxBatch: 20,
          markAsRead: channel.markAsRead,
          shouldProcessSender,
        },
      );

      for (const item of unreadEmails) {
        const outcome = await this.processFetchedEmailItem(
          channel,
          companyId,
          item,
          actorUserId,
          'IMAP',
        );
        if (outcome.alreadyStored || outcome.ignoredUnauthorized) continue;
        processedEmails++;
        createdDocuments += outcome.createdDocuments;
        synthesizedCount += outcome.synthesized;
        skippedCount += outcome.skipped;
        errorsCount += outcome.errors;
      }

      const summaryMsg =
        processedEmails === 0
          ? channel.senderPolicy === EmailSenderPolicy.WHITELIST
            ? 'Buzón revisado: no se encontraron correos nuevos de remitentes autorizados.'
            : 'Buzón revisado: no se encontraron correos nuevos sin leer.'
          : `Sincronización completada: ${processedEmails} revisado(s), ${createdDocuments} PDF(s) creado(s), ${skippedCount} omitido(s).`;

      await channel.update({
        lastSyncAt: syncStartedAt,
        lastSyncStatus: EmailSyncStatus.OK,
        lastSyncMessage: summaryMsg,
      });

      return {
        ok: true,
        processedEmails,
        createdDocuments,
        synthesizedCount,
        skippedCount,
        errorsCount,
        message: summaryMsg,
      };
    } catch (err: any) {
      const errMsg = err?.message || 'Error inesperado durante sincronización IMAP';
      await channel.update({
        lastSyncAt: syncStartedAt,
        lastSyncStatus: EmailSyncStatus.ERROR,
        lastSyncMessage: errMsg,
      });
      this.logger.warn(`Error sincronizando correo compañía #${companyId}: ${errMsg}`);
      if (actorUserId) {
        throw new BadRequestException(errMsg);
      }
      return {
        ok: false,
        message: errMsg,
      };
    } finally {
      this.syncingCompanies.delete(companyId);
    }
  }

  async listEmailMessages(query: QueryEmailMessagesDto, user: any) {
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
        { senderEmail: { [Op.iLike]: term } },
        { senderName: { [Op.iLike]: term } },
        { subject: { [Op.iLike]: term } },
      ];
    }

    const [
      { rows, count },
      totalAll,
      processedCount,
      synthesizedCount,
      skippedCount,
      errorCount,
    ] = await Promise.all([
      this.emailMessageModel.findAndCountAll({
        where,
        include: [
          {
            model: Document,
            as: 'document',
            attributes: ['id', 'originalName', 'documentType', 'totalAmount', 'status'],
            required: false,
          },
        ],
        attributes: { exclude: ['bodyHtmlSanitized'] },
        order: [['receivedAt', 'DESC'], ['id', 'DESC']],
        limit,
        offset,
      }),
      this.emailMessageModel.count({ where: { companyId } }),
      this.emailMessageModel.count({
        where: { companyId, status: EmailMessageStatus.PROCESSED },
      }),
      this.emailMessageModel.count({
        where: { companyId, status: EmailMessageStatus.SYNTHESIZED_BODY },
      }),
      this.emailMessageModel.count({
        where: { companyId, status: EmailMessageStatus.SKIPPED },
      }),
      this.emailMessageModel.count({
        where: { companyId, status: EmailMessageStatus.ERROR },
      }),
    ]);

    return {
      items: rows,
      total: count,
      page,
      limit,
      stats: {
        total: totalAll,
        processed: processedCount + synthesizedCount,
        skipped: skippedCount,
        errors: errorCount,
      },
    };
  }

  async getEmailMessageById(id: number, user: any) {
    const companyId = this.assertTenantUser(user);
    const record = await this.emailMessageModel.findOne({
      where: { id, companyId },
      include: [
        {
          model: Document,
          as: 'document',
          attributes: ['id', 'originalName', 'documentType', 'totalAmount', 'status', 'issuerName'],
          required: false,
        },
      ],
    });

    if (!record) {
      throw new NotFoundException('Correo electrónico no encontrado en su compañía.');
    }

    return record;
  }

  /**
   * Rescata manualmente un correo que fue omitido o tuvo error, convirtiendo su cuerpo
   * en un documento PDF cifrado dentro de la bóveda para procesarlo con la IA.
   */
  async rescueEmailMessageToDocument(id: number, user: any) {
    const companyId = this.assertTenantUser(user);
    const email = await this.emailMessageModel.findOne({ where: { id, companyId } });
    if (!email) {
      throw new NotFoundException('Correo electrónico no encontrado en su compañía.');
    }

    if (email.documentId) {
      const existingDoc = await Document.findOne({ where: { id: email.documentId, companyId } });
      if (existingDoc) {
        return {
          message: 'Este correo ya tiene un documento vinculado en la bóveda.',
          emailMessage: email,
          document: existingDoc,
        };
      }
    }

    const bodyToRender =
      email.bodyText?.trim() ||
      (email.bodyHtmlSanitized
        ? email.bodyHtmlSanitized.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '') ||
      email.subject;

    const pdfBuffer = await synthesizeEmailBodyToPdf({
      senderName: email.senderName,
      senderEmail: email.senderEmail,
      subject: email.subject,
      receivedAt: email.receivedAt,
      bodyText: bodyToRender,
    });

    const safeTitle = (email.subject || 'correo')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 45);

    const { document } = await this.documentsService.ingestPdfFromChannel({
      companyId,
      buffer: pdfBuffer,
      originalName: `rescate_${safeTitle}_${email.id}.pdf`,
      mimeType: 'application/pdf',
      source: DocumentSource.EMAIL,
      sourceEmailId: email.id,
      actorUserId: user.id,
      channelContextLabel: `Rescate manual - ${email.senderEmail}`,
    });

    const mergedIds = Array.from(
      new Set([...(email.generatedDocumentIds || []), document.id]),
    );

    await email.update({
      status: EmailMessageStatus.SYNTHESIZED_BODY,
      statusReason: 'Rescatado manualmente desde el visor de correos recibidos.',
      documentId: document.id,
      generatedDocumentIds: mergedIds,
    });

    await this.auditService.log({
      action: AuditAction.PROCESS_DOCUMENT,
      entity: 'EmailMessage',
      entityId: email.id,
      companyId,
      userId: user.id,
      payload: { documentId: document.id, subject: email.subject },
      description: `Rescató manualmente el correo '${email.subject}' como documento PDF #${document.id}`,
    });

    return {
      message: 'Correo convertido a PDF y encolado para extracción inteligente.',
      emailMessage: email,
      document,
    };
  }
}
