import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { col, fn, Op } from 'sequelize';
import { existsSync, unlinkSync } from 'fs';
import { Readable } from 'stream';
import {
  readDecryptedVaultFile,
  writeEncryptedVaultFile,
} from '../../common/utils/vault-crypto.util';
import { Document, DocumentSource, DocumentStatus } from './document.model';
import { QueryDocumentDto } from './dto/query-document.dto';
import { ValidateDocumentDto } from './dto/validate-document.dto';
import { RejectDocumentDto } from './dto/reject-document.dto';
import { resolveSafeStorageFilePath } from '../../common/utils/storage-path.util';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.model';
import { NotificationsService } from '../notifications/notifications.service';
import { Company } from '../companies/company.model';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';
import {
  assertValidPdfUpload,
  prepareTenantPdfStorageTarget,
} from './helpers/document-storage.helper';
import { buildDocumentSearchWhere } from './helpers/document-search.helper';
import { DocumentProcessingQueueService } from './services/document-processing-queue.service';
import { DocumentUploadQueueService } from './services/document-upload-queue.service';
import { TenantInboxWatcherService } from './services/tenant-inbox-watcher.service';
import { isPlatformSuperAdmin } from '../../common/utils/tenant-scope.util';
import pdfParse = require('pdf-parse');

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly tenantQuotasService: TenantQuotasService,
    private readonly processingQueue: DocumentProcessingQueueService,
    private readonly uploadQueue: DocumentUploadQueueService,
    private readonly inboxWatcherService: TenantInboxWatcherService,
  ) {}

  private assertValidCompanyScope(companyId?: number | null): number {
    const parsed = Number(companyId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ForbiddenException(
        'Acceso denegado: Se requiere pertenecer a una compañía activa para operar con documentos.',
      );
    }
    return parsed;
  }

  getUploadQueueStatus() {
    return this.uploadQueue.getStatus();
  }

  async uploadFromApp(
    file: Express.Multer.File,
    user: { id: number; companyId: number; role?: string; username?: string; name?: string; lastName?: string },
  ): Promise<Document> {
    if (isPlatformSuperAdmin(user)) {
      throw new ForbiddenException(
        'El Super Administrador de plataforma no puede subir documentos.',
      );
    }

    if (!user.companyId || user.companyId <= 0) {
      throw new BadRequestException('El usuario no posee una compañía asignada');
    }

    assertValidPdfUpload(file);

    // Encolado secuencial de 1 en 1 para proteger CPU, RAM y conexiones de la base de datos
    return this.uploadQueue.enqueue(
      {
        companyId: user.companyId,
        userId: user.id,
        fileName: file.originalname,
        source: 'web',
      },
      async () => {
        let pageCount = 1;
        try {
          const parsed = await pdfParse(file.buffer);
          pageCount = Math.max(1, Number(parsed?.numpages || 1));
        } catch {
          pageCount = 1;
        }

        await this.tenantQuotasService.assertCanStoreDocument(
          user.companyId,
          file.size,
          pageCount,
        );

        const target = prepareTenantPdfStorageTarget(user.companyId, file);
        const duplicate = await this.documentModel.findOne({
          where: { companyId: user.companyId, fileHash: target.fileHash },
          attributes: ['id', 'originalName'],
        });

        if (duplicate) {
          throw new BadRequestException(
            `Este archivo PDF ya se encuentra registrado en su compañía como '${duplicate.originalName}'`,
          );
        }

        writeEncryptedVaultFile(target.fullPhysicalPath, file.buffer, user.companyId);

        const document = await this.documentModel.create({
          companyId: user.companyId,
          userId: user.id,
          originalName: file.originalname,
          fileName: target.physicalFileName,
          filePath: target.relativePath,
          fileSize: file.size,
          mimeType: file.mimetype,
          pageCount,
          source: DocumentSource.APP_UPLOAD,
          status: DocumentStatus.PENDING,
          fileHash: target.fileHash,
        } as never);

        // Odómetro acumulativo estricto: suma hojas y jamás disminuye al borrar
        await this.tenantQuotasService.recordPagesUploaded(user.companyId, pageCount);

        await this.auditService.log({
          action: AuditAction.UPLOAD,
          entity: 'Document',
          entityId: document.id,
          companyId: user.companyId,
          userId: user.id,
          payload: {
            documentId: document.id,
            fileName: document.fileName,
            filePath: document.filePath,
            size: document.fileSize,
            source: document.source,
          },
          description: `Se subió el documento PDF '${document.originalName}' desde la aplicación`,
        });

        await this.notificationsService.dispatch({
          type: 'document.uploaded',
          title: '📄 Documento cargado',
          body: `Se recibió '${document.originalName}' y comenzó la extracción automática de datos con OCR`,
          companyId: user.companyId,
          actorUser: { id: user.id },
          extraData: { documentId: document.id, link: '/documents' },
        });

        this.processingQueue.enqueue(document.id, user.id);

        return document;
      },
    );
  }

  async uploadMultipleFromApp(
    files: Express.Multer.File[],
    user: { id: number; companyId: number; role?: string; username?: string; name?: string; lastName?: string },
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se han enviado archivos para subir');
    }

    const results = await Promise.allSettled(
      files.map((file) => this.uploadFromApp(file, user)),
    );

    const uploaded: Document[] = [];
    const errors: Array<{ fileName: string; reason: string }> = [];

    results.forEach((res, index) => {
      const file = files[index];
      if (res.status === 'fulfilled') {
        uploaded.push(res.value);
      } else {
        errors.push({
          fileName: file?.originalname || `Archivo #${index + 1}`,
          reason: res.reason?.message || 'Error al procesar el archivo',
        });
      }
    });

    return {
      total: files.length,
      successCount: uploaded.length,
      failedCount: errors.length,
      documents: uploaded,
      errors,
    };
  }

  async scanFtpFolder(companyId: number, actorUserId?: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    return this.inboxWatcherService.scanTenantInbox(scopedCompanyId, actorUserId);
  }

  async getFacets(companyId: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);

    const [typeRows, statusRows, departmentRows] = await Promise.all([
      this.documentModel.findAll({
        attributes: ['documentType', [fn('COUNT', col('id')), 'count']],
        where: { companyId: scopedCompanyId, documentType: { [Op.ne]: null } },
        group: ['documentType'],
        order: [[fn('COUNT', col('id')), 'DESC']],
        raw: true,
      }) as unknown as Promise<Array<{ documentType: string; count: string | number }>>,

      this.documentModel.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        where: { companyId: scopedCompanyId },
        group: ['status'],
        raw: true,
      }) as unknown as Promise<Array<{ status: string; count: string | number }>>,

      this.documentModel.findAll({
        attributes: ['department', [fn('COUNT', col('id')), 'count']],
        where: { companyId: scopedCompanyId, department: { [Op.ne]: null } },
        group: ['department'],
        order: [[fn('COUNT', col('id')), 'DESC']],
        limit: 15,
        raw: true,
      }) as unknown as Promise<Array<{ department: string; count: string | number }>>,
    ]);

    return {
      documentTypes: typeRows
        .filter((r) => Boolean(r.documentType))
        .map((r) => ({ value: r.documentType, count: Number(r.count) })),
      statuses: statusRows
        .filter((r) => Boolean(r.status))
        .map((r) => ({ value: r.status, count: Number(r.count) })),
      departments: departmentRows
        .filter((r) => Boolean(r.department))
        .map((r) => ({ value: r.department, count: Number(r.count) })),
    };
  }

  async validateDocument(
    id: number,
    companyId: number,
    userId: number,
    dto: ValidateDocumentDto,
  ) {
    const doc = await this.findById(id, companyId);

    const updatePayload: any = {
      status: DocumentStatus.VALIDATED,
      validatedByUserId: userId,
      validatedAt: new Date(),
    };

    if (dto.documentType !== undefined) updatePayload.documentType = dto.documentType;
    if (dto.documentNumber !== undefined) updatePayload.documentNumber = dto.documentNumber;
    if (dto.documentDate !== undefined) updatePayload.documentDate = dto.documentDate;
    if (dto.dueDate !== undefined) updatePayload.dueDate = dto.dueDate;
    if (dto.issuerName !== undefined) updatePayload.issuerName = dto.issuerName;
    if (dto.issuerTaxId !== undefined) updatePayload.issuerTaxId = dto.issuerTaxId;
    if (dto.recipientName !== undefined) updatePayload.recipientName = dto.recipientName;
    if (dto.recipientTaxId !== undefined) updatePayload.recipientTaxId = dto.recipientTaxId;
    if (dto.recipientPhone !== undefined) updatePayload.recipientPhone = dto.recipientPhone;
    if (dto.recipientEmail !== undefined) updatePayload.recipientEmail = dto.recipientEmail;
    if (dto.deliveryAddress !== undefined) updatePayload.deliveryAddress = dto.deliveryAddress;
    if (dto.responsiblePerson !== undefined) updatePayload.responsiblePerson = dto.responsiblePerson;
    if (dto.currency !== undefined) updatePayload.currency = dto.currency;
    if (dto.netAmount !== undefined) updatePayload.netAmount = dto.netAmount;
    if (dto.taxAmount !== undefined) updatePayload.taxAmount = dto.taxAmount;
    if (dto.totalAmount !== undefined) updatePayload.totalAmount = dto.totalAmount;
    if (dto.paymentTerms !== undefined) updatePayload.paymentTerms = dto.paymentTerms;
    if (dto.paymentMethod !== undefined) updatePayload.paymentMethod = dto.paymentMethod;
    if (dto.referenceNumber !== undefined) updatePayload.referenceNumber = dto.referenceNumber;
    if (dto.cae !== undefined) updatePayload.cae = dto.cae;
    if (dto.taxCondition !== undefined) updatePayload.taxCondition = dto.taxCondition;
    if (dto.documentLetter !== undefined) updatePayload.documentLetter = dto.documentLetter;
    if (dto.pointOfSale !== undefined) updatePayload.pointOfSale = dto.pointOfSale;
    if (dto.caeDueDate !== undefined) updatePayload.caeDueDate = dto.caeDueDate;
    if (dto.purchaseOrderNumber !== undefined) updatePayload.purchaseOrderNumber = dto.purchaseOrderNumber;
    if (dto.exemptAmount !== undefined) updatePayload.exemptAmount = dto.exemptAmount;
    if (dto.otherTaxesAmount !== undefined) updatePayload.otherTaxesAmount = dto.otherTaxesAmount;
    if (dto.carrierName !== undefined) updatePayload.carrierName = dto.carrierName;
    if (dto.department !== undefined) updatePayload.department = dto.department;
    if (dto.branch !== undefined) updatePayload.branch = dto.branch;
    if (dto.period !== undefined) updatePayload.period = dto.period;
    if (dto.summary !== undefined) updatePayload.summary = dto.summary;
    if (dto.tags !== undefined) updatePayload.tags = dto.tags;
    if (dto.validationNotes !== undefined) updatePayload.validationNotes = dto.validationNotes;
    if (dto.items !== undefined) {
      updatePayload.items = dto.items;
      updatePayload.extractedData = {
        ...(doc.extractedData || {}),
        ...(dto.extractedData || {}),
        items: dto.items,
      };
    } else if (dto.extractedData?.items !== undefined) {
      updatePayload.items = dto.extractedData.items;
      updatePayload.extractedData = {
        ...(doc.extractedData || {}),
        ...dto.extractedData,
      };
    } else if (dto.extractedData) {
      updatePayload.extractedData = {
        ...(doc.extractedData || {}),
        ...dto.extractedData,
      };
    }

    await doc.update(updatePayload);

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'Document',
      entityId: doc.id,
      companyId: doc.companyId,
      userId,
      description: `Documento #${doc.id} ('${doc.originalName}') validado y confirmado por usuario #${userId}`,
    });

    await this.notificationsService
      .dispatch({
        type: 'DOCUMENT_PROCESSED',
        companyId: doc.companyId,
        targetUserId: userId,
        title: 'Documento Validado',
        body: `El documento '${doc.originalName}' fue validado exitosamente.`,
      })
      .catch(() => null);

    return {
      message: 'Documento validado y confirmado exitosamente',
      document: doc,
    };
  }

  async rejectDocument(
    id: number,
    companyId: number,
    userId: number,
    dto: RejectDocumentDto,
  ) {
    const doc = await this.findById(id, companyId);

    await doc.update({
      status: DocumentStatus.REJECTED,
      validationNotes: dto.reason,
      validatedByUserId: userId,
      validatedAt: new Date(),
    });

    await this.auditService.log({
      action: AuditAction.STATUS_CHANGE,
      entity: 'Document',
      entityId: doc.id,
      companyId: doc.companyId,
      userId,
      description: `Documento #${doc.id} ('${doc.originalName}') rechazado: ${dto.reason}`,
    });

    await this.notificationsService
      .dispatch({
        type: 'DOCUMENT_ERROR',
        companyId: doc.companyId,
        targetUserId: userId,
        title: 'Documento Rechazado',
        body: `El documento '${doc.originalName}' fue rechazado. Motivo: ${dto.reason}`,
      })
      .catch(() => null);

    return {
      message: 'Documento marcado como rechazado',
      document: doc,
    };
  }

  async findAll(companyId: number, query: QueryDocumentDto) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const { page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;
    const where = buildDocumentSearchWhere(scopedCompanyId, query);

    const { rows, count } = await this.documentModel.findAndCountAll({
      where,
      limit,
      offset,
      attributes: { exclude: ['rawText'] },
      order: [['createdAt', 'DESC']],
      include: [{ model: Company, attributes: ['id', 'name', 'slug'] }],
    });

    return {
      data: rows,
      meta: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        itemsPerPage: limit,
      },
    };
  }

  async findById(id: number, companyId: number): Promise<Document> {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const doc = await this.documentModel.findByPk(id, {
      include: [{ model: Company, attributes: ['id', 'name', 'slug'] }],
    });

    if (!doc) {
      throw new NotFoundException(`Documento con ID ${id} no encontrado`);
    }

    if (doc.companyId !== scopedCompanyId) {
      throw new ForbiddenException('No tienes permiso para acceder a este documento');
    }

    return doc;
  }

  async reprocessDocument(
    id: number,
    companyId: number,
    actorUserId?: number,
  ) {
    const doc = await this.findById(id, companyId);
    const fullPath = resolveSafeStorageFilePath(doc.filePath, doc.companyId, doc.fileName);

    if (!existsSync(fullPath)) {
      throw new NotFoundException('El archivo PDF físico no se encuentra disponible en la bóveda');
    }

    await doc.update({
      status: DocumentStatus.PENDING,
      errorMessage: null,
    });

    this.processingQueue.enqueue(doc.id, actorUserId ?? null);

    return {
      message: `Se inició el reprocesamiento con IA de '${doc.originalName}'`,
      document: doc,
    };
  }

  async getFileStream(id: number, companyId: number) {
    const doc = await this.findById(id, companyId);
    const fullPath = resolveSafeStorageFilePath(doc.filePath, doc.companyId, doc.fileName);

    if (!existsSync(fullPath)) {
      throw new NotFoundException('El archivo físico no se encuentra en el almacenamiento');
    }

    const plainBuffer = readDecryptedVaultFile(fullPath, doc.companyId);
    const stream = Readable.from(plainBuffer);
    return { stream, plainSize: plainBuffer.length, document: doc };
  }

  async remove(id: number, companyId: number, actorUserId?: number) {
    const doc = await this.findById(id, companyId);
    const fullPath = resolveSafeStorageFilePath(doc.filePath, doc.companyId, doc.fileName);

    if (existsSync(fullPath)) {
      try {
        unlinkSync(fullPath);
      } catch (err: any) {
        this.logger.warn(`No se pudo eliminar el archivo físico ${fullPath}: ${err.message}`);
      }
    }

    await doc.destroy();

    await this.auditService.log({
      action: AuditAction.DELETE,
      entity: 'Document',
      entityId: id,
      companyId: doc.companyId,
      userId: actorUserId,
      description: `Se eliminó el documento PDF '${doc.originalName}'`,
    });

    return {
      success: true,
      message: `Documento '${doc.originalName}' eliminado correctamente`,
    };
  }

  async bulkRemove(ids: number[], companyId: number, actorUserId?: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    if (!ids || ids.length === 0) {
      return {
        success: true,
        count: 0,
        message: 'No se enviaron documentos para eliminar',
      };
    }

    const docs = await this.documentModel.findAll({
      where: {
        id: ids,
        companyId: scopedCompanyId,
      },
    });

    let deletedCount = 0;
    const deletedNames: string[] = [];

    for (const doc of docs) {
      const fullPath = resolveSafeStorageFilePath(doc.filePath, doc.companyId, doc.fileName);
      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath);
        } catch (err: any) {
          this.logger.warn(`No se pudo eliminar el archivo físico ${fullPath}: ${err.message}`);
        }
      }

      await doc.destroy();
      deletedCount++;
      if (deletedNames.length < 5) {
        deletedNames.push(doc.originalName);
      }
    }

    if (deletedCount > 0) {
      await this.auditService.log({
        action: AuditAction.DELETE,
        entity: 'Document',
        entityId: ids[0],
        companyId: scopedCompanyId,
        userId: actorUserId,
        description: `Se eliminaron en lote ${deletedCount} documentos PDF: [${deletedNames.join(', ')}${deletedCount > 5 ? ` y ${deletedCount - 5} más` : ''}]`,
      });
    }

    return {
      success: true,
      count: deletedCount,
      message: `Se eliminaron ${deletedCount} documento(s) correctamente`,
    };
  }
}
