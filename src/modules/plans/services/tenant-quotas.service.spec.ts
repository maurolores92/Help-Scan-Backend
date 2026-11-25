import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { TenantQuotasService } from './tenant-quotas.service';
import { CompanyQuotaSummaryService } from './company-quota-summary.service';
import { Company, CompanyStatus } from '../../companies/company.model';
import { Users } from '../../users/users.model';
import { Document } from '../../documents/document.model';
import { FtpDevice } from '../../ftp-devices/ftp-device.model';
import { CompanyMonthlyUsage } from '../models/company-monthly-usage.model';
import { NotificationsService } from '../../notifications/notifications.service';
import { AuditService } from '../../audit/audit.service';

describe('TenantQuotasService', () => {
  let service: TenantQuotasService;
  let companyModelMock: any;
  let userModelMock: any;
  let documentModelMock: any;
  let monthlyUsageModelMock: any;
  let ftpDeviceModelMock: any;
  let notificationsServiceMock: any;
  let auditServiceMock: any;
  let sequelizeMock: any;

  beforeEach(async () => {
    companyModelMock = {
      findByPk: jest.fn(),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    userModelMock = {
      count: jest.fn(),
      findAll: jest.fn(),
    };
    documentModelMock = {
      findAll: jest.fn(),
    };
    monthlyUsageModelMock = {
      findOne: jest.fn(),
      findAll: jest.fn(),
      findOrCreate: jest.fn(),
    };
    ftpDeviceModelMock = {
      count: jest.fn().mockResolvedValue(0),
      findAll: jest.fn().mockResolvedValue([]),
    };
    notificationsServiceMock = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    auditServiceMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    sequelizeMock = {
      transaction: jest.fn().mockResolvedValue({
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantQuotasService,
        CompanyQuotaSummaryService,
        { provide: getModelToken(Company), useValue: companyModelMock },
        { provide: getModelToken(Users), useValue: userModelMock },
        { provide: getModelToken(Document), useValue: documentModelMock },
        { provide: getModelToken(FtpDevice), useValue: ftpDeviceModelMock },
        { provide: getModelToken(CompanyMonthlyUsage), useValue: monthlyUsageModelMock },
        { provide: Sequelize, useValue: sequelizeMock },
        { provide: NotificationsService, useValue: notificationsServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();

    service = module.get<TenantQuotasService>(TenantQuotasService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('debe bloquear la creación de usuario cuando se alcanza el límite del plan asociado', async () => {
    // Arrange
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 10,
      name: 'Acme S.A.',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: 5,
        maxDocuments: 500,
        maxStorageMb: 2048,
        maxAiQueriesMonthly: 250,
      },
    });
    userModelMock.count.mockResolvedValueOnce(5);

    // Act & Assert
    await expect(service.assertCanCreateOrActivateUser(10)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('debe permitir usuarios ilimitados cuando el plan define maxUsers en null', async () => {
    // Arrange
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 11,
      name: 'Enterprise Corp',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: null,
        maxDocuments: null,
        maxStorageMb: null,
        maxAiQueriesMonthly: null,
      },
    });

    // Act & Assert
    await expect(service.assertCanCreateOrActivateUser(11)).resolves.toBeUndefined();
    expect(userModelMock.count).not.toHaveBeenCalled();
  });

  it('debe bloquear la subida de documento si supera maxStorageMb del plan', async () => {
    // Arrange
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 12,
      name: 'Pyme Docs',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: 5,
        maxDocuments: 100,
        maxStorageMb: 10,
        maxAiQueriesMonthly: 100,
      },
    });
    documentModelMock.findAll.mockResolvedValueOnce([
      { docsCount: 2, totalBytes: 9 * 1024 * 1024 },
    ]);

    // Act & Assert
    await expect(
      service.assertCanStoreDocument(12, 3 * 1024 * 1024),
    ).rejects.toThrow(BadRequestException);
    expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'company.quota_exceeded', companyId: 12 }),
    );
  });

  it('debe bloquear consultas de IA cuando se alcanza el cupo mensual y permitir consumir si hay saldo', async () => {
    // Arrange (bloqueado al tope)
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 15,
      name: 'AI Tenant',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: 5,
        maxDocuments: 100,
        maxStorageMb: 1024,
        maxAiQueriesMonthly: 10,
      },
    });
    monthlyUsageModelMock.findOne.mockResolvedValueOnce({ aiQueriesCount: 10 });

    // Act & Assert (bloqueo)
    await expect(service.assertCanExecuteAiQuery(15)).rejects.toThrow(
      ForbiddenException,
    );

    // Arrange (consumo exitoso con saldo disponible)
    const usageRecordMock = {
      aiQueriesCount: 4,
      tokensUsed: 1500,
      increment: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
    };
    companyModelMock.findByPk.mockResolvedValue({
      id: 15,
      name: 'AI Tenant',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: 5,
        maxDocuments: 100,
        maxStorageMb: 1024,
        maxAiQueriesMonthly: 10,
      },
    });
    monthlyUsageModelMock.findOne.mockResolvedValueOnce({ aiQueriesCount: 3 });
    monthlyUsageModelMock.findOrCreate.mockResolvedValueOnce([usageRecordMock, false]);

    // Act
    const usage = await service.consumeAiQuery(15, { tokensUsed: 500, actorUserId: 1 });

    // Assert
    expect(usageRecordMock.increment).toHaveBeenCalledWith(
      { aiQueriesCount: 1, aiDocumentsProcessed: 0, tokensUsed: 500 },
      expect.any(Object),
    );
    expect(usage).toBe(usageRecordMock);
    expect(auditServiceMock.log).toHaveBeenCalledTimes(1);
  });

  it('debe contabilizar aiDocumentsProcessed al procesar un PDF sin descontar consultas de Chat IA', async () => {
    // Arrange
    const usageRecordMock = {
      aiQueriesCount: 2,
      aiDocumentsProcessed: 5,
      tokensUsed: 1200,
      increment: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
    };
    monthlyUsageModelMock.findOrCreate.mockResolvedValueOnce([usageRecordMock, false]);

    // Act
    const result = await service.recordDocumentAiProcessing(20, { tokensUsed: 840 });

    // Assert
    expect(usageRecordMock.increment).toHaveBeenCalledWith(
      { aiDocumentsProcessed: 1, tokensUsed: 840 },
      expect.any(Object),
    );
    expect(companyModelMock.increment).toHaveBeenCalledWith(
      { totalDocumentsProcessed: 1 },
      expect.objectContaining({ where: { id: 20 } }),
    );
    expect(result).toBe(usageRecordMock);
  });

  it('debe bloquear la subida si se supera el límite de archivos almacenados en bóveda', async () => {
    // Arrange
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 30,
      name: 'Imprenta Express',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      plan: {
        maxUsers: 5,
        maxPages: 100,
        maxDocuments: 100,
        maxStorageMb: 2048,
        maxAiQueriesMonthly: null,
      },
    });
    documentModelMock.findAll.mockResolvedValueOnce([
      { docsCount: 100, totalBytes: 50 * 1024 * 1024 },
    ]);

    // Act & Assert (intentar subir un archivo cuando ya hay 100 almacenados)
    await expect(
      service.assertCanStoreDocument(30, 1024, 5),
    ).rejects.toThrow(BadRequestException);
    expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'company.quota_exceeded', companyId: 30 }),
    );
  });

  it('calcula resumen de archivos almacenados y facturación adicional en ARS por documento procesado', async () => {
    companyModelMock.findByPk.mockResolvedValueOnce({
      id: 40,
      name: 'Facturadora S.A.',
      status: CompanyStatus.ACTIVE,
      useCustomLimits: false,
      totalDocumentsProcessed: 25,
      enabledModules: ['documents', 'email'],
      plan: {
        id: 2,
        name: 'Pro',
        slug: 'pro',
        badgeColor: 'primary',
        maxUsers: 10,
        maxDocuments: 1000,
        maxStorageMb: 1024,
        maxAiQueriesMonthly: null,
        pricePerProcessedDocumentArs: 150,
      },
    });
    userModelMock.findAll.mockResolvedValueOnce([{ companyId: 40, activeCount: 3 }]);
    documentModelMock.findAll.mockResolvedValueOnce([
      { companyId: 40, docsCount: 120, totalBytes: 128 * 1024 * 1024 },
    ]);
    monthlyUsageModelMock.findAll.mockResolvedValueOnce([
      { companyId: 40, aiQueriesCount: 0, tokensUsed: 5000, aiDocumentsProcessed: 18, pagesCount: 30 },
    ]);

    const summary = await service.getCompanyQuotaSummary(40);

    expect(summary.documents).toEqual({
      current: 120,
      max: 1000,
      unlimited: false,
      percentage: 12,
    });
    expect(summary.storageMb.max).toBe(1024);
    expect(summary.totalDocumentsProcessed).toBe(25);
    expect(summary.channels).toEqual(
      expect.objectContaining({
        whatsapp: expect.objectContaining({ enabledInPlan: false, active: false }),
        email: expect.objectContaining({ enabledInPlan: true, active: false }),
        telegram: expect.objectContaining({ enabledInPlan: false, active: false }),
      }),
    );
    expect(summary.processingBilling).toEqual(
      expect.objectContaining({
        processedCount: 18,
        unitPriceArs: 150,
        additionalCostArs: 2700,
      }),
    );
  });

  it('debe acumular páginas en usage.pagesCount y company.totalPagesUploaded de forma estrictamente creciente', async () => {
    // Arrange
    const usageMock = {
      pagesCount: 10,
      increment: jest.fn().mockResolvedValue(undefined),
    };
    monthlyUsageModelMock.findOrCreate.mockResolvedValueOnce([usageMock, false]);

    // Act
    await service.recordPagesUploaded(45, 12);

    // Assert
    expect(usageMock.increment).toHaveBeenCalledWith(
      { pagesCount: 12 },
      expect.any(Object),
    );
    expect(companyModelMock.increment).toHaveBeenCalledWith(
      { totalPagesUploaded: 12 },
      expect.objectContaining({ where: { id: 45 } }),
    );
  });
});
