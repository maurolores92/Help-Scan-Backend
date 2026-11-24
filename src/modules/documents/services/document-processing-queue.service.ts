import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Document, DocumentPaymentStatus, DocumentStatus } from '../document.model';
import { DocumentAiExtractorService } from './document-ai-extractor.service';
import { DocumentFiscalChecksService } from './document-fiscal-checks.service';
import { resolveDefaultPaymentStatus } from '../helpers/document-fiscal-checks.helper';
import { TenantQuotasService } from '../../plans/services/tenant-quotas.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { resolveSafeStorageFilePath } from '../../../common/utils/storage-path.util';

interface QueuedDocumentJob {
  documentId: number;
  actorUserId?: number | null;
}

// Extracción y análisis OCR/IA estrictamente de 1 en 1 para proteger CPU y RAM
const MAX_CONCURRENT_EXTRACTIONS = 1;

export type DocumentPostProcessHook = (doc: Document) => Promise<void> | void;

/**
 * Cola asíncrona controlada para procesar la extracción OCR/IA de PDFs
 * sin saturar la memoria ni el CPU del servidor ante ráfagas de escaneos SFTP.
 */
@Injectable()
export class DocumentProcessingQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentProcessingQueueService.name);
  private readonly queue: QueuedDocumentJob[] = [];
  private readonly enqueuedIds = new Set<number>();
  private readonly postProcessHooks: DocumentPostProcessHook[] = [];
  private activeWorkers = 0;

  registerPostProcessHook(hook: DocumentPostProcessHook): void {
    this.postProcessHooks.push(hook);
  }

  constructor(
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    private readonly extractorService: DocumentAiExtractorService,
    private readonly fiscalChecksService: DocumentFiscalChecksService,
    private readonly tenantQuotasService: TenantQuotasService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    try {
      const pendingDocs = await this.documentModel.findAll({
        where: {
          status: { [Op.in]: [DocumentStatus.PENDING, DocumentStatus.PROCESSING] },
        },
        attributes: ['id'],
        order: [['createdAt', 'ASC']],
        limit: 50,
      });

      for (const doc of pendingDocs) {
        this.enqueue(doc.id, null);
      }
    } catch (err: any) {
      this.logger.warn(`No se pudieron re-encolar documentos pendientes al inicio: ${err?.message}`);
    }
  }

  enqueue(documentId: number, actorUserId?: number | null): void {
    if (this.enqueuedIds.has(documentId)) return;
    this.enqueuedIds.add(documentId);
    this.queue.push({ documentId, actorUserId });
    setImmediate(() => this.drainQueue());
  }

  private drainQueue(): void {
    while (this.activeWorkers < MAX_CONCURRENT_EXTRACTIONS && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.activeWorkers++;

      this.processDocumentNow(job.documentId, job.actorUserId)
        .catch((err) => {
          this.logger.error(
            `Error no controlado en cola de documento #${job.documentId}: ${err?.message}`,
          );
        })
        .finally(() => {
          this.enqueuedIds.delete(job.documentId);
          this.activeWorkers--;
          if (this.queue.length > 0) {
            setImmediate(() => this.drainQueue());
          }
        });
    }
  }

  async processDocumentNow(
    documentId: number,
    actorUserId?: number | null,
  ): Promise<Document | null> {
    const doc = await this.documentModel.findByPk(documentId);
    if (!doc) return null;

    await doc.update({
      status: DocumentStatus.PROCESSING,
      errorMessage: null,
    });

    try {
      const fullPath = resolveSafeStorageFilePath(
        doc.filePath,
        doc.companyId,
        doc.fileName,
      );

      const extraction = await this.extractorService.extractFromFile(
        fullPath,
        doc.originalName,
        doc.companyId,
      );

      const nextStatus =
        doc.status === DocumentStatus.VALIDATED
          ? DocumentStatus.VALIDATED
          : DocumentStatus.PENDING_APPROVAL;

      const fiscalEval = await this.fiscalChecksService.evaluateDocument(
        doc.companyId,
        {
          id: doc.id,
          documentType: extraction.documentType,
          documentLetter: extraction.documentLetter,
          documentNumber: extraction.documentNumber,
          pointOfSale: extraction.pointOfSale,
          issuerTaxId: extraction.issuerTaxId,
          recipientTaxId: extraction.recipientTaxId,
          netAmount: extraction.netAmount,
          taxAmount: extraction.taxAmount,
          exemptAmount: extraction.exemptAmount,
          otherTaxesAmount: extraction.otherTaxesAmount,
          totalAmount: extraction.totalAmount,
        },
        doc.id,
      );

      const defaultPaymentStatus =
        doc.paymentStatus && doc.paymentStatus !== DocumentPaymentStatus.PENDING
          ? doc.paymentStatus
          : (resolveDefaultPaymentStatus(extraction.documentType) as DocumentPaymentStatus);

      await doc.update({
        status: nextStatus,
        paymentStatus: defaultPaymentStatus,
        duplicateOfDocumentId: fiscalEval.duplicateOfDocumentId,
        validationWarnings: fiscalEval.validationWarnings,
        documentType: extraction.documentType,
        summary: extraction.summary,
        documentNumber: extraction.documentNumber,
        documentDate: extraction.documentDate,
        dueDate: extraction.dueDate,
        issuerName: extraction.issuerName,
        issuerTaxId: extraction.issuerTaxId,
        recipientName: extraction.recipientName,
        recipientTaxId: extraction.recipientTaxId,
        recipientPhone: extraction.recipientPhone,
        recipientEmail: extraction.recipientEmail,
        deliveryAddress: extraction.deliveryAddress,
        responsiblePerson: extraction.responsiblePerson,
        currency: extraction.currency,
        netAmount: extraction.netAmount,
        taxAmount: extraction.taxAmount,
        totalAmount: extraction.totalAmount,
        paymentTerms: extraction.paymentTerms,
        paymentMethod: extraction.paymentMethod,
        referenceNumber: extraction.referenceNumber,
        cae: extraction.cae,
        taxCondition: extraction.taxCondition,
        documentLetter: extraction.documentLetter,
        pointOfSale: extraction.pointOfSale,
        caeDueDate: extraction.caeDueDate,
        purchaseOrderNumber: extraction.purchaseOrderNumber,
        exemptAmount: extraction.exemptAmount,
        otherTaxesAmount: extraction.otherTaxesAmount,
        carrierName: extraction.carrierName,
        department: extraction.department,
        branch: extraction.branch,
        period: extraction.period,
        tags: extraction.tags,
        items: (extraction as any).items || extraction.extractedData?.items || [],
        extractedData: extraction.extractedData,
        rawText: extraction.rawText,
        pageCount: extraction.pageCount,
        aiConfidence: extraction.aiConfidence,
        extractionEngine: extraction.extractionEngine,
        processedAt: new Date(),
        errorMessage: null,
      });

      console.log(
        `\x1b[92m\x1b[1m✔ [GUARDADO EXITOSO] Documento #${doc.id} ('${doc.originalName}') actualizado en base de datos (Estado: ${nextStatus})\x1b[0m`
      );

      // Contabiliza el documento procesado en `aiDocumentsProcessed` sin gastar `maxAiQueriesMonthly`
      await this.tenantQuotasService.recordDocumentAiProcessing(doc.companyId, {
        tokensUsed: extraction.tokensUsed,
      });

      // Si la extracción profunda detectó más páginas que la estimación inicial, acumula el delta
      if (extraction.pageCount && doc.pageCount && extraction.pageCount > doc.pageCount) {
        const deltaPages = extraction.pageCount - doc.pageCount;
        await this.tenantQuotasService.recordPagesUploaded(doc.companyId, deltaPages);
      }

      await this.auditService.log({
        action: AuditAction.UPDATE,
        entity: 'Document',
        entityId: doc.id,
        companyId: doc.companyId,
        userId: actorUserId ?? doc.userId ?? undefined,
        payload: {
          documentType: extraction.documentType,
          extractionEngine: extraction.extractionEngine,
          pageCount: extraction.pageCount,
          tokensUsed: extraction.tokensUsed,
        },
        description: `Extracción IA completada (${extraction.documentType}) para '${doc.originalName}'`,
      });

      const readableType = (extraction.documentType || 'documento').replace(/_/g, ' ');
      await this.notificationsService.dispatch({
        type: 'document.processed',
        title: `✨ Documento indexado (${readableType})`,
        body: extraction.issuerName
          ? `${doc.originalName} — Emisor: ${extraction.issuerName}`
          : `${doc.originalName} ya está listo para consultar`,
        companyId: doc.companyId,
        targetUserId: actorUserId ?? doc.userId ?? null,
        extraData: {
          documentId: doc.id,
          documentType: extraction.documentType,
          link: '/documents',
        },
      });

      for (const hook of this.postProcessHooks) {
        try {
          await hook(doc);
        } catch (hookErr: any) {
          this.logger.warn(
            `Error en hook post-proceso para documento #${doc.id}: ${hookErr?.message}`,
          );
        }
      }

      return doc;
    } catch (error: any) {
      const errMsg = error?.message || 'Fallo desconocido durante el análisis del PDF';
      this.logger.error(`Fallo procesando documento #${doc.id}: ${errMsg}`);

      await doc.update({
        status: DocumentStatus.ERROR,
        errorMessage: errMsg,
      });

      await this.notificationsService.dispatch({
        type: 'document.error',
        title: '⚠️ Error al procesar PDF',
        body: `No se pudo analizar '${doc.originalName}': ${errMsg}`,
        companyId: doc.companyId,
        targetUserId: actorUserId ?? doc.userId ?? null,
        extraData: { documentId: doc.id, link: '/documents' },
      });

      return doc;
    }
  }
}

