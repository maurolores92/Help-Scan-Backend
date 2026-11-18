import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { UpdateUserDto } from '../dto/update-user.dto';
import { CreateUserDto } from '../dto/create-user.dto';
import { UsersLifecycleService } from './users-lifecycle.service';
import { UsersAuthProfileService } from './users-auth-profile.service';
import { Users, UserStatus } from '../users.model';

describe('UsersLifecycleService & UsersAuthProfileService — Edición y Validación DTO', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Validación de DTOs (Rechazo de propiedad inexistente clave)', () => {
    const validationPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    it('debe rechazar "clave" en UpdateUserDto cuando forbidNonWhitelisted está activo', async () => {
      await expect(
        validationPipe.transform(
          { name: 'Juan', lastName: 'Pérez', clave: '1234' },
          { type: 'body', metatype: UpdateUserDto },
        ),
      ).rejects.toThrow();
    });

    it('debe aceptar UpdateUserDto sin propiedad "clave"', async () => {
      const result = await validationPipe.transform(
        { name: 'Juan', lastName: 'Pérez', email: 'juan@acme.com', phone: '123456' },
        { type: 'body', metatype: UpdateUserDto },
      );

      expect(result.name).toBe('Juan');
      expect((result as any).clave).toBeUndefined();
    });

    it('debe aceptar CreateUserDto limpio sin "clave"', async () => {
      const result = await validationPipe.transform(
        {
          name: 'Ana',
          lastName: 'Gómez',
          username: 'anag',
          email: 'ana@acme.com',
          password: 'password123',
        },
        { type: 'body', metatype: CreateUserDto },
      );

      expect(result.username).toBe('anag');
      expect((result as any).clave).toBeUndefined();
    });
  });

  describe('UsersLifecycleService.updateUser — Alcance SuperAdmin vs Compañía', () => {
    const createService = (mockUser: any) => {
      const transactionMock = {
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      };
      const userModelMock: any = {
        findByPk: jest.fn().mockResolvedValue(mockUser),
        findOne: jest.fn().mockResolvedValue(null),
      };
      const sequelizeMock: any = {
        transaction: jest.fn().mockResolvedValue(transactionMock),
      };
      const auditMock: any = { log: jest.fn().mockResolvedValue(undefined) };
      const notifMock: any = { dispatch: jest.fn().mockResolvedValue(undefined) };
      const quotasMock: any = {
        assertCanCreateOrActivateUser: jest.fn().mockResolvedValue(undefined),
      };

      const service = new UsersLifecycleService(
        userModelMock,
        sequelizeMock,
        auditMock,
        notifMock,
        quotasMock,
      );

      return { service, userModelMock, transactionMock };
    };

    it('permite que el SuperAdmin edite un usuario perteneciente a una compañía (Detalle de Compañía)', async () => {
      const targetUser: any = {
        id: 2,
        username: 'admin_acme',
        email: 'admin@acme.com',
        name: 'Admin',
        lastName: 'Acme',
        companyId: 10,
        roleId: 2,
        status: UserStatus.ACTIVE,
        update: jest.fn().mockResolvedValue(true),
        toJSON: jest.fn().mockReturnValue({ id: 2, companyId: 10 }),
      };

      const { service, transactionMock } = createService(targetUser);
      const superAdminActor = { id: 1, username: 'superadmin', role: 'superadmin', isAdmin: true };

      const updated = await service.updateUser(
        2,
        { name: 'Admin Editado', email: 'admin@acme.com' },
        superAdminActor,
      );

      expect(targetUser.update).toHaveBeenCalledTimes(1);
      expect(transactionMock.commit).toHaveBeenCalledTimes(1);
      expect(updated).toBeDefined();
    });

    it('bloquea a un company_admin intentando editar un usuario de otra compañía', async () => {
      const targetUser: any = {
        id: 5,
        username: 'otro_usuario',
        email: 'otro@otra.com',
        companyId: 99,
      };
      const { service, transactionMock } = createService(targetUser);
      const companyAdminActor = {
        id: 2,
        role: 'company_admin',
        isAdmin: true,
        companyId: 10,
      };

      await expect(
        service.updateUser(5, { name: 'Intruso' }, companyAdminActor),
      ).rejects.toThrow(ForbiddenException);
      expect(transactionMock.rollback).toHaveBeenCalledTimes(1);
    });
  });

  describe('UsersAuthProfileService.changePassword', () => {
    it('permite que el SuperAdmin actualice la contraseña de un usuario de compañía', async () => {
      jest.spyOn(Users, 'hashPassword').mockResolvedValue('hashed_new_pw');
      const targetUser: any = {
        id: 2,
        username: 'admin_acme',
        companyId: 10,
        role: { slug: 'company_admin' },
        save: jest.fn().mockResolvedValue(true),
      };
      const userModelMock: any = { findByPk: jest.fn().mockResolvedValue(targetUser) };
      const auditMock: any = { log: jest.fn().mockResolvedValue(undefined) };
      const notifMock: any = { dispatch: jest.fn().mockResolvedValue(undefined) };

      const service = new UsersAuthProfileService(userModelMock, auditMock, notifMock);
      const superAdminActor = { id: 1, role: 'superadmin', isAdmin: true };

      const res = await service.changePassword(2, 'nuevaClave123', superAdminActor);
      expect(targetUser.password).toBe('hashed_new_pw');
      expect(targetUser.save).toHaveBeenCalledTimes(1);
      expect(res.message).toContain('Contraseña');
    });
  });
});

