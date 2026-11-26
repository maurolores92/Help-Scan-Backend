import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as chokidar from 'chokidar';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { Company } from '../../companies/company.model';
import { Document, DocumentSource, DocumentStatus } from '../document.model';
import { FtpDevice } from '../../ftp-devices/ftp-device.model';
import { TenantQuotasService } from '../../plans/services/tenant-quotas.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { NotificationsService } from '../../notifications/notifications.service';
import { DocumentProcessingQueueService } from './document-processing-queue.service';
import { DocumentUploadQueueService } from './document-upload-queue.service';
import {
  ensureTenantDirectories,
  getStorageRootPath,
} from '../../../common/utils/storage-path.util';
import {
  computeBufferSha256,
  isValidPdfBufferHeader,
  moveInboxFileToQuarantine,
  moveInboxFileToVault,
} from '../helpers/document-storage.helper';
import pdfParse = require('pdf-parse');

export interface InboxSyncSummary {
  syncedCount: number;
  imported: number;
  skippedByQuotaCount: number;
  duplicatesCount: number;
  invalidCount: number;
  quotaReached: boolean;
  quotaMessage?: string;
  newDocuments: Document[];
}

export interface FtpDeviceIngestContext {
  id: number;
  deviceName: string;
}

const DEFAULT_INBOX_POLL_INTERVAL_MS = 5000;
const MIN_INBOX_FILE_SETTLE_MS = 1800;

/**
 * Servicio Watcher en tiempo real (`chokidar`) + barrido liviano sobre `inbox/`
 * que observa `storage/tenancy/company_<id>[_<slug>]/inbox`
 * (incluyendo subcarpetas por equipo HP) para detectar PDFs enviados vía SFTP/FTPS/FTP.
 */
@Injectable()
export class TenantInboxWatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TenantInboxWatcherService.name);
  private watcher: chokidar.FSWatcher | null = null;
  private pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private isPollingSweepRunning = false;
  private readonly watchedCompanyIds = new Set<number>();
  private readonly processingPaths = new Set<string>();

  constructor(
    @InjectModel(Company) private readonly companyModel: typeof Company,
    @InjectModel(Document) private readonly documentModel: typeof Document,
    @InjectModel(FtpDevice) private readonly ftpDeviceModel: typeof FtpDevice,
    private readonly tenantQuotasService: TenantQuotasService,
    private readonly processingQueue: DocumentProcessingQueueService,
    private readonly uploadQueue: DocumentUploadQueueService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_INBOX_WATCHER === 'true') {
      return;
    }

    try {
      const companies = await this.companyModel.findAll({ attributes: ['id'] });
      const tenancyRoot = join(getStorageRootPath(), 'tenancy');
      if (!existsSync(tenancyRoot)) {
        mkdirSync(tenancyRoot, { recursive: true });
      }

      for (const comp of companies) {
        ensureTenantDirectories(comp.id);
        this.watchedCompanyIds.add(comp.id);
      }

      this.watcher = chokidar.watch(tenancyRoot, {
        persistent: true,
        ignoreInitial: false,
        depth: 5,
        awaitWriteFinish: {
          stabilityThreshold: 2500,
          pollInterval: 300,
        },
        ignored: /(^|[\/\\])\..|[\/\\](vault|quarantine|images|whatsapp_sessions?)([\/\\]|$)|(\.part|\.tmp|\.crdownload|desktop\.ini)$/i,
      });

      this.watcher.on('add', (filePath: string) => {
        this.handleDetectedFile(filePath).catch((err) => {
          this.logger.error(`Error procesando archivo detectado '${filePath}': ${err?.message}`);
        });
      });

      this.startFallbackInboxPolling();

      this.logger.log(
        `👁️ Watcher SFTP/Local activo sobre storage/tenancy (${companies.length} compañía(s) aprovisionadas)`,
      );
    } catch (err: any) {
      this.logger.error(`No se pudo iniciar TenantInboxWatcherService: ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollIntervalHandle) {
      clearInterval(this.pollIntervalHandle);
      this.pollIntervalHandle = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private startFallbackInboxPolling(): void {
    const rawInterval = Number(process.env.FTP_INBOX_POLL_INTERVAL_MS);
    const intervalMs = Number.isFinite(rawInterval)
      ? rawInterval
      : DEFAULT_INBOX_POLL_INTERVAL_MS;

    if (intervalMs <= 0) return;

    this.pollIntervalHandle = setInterval(() => {
      void this.runFallbackInboxSweep();
    }, intervalMs);
    this.pollIntervalHandle.unref?.();
  }

  /**
   * Barrido ligero exclusivo sobre carpetas `inbox/` de cada tenant.
   * Complementa a `chokidar` y al webhook SFTPGo cuando el volumen montado
   * no propaga eventos inotify entre contenedores o sistemas de archivos en red.
   */
  async runFallbackInboxSweep(): Promise<number> {
    if (this.isPollingSweepRunning) return 0;
    this.isPollingSweepRunning = true;

    let detectedCount = 0;
    try {
      const tenancyRoot = join(getStorageRootPath(), 'tenancy');
      if (!existsSync(tenancyRoot)) return 0;

      const companyDirs = readdirSync(tenancyRoot, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && /^company_(\d+)(?:_.+)?$/.test(entry.name),
      );

      for (const dirEntry of companyDirs) {
        const match = dirEntry.name.match(/^company_(\d+)(?:_.+)?$/);
        if (!match) continue;
        const companyId = Number(match[1]);
        const inboxDir = join(tenancyRoot, dirEntry.name, 'inbox');
        if (!existsSync(inboxDir)) continue;

        const files = this.collectInboxFiles(inboxDir);
        for (const fullPath of files) {
          if (this.processingPaths.has(fullPath) || !existsSync(fullPath)) continue;

          try {
            const stats = statSync(fullPath);
            if (Date.now() - stats.mtimeMs < MIN_INBOX_FILE_SETTLE_MS) {
              continue;
            }
          } catch {
            continue;
          }

          const outcome = await this.ingestSingleInboxFile(
            companyId,
            fullPath,
            undefined,
            true,
          );
          if (outcome.status === 'imported') {
            detectedCount++;
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error en barrido periódico de inbox SFTP: ${err?.message}`);
    } finally {
      this.isPollingSweepRunning = false;
    }

    return detectedCount;
  }

  /**
   * Aprovisiona y registra en caliente el directorio `inbox/` de una nueva compañía sin reiniciar NestJS.
   */
  registerTenantInbox(companyId: number): string {
    const { inboxDir } = ensureTenantDirectories(companyId);
    if (!this.watchedCompanyIds.has(companyId)) {
      this.watchedCompanyIds.add(companyId);
      if (this.watcher) {
        this.watcher.add(inboxDir);
        this.logger.log(`Nueva bandeja inbox registrada en vivo para company_${companyId}`);
      }
    }
    return inboxDir;
  }

  /**
   * Escanea bajo demanda todos los archivos presentes en `storage/tenancy/company_<id>/inbox`.
   */
  async scanTenantInbox(
    companyId: number,
    actorUserId?: number,
  ): Promise<InboxSyncSummary> {
    const { inboxDir } = ensureTenantDirectories(companyId);
    const summary: InboxSyncSummary = {
      syncedCount: 0,
      imported: 0,
      skippedByQuotaCount: 0,
      duplicatesCount: 0,
      invalidCount: 0,
      quotaReached: false,
      newDocuments: [],
    };

    if (!existsSync(inboxDir)) return summary;

    const files = this.collectInboxFiles(inboxDir);
    for (const fullPath of files) {
      if (!existsSync(fullPath)) continue;

      const outcome = await this.ingestSingleInboxFile(companyId, fullPath, actorUserId, false);
      if (outcome.status === 'imported' && outcome.document) {
        summary.syncedCount++;
        summary.imported++;
        summary.newDocuments.push(outcome.document);
      } else if (outcome.status === 'quota_exceeded') {
        summary.skippedByQuotaCount++;
        summary.quotaReached = true;
        if (!summary.quotaMessage) summary.quotaMessage = outcome.reason;
      } else if (outcome.status === 'duplicate') {
        summary.duplicatesCount++;
      } else if (outcome.status === 'invalid') {
        summary.invalidCount++;
      }
    }

    if (summary.skippedByQuotaCount > 0 && summary.quotaMessage) {
      await this.tenantQuotasService.notifyQuotaExceeded(
        companyId,
        `${summary.quotaMessage} (${summary.skippedByQuotaCount} archivo(s) movidos a cuarentena).`,
      );
    }

    return summary;
  }

  private collectInboxFiles(dirPath: string, depth = 0): string[] {
    if (depth > 4 || !existsSync(dirPath)) return [];
    const results: string[] = [];

    for (const entry of readdirSync(dirPath)) {
      if (entry.startsWith('.') || /\.(part|tmp|crdownload)$/i.test(entry)) continue;
      const fullPath = join(dirPath, entry);
      if (!existsSync(fullPath)) continue;

      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        results.push(...this.collectInboxFiles(fullPath, depth + 1));
      } else if (stats.isFile()) {
        results.push(fullPath);
      }
    }

    return results;
  }

  private extractInboxLocationFromPath(
    filePath: string,
  ): { companyId: number; subFolder: string | null } | null {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/\/tenancy\/company_(\d+)(?:_[^/]+)?\/inbox\/(.+)$/);
    if (!match) return null;

    const companyId = Number(match[1]);
    const relativeInsideInbox = match[2];
    const parts = relativeInsideInbox.split('/').filter(Boolean);
    const subFolder = parts.length > 1 ? parts[0] : null;
    return { companyId, subFolder };
  }

  private async resolveDeviceForPath(
    companyId: number,
    fullPath: string,
    explicitContext?: FtpDeviceIngestContext,
  ): Promise<FtpDeviceIngestContext | null> {
    if (explicitContext) return explicitContext;

    const location = this.extractInboxLocationFromPath(fullPath);
    if (!location?.subFolder) return null;

    const device = await this.ftpDeviceModel.findOne({
      where: { companyId, subFolder: location.subFolder },
      attributes: ['id', 'deviceName'],
    });

    return device ? { id: device.id, deviceName: device.deviceName } : null;
  }

  private async handleDetectedFile(filePath: string): Promise<void> {
    const location = this.extractInboxLocationFromPath(filePath);
    if (!location) return;

    await this.ingestSingleInboxFile(location.companyId, filePath, undefined, true);
  }

  async ingestSingleInboxFile(
    companyId: number,
    fullPath: string,
    actorUserId?: number,
    notifyQuotaImmediately = true,
    explicitDeviceContext?: FtpDeviceIngestContext,
  ): Promise<{
    status: 'imported' | 'duplicate' | 'invalid' | 'quota_exceeded' | 'skipped';
    document?: Document;
    reason?: string;
  }> {
    if (this.processingPaths.has(fullPath) || !existsSync(fullPath)) {
      return { status: 'skipped' };
    }

    this.processingPaths.add(fullPath);
    try {
      const originalName = basename(fullPath);

      // Serializar la ingesta de escaneos FTP en la cola secuencial 1 a 1
      return await this.uploadQueue.enqueue(
        {
          companyId,
          userId: actorUserId,
          fileName: originalName,
          source: 'ftp',
        },
        async () => {
          if (!existsSync(fullPath)) {
            return { status: 'skipped' as const };
          }
          const ext = extname(originalName).toLowerCase();
          const stats = statSync(fullPath);
          const deviceCtx = await this.resolveDeviceForPath(
            companyId,
            fullPath,
            explicitDeviceContext,
          );

          if (ext !== '.pdf' || stats.size === 0) {
            moveInboxFileToQuarantine(companyId, fullPath, 'invalid');
            await this.notifyRejectedFile(companyId, originalName, 'Extensión no PDF o archivo vacío', deviceCtx);
            return { status: 'invalid' as const, reason: 'Extensión no PDF o archivo vacío' };
          }

          const fileBuffer = readFileSync(fullPath);
          if (!isValidPdfBufferHeader(fileBuffer)) {
            moveInboxFileToQuarantine(companyId, fullPath, 'invalid');
            await this.notifyRejectedFile(companyId, originalName, 'Cabecera binaria PDF inválida', deviceCtx);
            return { status: 'invalid' as const, reason: 'Cabecera binaria PDF inválida' };
          }

          const fileHash = computeBufferSha256(fileBuffer);
          const duplicate = await this.documentModel.findOne({
            where: { companyId, fileHash },
            attributes: ['id', 'originalName'],
          });

          if (duplicate) {
            moveInboxFileToQuarantine(companyId, fullPath, 'duplicate');
            this.logger.warn(
              `[Inbox company_${companyId}] PDF duplicado detectado ('${originalName}' == doc #${duplicate.id}); movido a quarantine.`,
            );
            return { status: 'duplicate' as const };
          }

          let pageCount = 1;
          try {
            const parsed = await pdfParse(fileBuffer);
            pageCount = Math.max(1, Number(parsed?.numpages || 1));
          } catch {
            pageCount = 1;
          }

          const quotaCheck = await this.tenantQuotasService.checkDocumentQuota(
            companyId,
            stats.size,
            pageCount,
          );
          if (!quotaCheck.allowed) {
            moveInboxFileToQuarantine(companyId, fullPath, 'quota');
            if (notifyQuotaImmediately && quotaCheck.reason) {
              await this.tenantQuotasService.notifyQuotaExceeded(companyId, quotaCheck.reason);
            }
            return { status: 'quota_exceeded' as const, reason: quotaCheck.reason };
          }

          const moved = moveInboxFileToVault(companyId, fullPath, originalName);
          const doc = await this.documentModel.create({
            companyId,
            userId: actorUserId ?? null,
            originalName,
            fileName: moved.physicalFileName,
            filePath: moved.relativePath,
            fileSize: moved.fileSize,
            mimeType: 'application/pdf',
            pageCount,
            source: DocumentSource.FTP,
            status: DocumentStatus.PENDING,
            fileHash: moved.fileHash,
            ftpDeviceId: deviceCtx?.id ?? null,
            ftpDeviceName: deviceCtx?.deviceName ?? null,
          } as never);

          // Odómetro acumulativo estricto: suma hojas y jamás disminuye al borrar
          await this.tenantQuotasService.recordPagesUploaded(companyId, pageCount);

          if (deviceCtx) {
            await this.ftpDeviceModel.increment(
              { scannedCount: 1 },
              { where: { id: deviceCtx.id, companyId } },
            );
            await this.ftpDeviceModel.update(
              { lastFileAt: new Date() },
              { where: { id: deviceCtx.id, companyId } },
            );
          }

          await this.auditService.log({
            action: AuditAction.UPLOAD,
            entity: 'Document',
            entityId: doc.id,
            companyId,
            userId: actorUserId,
            payload: {
              documentId: doc.id,
              originalName,
              filePath: moved.relativePath,
              size: moved.fileSize,
              source: DocumentSource.FTP,
              ftpDeviceId: deviceCtx?.id ?? null,
              ftpDeviceName: deviceCtx?.deviceName ?? null,
            },
            description: deviceCtx
              ? `PDF recibido desde '${deviceCtx.deviceName}' y cifrado en bóveda: '${originalName}'`
              : `PDF detectado automáticamente en inbox y cifrado en bóveda: '${originalName}'`,
          });

          await this.notificationsService.dispatch({
            type: 'document.uploaded',
            title: deviceCtx
              ? `🖨️ Nuevo escaneo de ${deviceCtx.deviceName}`
              : '📥 Nuevo PDF detectado en carpeta / SFTP',
            body: `Se recibió '${originalName}' y comenzó su extracción automática OCR`,
            companyId,
            actorUser: actorUserId ? { id: actorUserId } : null,
            extraData: { documentId: doc.id, ftpDeviceId: deviceCtx?.id, link: '/documents' },
          });

          this.processingQueue.enqueue(doc.id, actorUserId ?? null);
          void this.processingQueue.emitCompanyQueueSnapshot?.(companyId);
          this.emitFtpUploadedEvents(companyId, doc, deviceCtx);

          return { status: 'imported' as const, document: doc };
        },
      );
    } finally {
      this.processingPaths.delete(fullPath);
    }
  }

  private emitFtpUploadedEvents(
    companyId: number,
    doc: Document,
    deviceCtx: FtpDeviceIngestContext | null,
  ): void {
    const uploadedPayload = {
      companyId,
      documentId: doc.id,
      originalName: doc.originalName,
      source: doc.source,
      status: doc.status,
      ftpDeviceId: deviceCtx?.id ?? null,
      ftpDeviceName: deviceCtx?.deviceName ?? null,
      createdAt: doc.createdAt ?? new Date().toISOString(),
    };
    this.notificationsService.emitCompanyEvent?.(
      companyId,
      'documents:ftp-uploaded',
      uploadedPayload,
    );
    this.notificationsService.emitCompanyEvent?.(companyId, 'documents:updated', {
      companyId,
      documentId: doc.id,
      status: doc.status,
      source: doc.source,
      action: 'ftp-uploaded',
    });
  }

  private async notifyRejectedFile(
    companyId: number,
    originalName: string,
    reason: string,
    deviceCtx: FtpDeviceIngestContext | null,
  ): Promise<void> {
    try {
      await this.notificationsService.dispatch({
        type: 'ftp_device.file_rejected',
        title: '🚫 Archivo FTP rechazado',
        body: deviceCtx
          ? `'${originalName}' enviado por '${deviceCtx.deviceName}' fue movido a cuarentena (${reason}).`
          : `'${originalName}' recibido en bandeja FTP fue movido a cuarentena (${reason}).`,
        companyId,
        extraData: { ftpDeviceId: deviceCtx?.id, link: '/printers-ftp' },
      });
    } catch (err: any) {
      this.logger.warn(`No se pudo emitir notificación ftp_device.file_rejected: ${err?.message}`);
    }
  }
}
