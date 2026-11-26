import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { BadRequestException } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { TenantInboxWatcherService } from './tenant-inbox-watcher.service';
import { Company } from '../../companies/company.model';
import { Document } from '../document.model';
import { FtpDevice } from '../../ftp-devices/ftp-device.model';
import { TenantQuotasService } from '../../plans/services/tenant-quotas.service';
import { DocumentProcessingQueueService } from './document-processing-queue.service';
import { DocumentUploadQueueService } from './document-upload-queue.service';
import { AuditService } from '../../audit/audit.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  ensureTenantDirectories,
  sanitizeTenantId,
} from '../../../common/utils/storage-path.util';
import {
  decryptVaultBuffer,
  isEncryptedVaultBuffer,
} from '../../../common/utils/vault-crypto.util';

describe('TenantInboxWatcherService & Multitenant Storage Isolation', () => {
  let service: TenantInboxWatcherService;
  let documentModelMock: any;
  let tenantQuotasMock: any;
  let processingQueueMock: any;
  let ftpDeviceModelMock: any;
  let notificationsServiceMock: any;
  let tempStorageDir: string;

  beforeEach(async () => {
    tempStorageDir = path.join(os.tmpdir(), `hc-scan-inbox-spec-${Date.now()}`);
    process.env.STORAGE_ROOT_PATH = tempStorageDir;

    documentModelMock = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (payload) => ({
        id: 501,
        ...payload,
      })),
    };

    tenantQuotasMock = {
      checkDocumentQuota: jest.fn().mockResolvedValue({ allowed: true }),
      notifyQuotaExceeded: jest.fn().mockResolvedValue(undefined),
      recordPagesUploaded: jest.fn().mockResolvedValue(undefined),
    };

    processingQueueMock = {
      enqueue: jest.fn(),
      emitCompanyQueueSnapshot: jest.fn().mockResolvedValue(undefined),
    };

    ftpDeviceModelMock = {
      findOne: jest.fn().mockResolvedValue(null),
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    notificationsServiceMock = {
      dispatch: jest.fn().mockResolvedValue(undefined),
      emitCompanyEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantInboxWatcherService,
        { provide: getModelToken(Company), useValue: { findAll: jest.fn().mockResolvedValue([]) } },
        { provide: getModelToken(Document), useValue: documentModelMock },
        {
          provide: getModelToken(FtpDevice),
          useValue: ftpDeviceModelMock,
        },
        { provide: TenantQuotasService, useValue: tenantQuotasMock },
        { provide: DocumentProcessingQueueService, useValue: processingQueueMock },
        {
          provide: DocumentUploadQueueService,
          useValue: {
            enqueue: jest.fn().mockImplementation((_meta, task) => task()),
            getStatus: jest.fn().mockReturnValue({ isProcessing: false, waitingCount: 0 }),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: NotificationsService,
          useValue: notificationsServiceMock,
        },
      ],
    }).compile();

    service = module.get<TenantInboxWatcherService>(TenantInboxWatcherService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    try {
      rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {}
  });

  it('debe crear las subcarpetas aisladas inbox, vault y quarantine y bloquear intentos de Path Traversal', () => {
    // Arrange & Act
    const dirs = ensureTenantDirectories(7);

    // Assert
    expect(existsSync(dirs.inboxDir)).toBe(true);
    expect(existsSync(dirs.vaultDir)).toBe(true);
    expect(existsSync(dirs.quarantineDir)).toBe(true);
    expect(() => sanitizeTenantId('../etc/passwd')).toThrow(BadRequestException);
    expect(() => sanitizeTenantId(0)).toThrow(BadRequestException);
  });

  it('debe mover un PDF válido desde inbox hacia vault/YYYY/MM, persistirlo y encolar extracción IA', async () => {
    // Arrange
    const { inboxDir } = ensureTenantDirectories(4);
    const incomingPdfPath = path.join(inboxDir, 'HP_LaserJet_Scan_01.pdf');
    writeFileSync(incomingPdfPath, Buffer.from('%PDF-1.4 escaneo impresora HP'));

    // Act
    const summary = await service.scanTenantInbox(4, 15);

    // Assert
    expect(summary.imported).toBe(1);
    expect(existsSync(incomingPdfPath)).toBe(false);
    expect(documentModelMock.create).toHaveBeenCalledTimes(1);
    expect(processingQueueMock.enqueue).toHaveBeenCalledWith(501, 15);
  });

  it('debe enviar a quarantine los archivos duplicados o rechazados por cupo de almacenamiento', async () => {
    // Arrange
    const { inboxDir, quarantineDir } = ensureTenantDirectories(8);
    const dupPath = path.join(inboxDir, 'duplicado.pdf');
    const quotaPath = path.join(inboxDir, 'excede_cupo.pdf');
    writeFileSync(dupPath, Buffer.from('%PDF-1.4 archivo 1'));
    writeFileSync(quotaPath, Buffer.from('%PDF-1.4 archivo 2'));

    documentModelMock.findOne
      .mockResolvedValueOnce({ id: 99, originalName: 'duplicado_previo.pdf' })
      .mockResolvedValueOnce(null);

    tenantQuotasMock.checkDocumentQuota.mockResolvedValueOnce({
      allowed: false,
      reason: 'Se alcanzó el tope de documentos del plan.',
    });

    // Act
    const summary = await service.scanTenantInbox(8);

    // Assert
    expect(summary.imported).toBe(0);
    expect(summary.duplicatesCount).toBe(1);
    expect(summary.skippedByQuotaCount).toBe(1);
    const quarantinedFiles = readdirSync(quarantineDir);
    expect(quarantinedFiles.length).toBe(2);
  });

  it('cifra en reposo el PDF movido a vault y lo atribuye a la impresora HP según subcarpeta de inbox', async () => {
    const { inboxDir, vaultDir } = ensureTenantDirectories(6);
    const hpSubDir = path.join(inboxDir, 'hp-e52645-recepcion');
    mkdirSync(hpSubDir, { recursive: true });
    const rawPdf = Buffer.from('%PDF-1.6 Escaneo factura AFIP desde E52645');
    writeFileSync(path.join(hpSubDir, 'scan_recepcion.pdf'), rawPdf);

    const summary = await service.scanTenantInbox(6, 21);
    expect(summary.imported).toBe(1);

    const createdPayload = documentModelMock.create.mock.calls[0][0];
    const vaultRelative = createdPayload.filePath.replace(/^tenancy\/company_6\/vault\//, '');
    const encryptedDiskBytes = readFileSync(path.join(vaultDir, vaultRelative));

    expect(isEncryptedVaultBuffer(encryptedDiskBytes)).toBe(true);
    expect(decryptVaultBuffer(encryptedDiskBytes, 6).equals(rawPdf)).toBe(true);
  });

  it('detecta automáticamente PDFs en carpetas company_<id>_<slug>/inbox/<subFolder> durante el barrido y emite eventos WebSocket', async () => {
    const { inboxDir } = ensureTenantDirectories(9, 'Impresora Norte');
    const hpSubDir = path.join(inboxDir, 'hp-e52645-norte');
    mkdirSync(hpSubDir, { recursive: true });
    const settledPdfPath = path.join(hpSubDir, 'escaneo_auto.pdf');
    writeFileSync(settledPdfPath, Buffer.from('%PDF-1.5 Escaneo automatico sin pulsar boton'));

    const oldTime = new Date(Date.now() - 5000);
    utimesSync(settledPdfPath, oldTime, oldTime);

    ftpDeviceModelMock.findOne.mockResolvedValueOnce({
      id: 77,
      deviceName: 'HP E52645 Norte',
    });

    const importedCount = await service.runFallbackInboxSweep();

    expect(importedCount).toBe(1);
    expect(existsSync(settledPdfPath)).toBe(false);
    expect(ftpDeviceModelMock.findOne).toHaveBeenCalledWith({
      where: { companyId: 9, subFolder: 'hp-e52645-norte' },
      attributes: ['id', 'deviceName'],
    });
    expect(processingQueueMock.emitCompanyQueueSnapshot).toHaveBeenCalledWith(9);
    expect(notificationsServiceMock.emitCompanyEvent).toHaveBeenCalledWith(
      9,
      'documents:ftp-uploaded',
      expect.objectContaining({
        companyId: 9,
        documentId: 501,
        originalName: 'escaneo_auto.pdf',
        ftpDeviceId: 77,
        ftpDeviceName: 'HP E52645 Norte',
      }),
    );
    expect(notificationsServiceMock.emitCompanyEvent).toHaveBeenCalledWith(
      9,
      'documents:updated',
      expect.objectContaining({
        companyId: 9,
        documentId: 501,
        action: 'ftp-uploaded',
      }),
    );
  });

  it('omite durante el barrido archivos recién creados (<1.8s) para no ingerir transferencias FTP incompletas', async () => {
    const { inboxDir } = ensureTenantDirectories(12, 'Taller');
    const freshPdfPath = path.join(inboxDir, 'en_progreso.pdf');
    writeFileSync(freshPdfPath, Buffer.from('%PDF-1.4 escribiendo'));

    const importedCount = await service.runFallbackInboxSweep();

    expect(importedCount).toBe(0);
    expect(existsSync(freshPdfPath)).toBe(true);
    expect(documentModelMock.create).not.toHaveBeenCalled();
  });
});

