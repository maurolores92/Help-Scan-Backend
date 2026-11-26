import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { BadRequestException } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { CompaniesService } from './companies.service';
import { Company, CompanyStatus } from './company.model';
import { Users, UserStatus } from '../users/users.model';
import { Role } from '../role/role.model';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansService } from '../plans/plans.service';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';

describe('CompaniesService', () => {
  let service: CompaniesService;
  let companyModelMock: any;
  let auditServiceMock: any;
  let notificationsServiceMock: any;
  let plansServiceMock: any;
  let tenantQuotasServiceMock: any;
  let sequelizeMock: any;

  beforeEach(async () => {
    companyModelMock = {
      findOne: jest.fn(),
      findByPk: jest.fn(),
      create: jest.fn(),
      findAndCountAll: jest.fn(),
    };

    auditServiceMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    notificationsServiceMock = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    plansServiceMock = {
      findById: jest.fn(),
      findDefaultPlan: jest.fn().mockResolvedValue({
        id: 2,
        name: 'Profesional',
        slug: 'pro',
        maxUsers: 15,
        includedModules: ['documents', 'users'],
      }),
    };

    tenantQuotasServiceMock = {
      getBatchQuotaSummaries: jest.fn().mockResolvedValue(new Map()),
    };

    sequelizeMock = {
      transaction: jest.fn().mockReturnValue({
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getModelToken(Company), useValue: companyModelMock },
        { provide: Sequelize, useValue: sequelizeMock },
        { provide: AuditService, useValue: auditServiceMock },
        { provide: NotificationsService, useValue: notificationsServiceMock },
        { provide: PlansService, useValue: plansServiceMock },
        { provide: TenantQuotasService, useValue: tenantQuotasServiceMock },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('debe estar definido el servicio', () => {
    expect(service).toBeDefined();
  });

  it('debe lanzar BadRequestException si el slug ya existe', async () => {
    // Arrange
    companyModelMock.findOne.mockResolvedValueOnce({ id: 1, slug: 'empresa-test' });

    // Act & Assert
    await expect(
      service.create({
        name: 'Empresa Test',
        slug: 'empresa-test',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('debe retornar lista de compañías con resumen de cuota y meta paginado', async () => {
    // Arrange
    companyModelMock.findAndCountAll.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: 'Compañía Uno',
          slug: 'comp-uno',
          toJSON: () => ({ id: 1, name: 'Compañía Uno', slug: 'comp-uno' }),
        },
      ],
      count: 1,
    });

    const summaryMap = new Map();
    summaryMap.set(1, {
      companyId: 1,
      users: { current: 3, max: 15, unlimited: false, percentage: 20 },
      documents: { current: 10, max: 500, unlimited: false, percentage: 2 },
      storageMb: { current: 12.5, max: 2048, unlimited: false, percentage: 1, currentBytes: 13107200 },
      aiQueries: { current: 0, max: 250, unlimited: false, percentage: 0, period: '2026-10', tokensUsed: 0 },
    });
    tenantQuotasServiceMock.getBatchQuotaSummaries.mockResolvedValueOnce(summaryMap);

    // Act
    const result = await service.findAll({ page: 1, limit: 10 });

    // Assert
    expect(result.data).toHaveLength(1);
    expect(result.data[0].activeUsersCount).toBe(3);
    expect(result.data[0].quotaSummary.documents.current).toBe(10);
    expect(result.meta.totalItems).toBe(1);
  });

  it('debe activar la compañía, reactivar sus usuarios y garantizar la activación de su usuario administrador', async () => {
    const mockCompany = {
      id: 5,
      name: 'Empresa Inactiva',
      slug: 'empresa-inactiva',
      status: CompanyStatus.INACTIVE,
      isTrial: true,
      trialEndsAt: new Date(Date.now() - 10000),
      update: jest.fn().mockResolvedValue(undefined),
      toJSON: () => ({ id: 5, name: 'Empresa Inactiva', status: CompanyStatus.ACTIVE }),
    };

    companyModelMock.findByPk.mockResolvedValue(mockCompany);

    jest.spyOn(Users, 'update').mockResolvedValue([1] as any);
    jest.spyOn(Role, 'findOne').mockResolvedValue({ id: 3, slug: 'company_admin' } as any);

    const result = await service.changeStatus(5, CompanyStatus.ACTIVE, 1);

    expect(mockCompany.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CompanyStatus.ACTIVE,
        isTrial: false,
        trialEndsAt: null,
      }),
      expect.anything(),
    );
    expect(Users.update).toHaveBeenCalledWith(
      { status: UserStatus.ACTIVE },
      expect.objectContaining({ where: { companyId: 5 } }),
    );
    expect(auditServiceMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Se activó la compañía'),
      }),
    );
    expect(result).toBeDefined();
  });

  it('debe suspender la compañía y desactivar sus usuarios asociados', async () => {
    const mockCompany = {
      id: 8,
      name: 'Empresa Activa',
      slug: 'empresa-activa',
      status: CompanyStatus.ACTIVE,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON: () => ({ id: 8, name: 'Empresa Activa', status: CompanyStatus.SUSPENDED }),
    };

    companyModelMock.findByPk.mockResolvedValue(mockCompany);
    jest.spyOn(Users, 'update').mockResolvedValue([1] as any);

    await service.changeStatus(8, CompanyStatus.SUSPENDED, 1);

    expect(mockCompany.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CompanyStatus.SUSPENDED,
      }),
      expect.anything(),
    );
    expect(Users.update).toHaveBeenCalledWith(
      { status: UserStatus.INACTIVE },
      expect.objectContaining({ where: { companyId: 8 } }),
    );
  });

  it('debe eliminar en cascada segura ftp_devices, canales, documentos, clientes, usuarios y roles antes de destruir la compañía', async () => {
    const callOrder: string[] = [];
    const makeModelMock = (name: string, rows: any[] = []) => ({
      findAll: jest.fn().mockResolvedValue(rows),
      destroy: jest.fn().mockImplementation(async () => {
        callOrder.push(`destroy:${name}`);
        return rows.length || 1;
      }),
      update: jest.fn().mockImplementation(async () => {
        callOrder.push(`update:${name}`);
        return [1];
      }),
    });

    sequelizeMock.models = {
      Users: makeModelMock('Users', [{ id: 10 }, { id: 11 }]),
      Role: makeModelMock('Role', [{ id: 20 }]),
      Document: makeModelMock('Document', [{ id: 30 }]),
      FtpDevice: makeModelMock('FtpDevice', [{ id: 40, username: 'hp_scanner_2' }]),
      EmailMessage: makeModelMock('EmailMessage'),
      WhatsappMessage: makeModelMock('WhatsappMessage'),
      TelegramMessage: makeModelMock('TelegramMessage'),
      CompanyEmailChannel: makeModelMock('CompanyEmailChannel'),
      CompanyWhatsappChannel: makeModelMock('CompanyWhatsappChannel'),
      CompanyTelegramChannel: makeModelMock('CompanyTelegramChannel'),
      DocumentLink: makeModelMock('DocumentLink'),
      DocumentFormRecord: makeModelMock('DocumentFormRecord'),
      DocumentTypeForm: makeModelMock('DocumentTypeForm'),
      Client: makeModelMock('Client'),
      CompanyMonthlyUsage: makeModelMock('CompanyMonthlyUsage'),
      Notification: makeModelMock('Notification'),
      NotificationPreference: makeModelMock('NotificationPreference'),
      PushSubscription: makeModelMock('PushSubscription'),
      UserPermission: makeModelMock('UserPermission'),
      Audit: makeModelMock('Audit'),
      SecurityLoginEvent: makeModelMock('SecurityLoginEvent'),
      SecurityErrorLog: makeModelMock('SecurityErrorLog'),
      SecurityIpIntelligence: makeModelMock('SecurityIpIntelligence'),
      RolePermission: makeModelMock('RolePermission'),
    };

    const ftpDevicesServiceMock: any = {
      deleteExternalVirtualUsers: jest.fn().mockResolvedValue(undefined),
    };
    const mockCompany = {
      id: 2,
      name: 'MauroDEV',
      slug: 'maurodev',
      status: CompanyStatus.SUSPENDED,
      destroy: jest.fn().mockImplementation(async () => {
        callOrder.push('destroy:Company');
      }),
      toJSON: () => ({ id: 2, name: 'MauroDEV', status: CompanyStatus.SUSPENDED }),
    };

    companyModelMock.findByPk.mockResolvedValueOnce(mockCompany);
    const serviceWithFtp = new CompaniesService(
      companyModelMock,
      sequelizeMock,
      auditServiceMock,
      notificationsServiceMock,
      plansServiceMock,
      tenantQuotasServiceMock,
      ftpDevicesServiceMock,
    );

    const res = await serviceWithFtp.remove(2, 1);

    expect(res).toEqual({
      success: true,
      message: "Compañía 'MauroDEV' eliminada correctamente",
    });
    expect(callOrder.indexOf('destroy:FtpDevice')).toBeLessThan(
      callOrder.indexOf('destroy:Company'),
    );
    expect(callOrder.indexOf('destroy:Users')).toBeLessThan(
      callOrder.indexOf('destroy:Company'),
    );
    expect(callOrder.indexOf('destroy:Document')).toBeLessThan(
      callOrder.indexOf('destroy:Users'),
    );
    expect(callOrder.indexOf('update:Audit')).toBeLessThan(
      callOrder.indexOf('destroy:Users'),
    );
    expect(ftpDevicesServiceMock.deleteExternalVirtualUsers).toHaveBeenCalledWith([
      'hp_scanner_2',
    ]);
    expect(auditServiceMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'Company',
        entityId: 2,
        companyId: null,
      }),
    );
  });
});
