import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { rmSync } from 'fs';
import { DocumentsService } from './documents.service';
import { Document, DocumentStatus } from './document.model';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';
import { DocumentProcessingQueueService } from './services/document-processing-queue.service';
import { DocumentUploadQueueService } from './services/document-upload-queue.service';
import { TenantInboxWatcherService } from './services/tenant-inbox-watcher.service';

describe('DocumentsService', () => {
  let service: DocumentsService;
  let documentModelMock: any;
  let auditServiceMock: any;
  let notificationsServiceMock: any;
  let tenantQuotasServiceMock: any;
  let processingQueueMock: any;
  let uploadQueueMock: any;
  let inboxWatcherMock: any;
  let tempStorageDir: string;

  beforeEach(async () => {
    tempStorageDir = path.join(os.tmpdir(), `hc-scan-docs-spec-${Date.now()}`);
    process.env.STORAGE_ROOT_PATH = tempStorageDir;

    documentModelMock = {
      create: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn(),
      findByPk: jest.fn(),
      findAndCountAll: jest.fn(),
    };

    auditServiceMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    notificationsServiceMock = {
      dispatch: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    };

    tenantQuotasServiceMock = {
      assertCanStoreDocument: jest.fn().mockResolvedValue(undefined),
      checkDocumentQuota: jest.fn().mockResolvedValue({ allowed: true }),
      notifyQuotaExceeded: jest.fn().mockResolvedValue(undefined),
      recordPagesUploaded: jest.fn().mockResolvedValue(undefined),
    };

    processingQueueMock = {
      enqueue: jest.fn(),
    };

    uploadQueueMock = {
      enqueue: jest.fn().mockImplementation((_meta, task) => task()),
      getStatus: jest.fn().mockReturnValue({ isProcessing: false, waitingCount: 0 }),
    };

    inboxWatcherMock = {
      scanTenantInbox: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: getModelToken(Document), useValue: documentModelMock },
        { provide: AuditService, useValue: auditServiceMock },
        { provide: NotificationsService, useValue: notificationsServiceMock },
        { provide: TenantQuotasService, useValue: tenantQuotasServiceMock },
        { provide: DocumentProcessingQueueService, useValue: processingQueueMock },
        { provide: DocumentUploadQueueService, useValue: uploadQueueMock },
        { provide: TenantInboxWatcherService, useValue: inboxWatcherMock },
      ],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    try {
      rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {}
  });

  it('debe estar definido el servicio', () => {
    expect(service).toBeDefined();
  });

  it('debe rechazar la subida si el archivo no es PDF o carece de cabecera %PDF-', async () => {
    // Arrange
    const mockFile = {
      originalname: 'test.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake'),
      size: 100,
    } as Express.Multer.File;

    // Act & Assert
    await expect(
      service.uploadFromApp(mockFile, { id: 1, companyId: 1 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('debe rechazar la subida si el usuario no tiene compañía', async () => {
    // Arrange
    const mockFile = {
      originalname: 'documento.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake pdf'),
      size: 100,
    } as Express.Multer.File;

    // Act & Assert
    await expect(
      service.uploadFromApp(mockFile, { id: 1, companyId: 0 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('debe rechazar la subida antes de escribir en disco si se alcanzó el límite de storage del plan', async () => {
    // Arrange
    const mockFile = {
      originalname: 'contrato.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake'),
      size: 5 * 1024 * 1024,
    } as Express.Multer.File;
    tenantQuotasServiceMock.assertCanStoreDocument.mockRejectedValueOnce(
      new BadRequestException('Límite de almacenamiento alcanzado'),
    );

    // Act & Assert
    await expect(
      service.uploadFromApp(mockFile, { id: 1, companyId: 3 }),
    ).rejects.toThrow(BadRequestException);
    expect(documentModelMock.create).not.toHaveBeenCalled();
  });

  it('debe guardar el PDF en vault/YYYY/MM y encolar el procesamiento IA al subir desde la app', async () => {
    // Arrange
    const mockFile = {
      originalname: 'Factura Proveedor Sur.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 contenido valido'),
      size: 2048,
    } as Express.Multer.File;

    const createdDoc = {
      id: 77,
      companyId: 2,
      originalName: mockFile.originalname,
      fileName: 'Factura_Proveedor_Sur_123.pdf',
      filePath: 'tenancy/company_2/vault/2026/10/Factura_Proveedor_Sur_123.pdf',
      fileSize: 2048,
      source: 'APP_UPLOAD',
      status: DocumentStatus.PENDING,
    };
    documentModelMock.create.mockResolvedValueOnce(createdDoc);

    // Act
    const result = await service.uploadFromApp(mockFile, { id: 9, companyId: 2 });

    // Assert
    expect(result).toEqual(createdDoc);
    expect(processingQueueMock.enqueue).toHaveBeenCalledWith(77, 9);
  });

  it('debe rechazar archivos PDF duplicados con idéntico hash SHA-256 en la misma compañía', async () => {
    // Arrange
    const mockFile = {
      originalname: 'remito_repetido.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 contenido identico'),
      size: 1024,
    } as Express.Multer.File;
    documentModelMock.findOne.mockResolvedValueOnce({
      id: 12,
      originalName: 'remito_original.pdf',
    });

    // Act & Assert
    await expect(
      service.uploadFromApp(mockFile, { id: 5, companyId: 2 }),
    ).rejects.toThrow(BadRequestException);
    expect(documentModelMock.create).not.toHaveBeenCalled();
  });

  it('debe prohibir al superadmin subir documentos dado que no pertenece a ninguna compañía', async () => {
    // Arrange
    const mockFile = {
      originalname: 'factura.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 contenido'),
      size: 512,
    } as Express.Multer.File;

    // Act & Assert
    await expect(
      service.uploadFromApp(mockFile, {
        id: 1,
        companyId: 1,
        role: 'superadmin',
        username: 'superadmin',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(documentModelMock.create).not.toHaveBeenCalled();
  });

  it('debe permitir la subida múltiple de archivos PDF procesando cada uno de forma segura', async () => {
    // Arrange
    const file1 = {
      originalname: 'Factura_1.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 file 1'),
      size: 1024,
    } as Express.Multer.File;
    const file2 = {
      originalname: 'Factura_2.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 file 2'),
      size: 1024,
    } as Express.Multer.File;

    documentModelMock.create
      .mockResolvedValueOnce({ id: 101, originalName: 'Factura_1.pdf', companyId: 2 })
      .mockResolvedValueOnce({ id: 102, originalName: 'Factura_2.pdf', companyId: 2 });

    // Act
    const result = await service.uploadMultipleFromApp([file1, file2], { id: 9, companyId: 2 });

    // Assert
    expect(result.total).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.documents.length).toBe(2);
  });

  it('debe bloquear el acceso si una compañía intenta consultar un documento de otra compañía', async () => {
    // Arrange
    documentModelMock.findByPk.mockResolvedValueOnce({
      id: 50,
      companyId: 2,
      originalName: 'privado_empresa_2.pdf',
    });

    // Act & Assert
    await expect(service.findById(50, 1)).rejects.toThrow(ForbiddenException);
  });

  it('debe validar y confirmar un documento actualizando sus atributos y estado a VALIDATED', async () => {
    // Arrange
    const mockDoc = {
      id: 99,
      companyId: 2,
      originalName: 'factura_0001.pdf',
      status: DocumentStatus.PENDING_APPROVAL,
      update: jest.fn().mockResolvedValue(true),
    };
    documentModelMock.findByPk.mockResolvedValueOnce(mockDoc);

    // Act
    const result = await service.validateDocument(99, 2, 5, {
      documentType: 'factura',
      totalAmount: 47819.20,
      purchaseOrderNumber: 'OC-7016',
      cae: '86406410012207',
    });

    // Assert
    expect(mockDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DocumentStatus.VALIDATED,
        validatedByUserId: 5,
        documentType: 'factura',
        totalAmount: 47819.20,
        purchaseOrderNumber: 'OC-7016',
        cae: '86406410012207',
      }),
    );
    expect(result.message).toContain('validado');
  });

  it('debe rechazar un documento guardando el motivo y estado REJECTED', async () => {
    // Arrange
    const mockDoc = {
      id: 101,
      companyId: 2,
      originalName: 'presupuesto_roto.pdf',
      status: DocumentStatus.PENDING_APPROVAL,
      update: jest.fn().mockResolvedValue(true),
    };
    documentModelMock.findByPk.mockResolvedValueOnce(mockDoc);

    // Act
    const result = await service.rejectDocument(101, 2, 5, {
      reason: 'El documento es ilegible',
    });

    // Assert
    expect(mockDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DocumentStatus.REJECTED,
        validationNotes: 'El documento es ilegible',
        validatedByUserId: 5,
      }),
    );
    expect(result.message).toContain('rechazado');
  });
});
