import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { PlansService } from './plans.service';
import { Plan } from './plan.model';
import { Company } from '../companies/company.model';
import { AuditService } from '../audit/audit.service';
import { ExchangeRateService } from './services/exchange-rate.service';

describe('PlansService', () => {
  let service: PlansService;
  let planModelMock: any;
  let companyModelMock: any;
  let auditServiceMock: any;
  let sequelizeMock: any;
  let exchangeRateServiceMock: any;

  beforeEach(async () => {
    planModelMock = {
      findOne: jest.fn(),
      findByPk: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    companyModelMock = {
      findAll: jest.fn(),
      count: jest.fn(),
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

    exchangeRateServiceMock = {
      getUsdRate: jest.fn().mockResolvedValue(1250),
      getConfig: jest.fn().mockResolvedValue({ id: 1, usdRate: 1250, roundPrices: true }),
      formatPlanForPublicWeb: jest.fn().mockImplementation((plan: any) => ({
        id: plan.id,
        name: plan.name,
        priceMonthly: Number(plan.priceMonthly || 0),
        currency: 'ARS',
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: getModelToken(Plan), useValue: planModelMock },
        { provide: getModelToken(Company), useValue: companyModelMock },
        { provide: Sequelize, useValue: sequelizeMock },
        { provide: AuditService, useValue: auditServiceMock },
        { provide: ExchangeRateService, useValue: exchangeRateServiceMock },
      ],
    }).compile();

    service = module.get<PlansService>(PlansService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('debe crear un plan por defecto desmarcando otros planes predeterminados', async () => {
    // Arrange
    planModelMock.findOne.mockResolvedValueOnce(null);
    const createdPlan = {
      id: 2,
      name: 'Profesional',
      slug: 'pro',
      isDefault: true,
      toJSON: () => ({ id: 2, name: 'Profesional', slug: 'pro', isDefault: true }),
    };
    planModelMock.create.mockResolvedValueOnce(createdPlan);

    // Act
    const result = await service.create(
      {
        name: 'Profesional',
        slug: 'pro',
        pricePerProcessedDocumentArs: 150,
        maxUsers: 15,
        maxDocuments: 1000,
        isDefault: true,
      },
      1,
    );

    // Assert
    expect(result).toEqual(createdPlan);
    expect(planModelMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        maxDocuments: 1000,
        maxPages: 1000,
        maxStorageMb: 1024,
        pricePerProcessedDocumentArs: 150,
        maxAiQueriesMonthly: null,
      }),
      expect.any(Object),
    );
    expect(planModelMock.update).toHaveBeenCalledWith(
      { isDefault: false },
      expect.objectContaining({ where: { isDefault: true } }),
    );
    expect(auditServiceMock.log).toHaveBeenCalledTimes(1);
  });

  it('debe lanzar BadRequestException si el slug del plan ya existe', async () => {
    // Arrange
    planModelMock.findOne.mockResolvedValueOnce({ id: 1, slug: 'starter' });

    // Act & Assert
    await expect(
      service.create({ name: 'Starter', slug: 'starter' }, 1),
    ).rejects.toThrow(BadRequestException);
  });

  it('debe impedir eliminar un plan que tiene compañías asociadas', async () => {
    // Arrange
    planModelMock.findByPk.mockResolvedValueOnce({
      id: 1,
      name: 'Starter',
      destroy: jest.fn(),
    });
    companyModelMock.count.mockResolvedValueOnce(3);

    // Act & Assert
    await expect(service.remove(1, 1)).rejects.toThrow(BadRequestException);
  });

  it('debe lanzar NotFoundException al buscar un plan inexistente', async () => {
    // Arrange
    planModelMock.findByPk.mockResolvedValueOnce(null);

    // Act & Assert
    await expect(service.findById(999)).rejects.toThrow(NotFoundException);
  });
});
