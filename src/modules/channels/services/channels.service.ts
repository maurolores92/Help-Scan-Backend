import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  CompanyEmailChannel,
  EmailProviderType,
  EmailSyncStatus,
} from '../models/company-email-channel.model';
import { EmailMessage, EmailMessageStatus } from '../models/email-message.model';
import { UpsertEmailChannelDto } from '../dto/upsert-email-channel.dto';
import { TestEmailConnectionDto } from '../dto/test-email-connection.dto';
import { QueryEmailMessagesDto } from '../dto/query-email-messages.dto';
import { ImapClientService } from './imap-client.service';
import { DocumentsService } from '../../documents/documents.service';
import { Document, DocumentSource } from '../../documents/document.model';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { NotificationsService } from '../../notifications/notifications.service';
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

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly syncingCompanies = new Set<number>();

  constructor(
    @InjectModel(CompanyEmailChannel)
    private readonly emailChannelModel: typeof CompanyEmailChannel,
    @InjectModel(EmailMessage)
    private readonly emailMessageModel: typeof EmailMessage,
    private readonly imapClient: ImapClientService,
    private readonly documentsService: DocumentsService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

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
      hasPassword,
    };
  }

  async getEmailChannelConfig(user: any) {
    const companyId = this.assertTenantUser(user);
    const channel = await this.emailChannelModel.findOne({
      where: { companyId },
    });
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
    };

    let saved: CompanyEmailChannel;
    if (existing) {
      await existing.update(payload);
      saved = existing;
    } else {
      saved = await this.emailChannelModel.create(payload as never);
    }

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
      },
      description: `${existing ? 'Actualizó' : 'Configuró'} el canal de correo IMAP (${saved.emailUser})`,
    });

    await this.notificationsService.dispatch({
      type: 'channel.email_configured',
      title: '📧 Canal de Correo Configurado',
      body: `Se conectó la casilla '${saved.emailUser}' para ingesta automática de comprobantes`,
      companyId,
      actorUser: { id: user.id },
      extraData: { channelId: saved.id, link: '/channels' },
    });

    return {
      message: 'Configuración de correo electrónico guardada correctamente',
      channel: this.toSafeChannelResponse(saved),
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
      const unreadEmails = await this.imapClient.fetchUnreadEmails(
        {
          host: channel.host,
          port: channel.port,
          secure: channel.secure,
          emailUser: channel.emailUser,
          password: plainPassword,
          folder: channel.folder,
        },
        { maxBatch: 20, markAsRead: channel.markAsRead },
      );

      for (const item of unreadEmails) {
        processedEmails++;
        const alreadyStored = await this.emailMessageModel.findOne({
          where: { companyId, messageId: item.messageId },
          attributes: ['id'],
        });
        if (alreadyStored) {
          continue;
        }

        const attachmentNames = item.attachments.map((a) => a.filename);
        const emailRecord = await this.emailMessageModel.create({
          companyId,
          channelId: channel.id,
          messageId: item.messageId,
          imapUid: item.uid,
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
              channelContextLabel: `De: ${item.senderEmail}`,
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
                synthesizedCount++;
                if (!result.isDuplicate) {
                  createdDocuments++;
                }

                await emailRecord.update({
                  status: EmailMessageStatus.SYNTHESIZED_BODY,
                  statusReason: detection.reason,
                  documentId: result.document.id,
                  generatedDocumentIds: generatedIds,
                });
                continue;
              } catch (synthErr: any) {
                errorsList.push(`Síntesis PDF: ${synthErr?.message}`);
              }
            } else {
              skippedCount++;
              await emailRecord.update({
                status: EmailMessageStatus.SKIPPED,
                statusReason: detection.reason,
              });
              continue;
            }
          } else {
            skippedCount++;
            await emailRecord.update({
              status: EmailMessageStatus.SKIPPED,
              statusReason:
                'Correo sin adjuntos PDF válidos (conversión de cuerpo desactivada).',
            });
            continue;
          }
        }

        if (generatedIds.length > 0) {
          await emailRecord.update({
            status: EmailMessageStatus.PROCESSED,
            statusReason:
              errorsList.length > 0
                ? `Procesado parcialmente (${errorsList.join('; ')})`
                : `${generatedIds.length} archivo(s) guardado(s) en bóveda.`,
            documentId: generatedIds[0],
            generatedDocumentIds: generatedIds,
          });
        } else {
          errorsCount++;
          await emailRecord.update({
            status: EmailMessageStatus.ERROR,
            statusReason: errorsList.join('; ') || 'Error al procesar adjuntos',
          });
        }
      }

      const summaryMsg =
        processedEmails === 0
          ? 'Buzón revisado: no se encontraron correos nuevos sin leer.'
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
