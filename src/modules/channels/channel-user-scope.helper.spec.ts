import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  isCompanyAdminUser,
  resolveChannelOwnerContext,
  resolveInboxFilterUserId,
} from './helpers/channel-user-scope.helper';
import { buildDocumentSearchWhere } from '../documents/helpers/document-search.helper';

describe('ChannelUserScopeHelper & Document userId filter', () => {
  it('identifica correctamente administradores de compañía frente a usuarios estándar', () => {
    expect(isCompanyAdminUser({ role: 'company_admin' })).toBe(true);
    expect(isCompanyAdminUser({ role: { slug: 'admin' } })).toBe(true);
    expect(isCompanyAdminUser({ isAdmin: true, role: 'user' })).toBe(true);
    expect(isCompanyAdminUser({ isAdmin: false, role: 'user' })).toBe(false);
    expect(isCompanyAdminUser(null)).toBe(false);
  });

  it('impide que un usuario estándar consulte o configure canales de otro usuario', async () => {
    const regularUser = { id: 12, companyId: 5, role: 'user', isAdmin: false };

    const ownCtx = await resolveChannelOwnerContext(regularUser);
    expect(ownCtx).toEqual({
      companyId: 5,
      userId: 12,
      actorUserId: 12,
      isCompanyAdmin: false,
    });

    await expect(resolveChannelOwnerContext(regularUser, 99)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('permite al company_admin gestionar canales de otro usuario de la misma compañía y bloquea ajenos', async () => {
    const adminUser = { id: 1, companyId: 5, role: 'company_admin', isAdmin: true };
    const usersModelMock: any = {
      findOne: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === 15 && where.companyId === 5) return { id: 15 };
        return null;
      }),
    };

    const targetCtx = await resolveChannelOwnerContext(adminUser, 15, usersModelMock);
    expect(targetCtx).toEqual({
      companyId: 5,
      userId: 15,
      actorUserId: 1,
      isCompanyAdmin: true,
    });

    await expect(
      resolveChannelOwnerContext(adminUser, 777, usersModelMock),
    ).rejects.toThrow(NotFoundException);

    await expect(
      resolveChannelOwnerContext({ id: 2, role: 'superadmin', companyId: null }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('restringe bandejas a user.id para no administradores y permite filtro libre a administradores', () => {
    const regularUser = { id: 22, companyId: 5, role: 'user', isAdmin: false };
    const adminUser = { id: 1, companyId: 5, role: 'company_admin', isAdmin: true };

    // Usuario común siempre ve solo lo suyo incluso si intenta pasar ?userId=1
    expect(resolveInboxFilterUserId(regularUser, undefined)).toBe(22);
    expect(resolveInboxFilterUserId(regularUser, '1')).toBe(22);

    // Admin ve toda la compañía si no filtra, o filtra un userId puntual
    expect(resolveInboxFilterUserId(adminUser, undefined)).toBeUndefined();
    expect(resolveInboxFilterUserId(adminUser, '')).toBeUndefined();
    expect(resolveInboxFilterUserId(adminUser, '15')).toBe(15);
  });

  it('aplica filtro userId en buildDocumentSearchWhere cuando se especifica usuario', () => {
    const where: any = buildDocumentSearchWhere(5, { userId: 15 } as any);
    expect(where[Op.and]).toEqual(
      expect.arrayContaining([{ companyId: 5 }, { userId: 15 }]),
    );
  });
});
