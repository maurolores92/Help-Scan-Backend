jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_3AM: '0 3 * * *' },
}));

import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { Users } from '../users/users.model';

describe('AuthService & JwtStrategy (Sesión Única por Usuario)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bloquea con 409 ACTIVE_SESSION_EXISTS si ya hay sesión vigente y permite tomarla con forceTakeover=true (incluido superadmin)', async () => {
    const userInstance = {
      id: 1,
      activeSessionId: 'existing-active-session',
      activeSessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      update: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Users, 'findByPk').mockResolvedValue(userInstance as any);
    const hashedPassword = await bcrypt.hash('secret', 4);

    const usersServiceMock: any = {
      findOneByUsername: jest.fn().mockResolvedValue({
        id: 1,
        name: 'Super',
        lastName: 'Admin',
        email: 'superadmin@helpcopies.com',
        username: 'superadmin',
        password: hashedPassword,
        status: 'ACTIVE',
        companyId: null,
        role: 'superadmin',
        roleId: 1,
        isAdmin: true,
        permissions: ['manage:all'],
      }),
    };

    const jwtServiceMock: any = {
      sign: jest.fn().mockReturnValue('signed-jwt-token'),
    };
    const gatewayMock: any = {
      emitSessionReplaced: jest.fn(),
    };

    const service = new AuthService(usersServiceMock, jwtServiceMock, gatewayMock);

    // 1. Primer intento sin forceTakeover -> debe bloquear y NO expulsar aún
    await expect(
      service.signIn({ username: 'superadmin', password: 'secret' }),
    ).rejects.toThrow(ConflictException);
    expect(userInstance.update).not.toHaveBeenCalled();
    expect(gatewayMock.emitSessionReplaced).not.toHaveBeenCalled();

    // 2. Confirmado con forceTakeover=true -> reemplaza activeSessionId y expulsa sesión previa
    const res = await service.signIn({
      username: 'superadmin',
      password: 'secret',
      forceTakeover: true,
    });

    expect(res.accessToken).toBe('signed-jwt-token');
    expect(userInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: expect.any(String),
        activeSessionExpiresAt: expect.any(Date),
      }),
    );
    const generatedSessionId = userInstance.update.mock.calls[0][0].activeSessionId;
    expect(jwtServiceMock.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        username: 'superadmin',
        sessionId: generatedSessionId,
      }),
      expect.any(Object),
    );
    expect(gatewayMock.emitSessionReplaced).toHaveBeenCalledWith(1, generatedSessionId);
  });

  it('logout revoca activeSessionId para invalidar JWT actual y liberar el siguiente login', async () => {
    const updateSpy = jest.spyOn(Users, 'update').mockResolvedValue([1] as any);
    const service = new AuthService({} as any, {} as any);

    const res = await service.logout(5);

    expect(res).toEqual({ success: true });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: expect.stringMatching(/^revoked:/),
        activeSessionExpiresAt: null,
      }),
      { where: { id: 5 } },
    );
  });

  it('JwtStrategy rechaza con SESSION_REPLACED tokens de una sesión previa cerrada', async () => {
    const usersServiceMock: any = {
      findOneByEmail: jest.fn().mockResolvedValue({
        id: 7,
        email: 'operador@empresa.com',
        status: 'ACTIVE',
        activeSessionId: 'session-actual-2',
      }),
    };

    const strategy = new JwtStrategy(usersServiceMock);

    await expect(
      strategy.validate({
        id: 7,
        email: 'operador@empresa.com',
        name: 'Operador',
        sessionId: 'session-vieja-1',
      }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      strategy.validate({
        id: 7,
        email: 'operador@empresa.com',
        name: 'Operador',
        sessionId: 'session-actual-2',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 7,
        activeSessionId: 'session-actual-2',
      }),
    );
  });
});
