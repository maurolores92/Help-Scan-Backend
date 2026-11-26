jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_3AM: '0 3 * * *' },
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GeoIpService } from './services/geo-ip.service';
import { SecurityService } from './services/security.service';
import { SecurityController } from './security.controller';
import { SecurityTrafficMiddleware } from './middleware/security-traffic.middleware';
import { SecurityLoginEventType } from './models/security-login-event.model';
import { SecurityErrorSource } from './models/security-error-log.model';
import {
  extractClientIp,
  sanitizeSecurityPayload,
} from './helpers/security-request.helper';

describe('Security Module (GeoIP, Bloqueo IP, Retención 60d, Errores y RBAC Superadmin)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GeoIpService', () => {
    it('resuelve IPs privadas/locales como LOCAL sin llamar a ipinfo.io', async () => {
      const ipModelMock: any = {
        findOne: jest.fn().mockResolvedValue(null),
        findOrCreate: jest.fn().mockResolvedValue([{ update: jest.fn() }, true]),
      };
      const fetchSpy = jest.spyOn(global, 'fetch');
      const service = new GeoIpService(ipModelMock);

      const res = await service.getOrLookupIp('::ffff:127.0.0.1');

      expect(res.ipAddress).toBe('127.0.0.1');
      expect(res.countryCode).toBe('LOCAL');
      expect(res.lookupProvider).toBe('local');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('usa caché en PostgreSQL si lookupExpiresAt sigue vigente', async () => {
      const ipModelMock: any = {
        findOne: jest.fn().mockResolvedValue({
          ipAddress: '8.8.8.8',
          countryCode: 'US',
          countryName: 'Estados Unidos',
          region: 'California',
          city: 'Mountain View',
          isp: 'Google LLC',
          organization: 'Google LLC',
          asn: 'AS15169',
          lookupProvider: 'ipinfo',
          lookupExpiresAt: new Date(Date.now() + 3600 * 1000),
        }),
      };
      const fetchSpy = jest.spyOn(global, 'fetch');
      const service = new GeoIpService(ipModelMock);

      const res = await service.getOrLookupIp('8.8.8.8');

      expect(res.isp).toBe('Google LLC');
      expect(res.asn).toBe('AS15169');
      expect(res.lookupProvider).toBe('ipinfo');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('consulta ipinfo.io cuando no hay caché y hace fallback offline a geoip-lite si falla red', async () => {
      const ipModelMock: any = {
        findOne: jest.fn().mockResolvedValue(null),
        findOrCreate: jest.fn().mockResolvedValue([{ update: jest.fn() }, true]),
      };
      const service = new GeoIpService(ipModelMock);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ip: '1.1.1.1',
          country: 'AU',
          region: 'Queensland',
          city: 'Brisbane',
          org: 'AS13335 Cloudflare, Inc.',
        }),
      } as any);

      const onlineRes = await service.getOrLookupIp('1.1.1.1');
      expect(onlineRes.lookupProvider).toBe('ipinfo');
      expect(onlineRes.asn).toBe('AS13335');
      expect(onlineRes.isp).toBe('Cloudflare, Inc.');

      jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ETIMEDOUT'));

      const offlineRes = await service.getOrLookupIp('8.8.8.8', { forceRefresh: true });
      expect(offlineRes.lookupProvider).toBe('geoip-lite');
      expect(offlineRes.countryCode).toBe('US');
      expect(offlineRes.countryName).toBe('Estados Unidos');
    });
  });

  describe('SecurityService & SecurityTrafficMiddleware', () => {
    const createService = () => {
      const ipRecord = {
        id: 10,
        ipAddress: '190.50.10.5',
        countryCode: 'AR',
        countryName: 'Argentina',
        isp: 'Telecom Argentina S.A.',
        isBlocked: false,
        blockReason: null as string | null,
        totalRequests: 1,
        failedLoginsCount: 0,
        errorCount: 0,
        update: jest.fn(async function (this: any, patch: any) {
          Object.assign(this, patch);
          return this;
        }),
      };

      const ipModelMock: any = {
        findAll: jest.fn().mockResolvedValue([]),
        findOrCreate: jest.fn().mockResolvedValue([ipRecord, true]),
        findOne: jest.fn().mockResolvedValue(ipRecord),
        destroy: jest.fn().mockResolvedValue(2),
      };
      const loginEventModelMock: any = {
        create: jest.fn().mockResolvedValue({ id: 99, createdAt: new Date() }),
        count: jest.fn().mockResolvedValue(5),
        destroy: jest.fn().mockResolvedValue(14),
      };
      const errorLogModelMock: any = {
        create: jest.fn().mockResolvedValue({ id: 55, createdAt: new Date() }),
        destroy: jest.fn().mockResolvedValue(8),
      };
      const geoIpServiceMock: any = {
        getOrLookupIp: jest.fn().mockResolvedValue({
          ipAddress: '190.50.10.5',
          countryCode: 'AR',
          countryName: 'Argentina',
          isp: 'Telecom Argentina S.A.',
          organization: 'Telecom Argentina S.A.',
          asn: 'AS7303',
        }),
      };
      const auditServiceMock: any = {
        log: jest.fn().mockResolvedValue(undefined),
      };
      const notificationsServiceMock: any = {
        dispatch: jest.fn().mockResolvedValue(undefined),
      };
      const gatewayMock: any = {
        emitToSuperAdmins: jest.fn(),
      };

      const service = new SecurityService(
        ipModelMock,
        loginEventModelMock,
        errorLogModelMock,
        geoIpServiceMock,
        auditServiceMock,
        notificationsServiceMock,
        gatewayMock,
      );

      return {
        service,
        ipRecord,
        ipModelMock,
        loginEventModelMock,
        errorLogModelMock,
        auditServiceMock,
        notificationsServiceMock,
        gatewayMock,
      };
    };

    it('bloquea y desbloquea IP pública con auditoría, notificación y bloqueo inmediato en middleware HTTP 403', async () => {
      const { service, auditServiceMock, notificationsServiceMock, gatewayMock } = createService();

      await service.toggleIpBlock(
        '190.50.10.5',
        { blocked: true, reason: 'Escaneo sospechoso' },
        1,
        '200.1.2.3',
      );

      expect(service.isIpBlocked('190.50.10.5')).toBe(true);
      expect(auditServiceMock.log).toHaveBeenCalledTimes(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'security.ip_blocked' }),
      );
      expect(gatewayMock.emitToSuperAdmins).toHaveBeenCalledWith(
        'security:event',
        expect.objectContaining({ kind: 'IP_BLOCK', isBlocked: true }),
      );

      const middleware = new SecurityTrafficMiddleware(service);
      const statusFn = jest.fn().mockReturnThis();
      const jsonFn = jest.fn();
      const nextFn = jest.fn();

      expect(() =>
        middleware.use(
          { headers: { 'x-forwarded-for': '190.50.10.5' }, originalUrl: '/api/documents', method: 'GET' } as any,
          { status: statusFn, json: jsonFn } as any,
          nextFn,
        ),
      ).toThrow(ForbiddenException);
      expect(nextFn).not.toHaveBeenCalled();

      await service.toggleIpBlock('190.50.10.5', { blocked: false }, 1, '200.1.2.3');
      expect(service.isIpBlocked('190.50.10.5')).toBe(false);
    });

    it('impide bloquear IPs locales/privadas o la propia IP del Super Admin', async () => {
      const { service } = createService();

      await expect(
        service.toggleIpBlock('127.0.0.1', { blocked: true }, 1, '200.1.2.3'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.toggleIpBlock('190.50.10.5', { blocked: true }, 1, '190.50.10.5'),
      ).rejects.toThrow(BadRequestException);
    });

    it('detecta fuerza bruta al superar 5 logins fallidos y dispara alerta security.threat_detected', async () => {
      const { service, notificationsServiceMock, gatewayMock } = createService();

      await service.recordLoginEvent({
        eventType: SecurityLoginEventType.LOGIN_FAILED,
        usernameAttempted: 'admin@demo.com',
        ipAddress: '190.50.10.5',
        userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Windows NT 10.0',
        failureReason: 'Contraseña incorrecta',
      });

      expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'security.threat_detected' }),
      );
      expect(gatewayMock.emitToSuperAdmins).toHaveBeenCalledWith(
        'security:event',
        expect.objectContaining({ kind: 'THREAT', ipAddress: '190.50.10.5' }),
      );
    });

    it('enmascara contraseñas y tokens al registrar errores 4xx/5xx y ejecuta retención de 60 días', async () => {
      const { service, errorLogModelMock, loginEventModelMock, ipModelMock } = createService();

      await service.recordErrorLog({
        source: SecurityErrorSource.BACKEND,
        statusCode: 500,
        method: 'POST',
        path: '/api/auth/login',
        message: 'Database timeout',
        sanitizedPayload: { username: 'jdoe', password: 'SuperSecretPassword!', token: 'abc' },
        ipAddress: '190.50.10.5',
      });

      expect(errorLogModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          sanitizedPayload: expect.objectContaining({
            username: 'jdoe',
            password: '[OCULTO]',
            token: '[OCULTO]',
          }),
        }),
      );

      const sanitized = sanitizeSecurityPayload({ refreshToken: 'xyz', nested: { secret: '123' } });
      expect(sanitized).toEqual({ refreshToken: '[OCULTO]', nested: { secret: '[OCULTO]' } });

      const purged = await service.purgeExpiredLogs();
      expect(purged).toEqual({ deletedLogins: 14, deletedErrors: 8, deletedIps: 2 });
      expect(loginEventModelMock.destroy).toHaveBeenCalled();
      expect(errorLogModelMock.destroy).toHaveBeenCalled();
      expect(ipModelMock.destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isBlocked: false }),
        }),
      );
    });

    it('extrae la IP pública ignorando routers/proxies internos y no guarda IPs privadas en security_ip_intelligence', async () => {
      expect(
        extractClientIp({
          headers: {
            'x-real-ip': '172.18.0.1',
            'x-forwarded-for': '192.168.1.1, 10.0.0.5, 190.50.10.5, 172.16.0.2',
          },
          ip: '127.0.0.1',
          socket: { remoteAddress: '::ffff:192.168.0.10' },
        }),
      ).toBe('190.50.10.5');

      const { service, ipModelMock, loginEventModelMock, errorLogModelMock } = createService();
      const middleware = new SecurityTrafficMiddleware(service);
      const nextFn = jest.fn();

      middleware.use(
        {
          headers: { 'x-real-ip': '192.168.1.50' },
          ip: '127.0.0.1',
          originalUrl: '/api/health',
          method: 'GET',
        } as any,
        {} as any,
        nextFn,
      );

      expect(nextFn).toHaveBeenCalledTimes(1);
      await service.flushTrafficBuffer();
      expect(ipModelMock.findOrCreate).not.toHaveBeenCalled();

      await service.recordLoginEvent({
        eventType: SecurityLoginEventType.LOGIN_SUCCESS,
        usernameAttempted: 'superadmin',
        ipAddress: '192.168.1.50',
      });
      await service.recordErrorLog({
        source: SecurityErrorSource.BACKEND,
        statusCode: 404,
        path: '/api/missing',
        message: 'Not found',
        ipAddress: '10.0.0.8',
      });

      expect(loginEventModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '192.168.1.50',
          countryCode: 'LOCAL',
        }),
      );
      expect(errorLogModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '10.0.0.8',
          countryCode: 'LOCAL',
        }),
      );
      expect(ipModelMock.findOrCreate).not.toHaveBeenCalled();

      ipModelMock.findAll.mockResolvedValueOnce([
        { id: 1, ipAddress: '127.0.0.1' },
        { id: 2, ipAddress: '192.168.1.1' },
        { id: 3, ipAddress: '190.50.10.5' },
      ]);
      ipModelMock.destroy.mockResolvedValueOnce(2);
      const removed = await service.purgePrivateIpRecords();
      expect(removed).toBe(2);
    });
  });

  describe('SecurityController RBAC', () => {
    it('rechaza acceso a usuarios no superadmin y permite reporte público en POST /security/client-errors', async () => {
      const securityServiceMock: any = {
        getOverview: jest.fn().mockResolvedValue({ periodDays: 7 }),
        recordErrorLog: jest.fn().mockResolvedValue(undefined),
      };
      const jwtServiceMock: any = {
        verify: jest.fn().mockReturnValue({ id: 5, username: 'operador', companyId: 2 }),
      };

      const controller = new SecurityController(
        securityServiceMock,
        jwtServiceMock,
        {} as any,
      );

      expect(() =>
        controller.getOverview('7', { id: 5, role: { slug: 'company_admin' } }),
      ).toThrow(ForbiddenException);

      await expect(controller.getOverview('7', { id: 1, role: 'superadmin' })).resolves.toEqual({
        periodDays: 7,
      });

      const res = await controller.reportClientError(
        {
          statusCode: 500,
          method: 'REACT_UI',
          path: '/documents',
          message: 'Cannot read properties of undefined',
        },
        {
          headers: { authorization: 'Bearer valid-jwt', 'user-agent': 'Chrome' },
          ip: '190.50.10.5',
        } as any,
      );

      expect(res).toEqual({ accepted: true });
      expect(securityServiceMock.recordErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: SecurityErrorSource.FRONTEND,
          userId: 5,
          username: 'operador',
          companyId: 2,
          ipAddress: '190.50.10.5',
        }),
      );
    });
  });
});
