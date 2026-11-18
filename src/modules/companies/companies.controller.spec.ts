import { Test, TestingModule } from '@nestjs/testing';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { UsersService } from '../users/users.service';
import { CompanyStatus } from './company.model';

describe('CompaniesController Route Mapping', () => {
  let controller: CompaniesController;
  let companiesServiceMock: any;
  let usersServiceMock: any;

  beforeEach(async () => {
    companiesServiceMock = {
      create: jest.fn(),
      findAll: jest.fn(),
      findBySlug: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      changeStatus: jest.fn(),
      remove: jest.fn(),
    };

    usersServiceMock = {
      findAll: jest.fn(),
      create: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CompaniesController],
      providers: [
        { provide: CompaniesService, useValue: companiesServiceMock },
        { provide: UsersService, useValue: usersServiceMock },
      ],
    }).compile();

    controller = module.get<CompaniesController>(CompaniesController);
  });

  it('debe registrar la ruta PATCH :id/status con el método HTTP PATCH', () => {
    const methodMetadata = Reflect.getMetadata(
      METHOD_METADATA,
      controller.changeStatus,
    );
    const pathMetadata = Reflect.getMetadata(
      PATH_METADATA,
      controller.changeStatus,
    );

    expect(methodMetadata).toBe(RequestMethod.PATCH);
    expect(pathMetadata).toBe(':id/status');
  });

  it('debe registrar la ruta PUT :id/status con el método HTTP PUT', () => {
    const methodMetadata = Reflect.getMetadata(
      METHOD_METADATA,
      controller.changeStatusPut,
    );
    const pathMetadata = Reflect.getMetadata(
      PATH_METADATA,
      controller.changeStatusPut,
    );

    expect(methodMetadata).toBe(RequestMethod.PUT);
    expect(pathMetadata).toBe(':id/status');
  });

  it('debe registrar la ruta PATCH :id con el método HTTP PATCH', () => {
    const methodMetadata = Reflect.getMetadata(
      METHOD_METADATA,
      controller.update,
    );
    const pathMetadata = Reflect.getMetadata(
      PATH_METADATA,
      controller.update,
    );

    expect(methodMetadata).toBe(RequestMethod.PATCH);
    expect(pathMetadata).toBe(':id');
  });

  it('changeStatus debe invocar companiesService.changeStatus con los parámetros correctos', async () => {
    const superAdminUser = { id: 1, username: 'superadmin', role: 'superadmin' };
    companiesServiceMock.changeStatus.mockResolvedValueOnce({ id: 2, status: CompanyStatus.ACTIVE });

    const result = await controller.changeStatus(2, CompanyStatus.ACTIVE, superAdminUser);

    expect(companiesServiceMock.changeStatus).toHaveBeenCalledWith(2, CompanyStatus.ACTIVE, 1);
    expect(result).toEqual({ id: 2, status: CompanyStatus.ACTIVE });
  });
});
