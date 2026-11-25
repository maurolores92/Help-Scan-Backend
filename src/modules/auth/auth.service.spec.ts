import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { Users } from '../users/users.model';

describe('AuthService & JwtStrategy (Sesión Única por Usuario)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('genera sessionId único al hacer login (incluido superadmin) y revoca sesiones previas por WebSocket', async () => {
    const userInstance = {
      id: 1,
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
    const res = await service.signIn({
      username: 'superadmin',
      password: 'secret',
    });

    expect(res.accessToken).toBe('signed-jwt-token');
    expect(userInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: expect.any(String),
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
