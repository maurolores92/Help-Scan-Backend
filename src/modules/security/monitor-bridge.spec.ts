jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_3AM: '0 3 * * *' },
}));

import { EventEmitter } from 'events';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MonitorBridgeGuard } from './guards/monitor-bridge.guard';
import { SecurityMonitorBridgeService } from './services/security-monitor-bridge.service';
import { SecurityController } from './security.controller';
import { SecurityTrafficMiddleware } from './middleware/security-traffic.middleware';
import {
  extractClientIp,
  isPrivateOrLocalIp,
  normalizeIpAddress,
  sanitizeSecurityDetails,
} from './helpers/security-request.helper';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

describe('HelpCopies Monitor Bridge (/api/security/* + x-monitor-key)', () => {
  const originalMonitorKey = process.env.MONITOR_BRIDGE_KEY;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalMonitorKey === undefined) {
      delete process.env.MONITOR_BRIDGE_KEY;
    } else {
      process.env.MONITOR_BRIDGE_KEY = originalMonitorKey;
    }
  });

  const makeExecutionContext = (headers: Record<string, any> = {}): any => ({
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  });

  describe('MonitorBridgeGuard', () => {
    it('rechaza con 401 si falta MONITOR_BRIDGE_KEY en el servidor o falta header x-monitor-key', () => {
      const guard = new MonitorBridgeGuard();

      delete process.env.MONITOR_BRIDGE_KEY;
      expect(() =>
        guard.canActivate(makeExecutionContext({ 'x-monitor-key': 'secret-123' })),
      ).toThrow(UnauthorizedException);

      process.env.MONITOR_BRIDGE_KEY = 'super-monitor-secret';
      expect(() => guard.canActivate(makeExecutionContext({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('rechaza con 403 si x-monitor-key no coincide y permite paso con coincidencia exacta', () => {
      const guard = new MonitorBridgeGuard();
      process.env.MONITOR_BRIDGE_KEY = 'super-monitor-secret';

      expect(() =>
        guard.canActivate(makeExecutionContext({ 'x-monitor-key': 'super-monitor-xxxxxx' })),
      ).toThrow(ForbiddenException);

      expect(
        guard.canActivate(makeExecutionContext({ 'x-monitor-key': 'super-monitor-secret' })),
      ).toBe(true);
    });
  });

  describe('Normalización de IP, privacidad y sanitización de details', () => {
    it('normaliza ::ffff:x.x.x.x y detecta rangos RFC1918/loopback/ULA', () => {
      expect(normalizeIpAddress('::ffff:190.50.10.5')).toBe('190.50.10.5');
      expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrLocalIp('10.20.0.5')).toBe(true);
      expect(isPrivateOrLocalIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrLocalIp('172.31.255.254')).toBe(true);
      expect(isPrivateOrLocalIp('172.32.0.1')).toBe(false);
      expect(isPrivateOrLocalIp('192.168.1.100')).toBe(true);
      expect(isPrivateOrLocalIp('::1')).toBe(true);
      expect(isPrivateOrLocalIp('fc00::1')).toBe(true);
      expect(isPrivateOrLocalIp('fe80::1ff:fe23:4567:890a')).toBe(true);
      expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);

      expect(
        extractClientIp({
          headers: { 'cf-connecting-ip': '::ffff:200.45.10.2' },
          ip: '127.0.0.1',
        }),
      ).toBe('200.45.10.2');
    });

    it('serializa details como JSON sanitizando credenciales y tokens', () => {
      const rawJson = sanitizeSecurityDetails(
        'Error con Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc password=MiClaveSecreta',
        'Error: fail\n  at token=abc12345',
      );
      expect(rawJson).toBeTruthy();
      const parsed = JSON.parse(rawJson as string);
      expect(parsed.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(parsed.message).not.toContain('MiClaveSecreta');
      expect(parsed.stack).not.toContain('abc12345');
    });
  });

  describe('SecurityTrafficMiddleware polling exclusion', () => {
    it('omite registrar tráfico/access-logs cuando llega x-monitor-key o hacia /api/security/*', () => {
      const securityServiceMock: any = {
        isIpBlocked: jest.fn().mockReturnValue(false),
        recordTrafficHit: jest.fn(),
      };
      const monitorBridgeMock: any = {
        recordAccessLog: jest.fn().mockResolvedValue(undefined),
      };
      const middleware = new SecurityTrafficMiddleware(
        securityServiceMock,
        monitorBridgeMock,
      );

      const res1 = new EventEmitter() as any;
      res1.statusCode = 200;
      const next1 = jest.fn();
      middleware.use(
        {
          headers: { 'x-monitor-key': 'secret' },
          originalUrl: '/api/documents',
          method: 'GET',
          ip: '190.50.10.5',
        } as any,
        res1,
        next1,
      );
      res1.emit('finish');
      expect(next1).toHaveBeenCalled();
      expect(securityServiceMock.recordTrafficHit).not.toHaveBeenCalled();
      expect(monitorBridgeMock.recordAccessLog).not.toHaveBeenCalled();

      const res2 = new EventEmitter() as any;
      res2.statusCode = 200;
      const next2 = jest.fn();
      middleware.use(
        {
          headers: {},
          originalUrl: '/api/security/access-logs',
          method: 'GET',
          ip: '190.50.10.5',
        } as any,
        res2,
        next2,
      );
      res2.emit('finish');
      expect(securityServiceMock.recordTrafficHit).not.toHaveBeenCalled();
      expect(monitorBridgeMock.recordAccessLog).not.toHaveBeenCalled();
    });

    it('registra FRONTEND_VISIT de forma asíncrona al consultar /api/auth/me', () => {
      const securityServiceMock: any = {
        isIpBlocked: jest.fn().mockReturnValue(false),
        recordTrafficHit: jest.fn(),
      };
      const monitorBridgeMock: any = {
        recordAccessLog: jest.fn().mockResolvedValue(undefined),
      };
      const middleware = new SecurityTrafficMiddleware(
        securityServiceMock,
        monitorBridgeMock,
      );

      const res = new EventEmitter() as any;
      res.statusCode = 200;
      const next = jest.fn();
      middleware.use(
        {
          headers: { 'cf-connecting-ip': '200.45.10.2', 'user-agent': 'Chrome' },
          originalUrl: '/api/auth/me',
          method: 'GET',
        } as any,
        res,
        next,
      );
      res.emit('finish');

      expect(next).toHaveBeenCalled();
      expect(securityServiceMock.recordTrafficHit).toHaveBeenCalledTimes(1);
      expect(monitorBridgeMock.recordAccessLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'FRONTEND',
          eventType: 'FRONTEND_VISIT',
          ipAddress: '200.45.10.2',
          statusCode: 200,
        }),
      );
    });
  });

  describe('SecurityMonitorBridgeService y endpoints /security/*', () => {
    it('expone rutas @Public() protegidas por MonitorBridgeGuard en SecurityController', () => {
      for (const handlerName of [
        'getMonitorAccessLogs',
        'getMonitorIpSummary',
        'getMonitorCountrySummary',
      ] as const) {
        const handler = (SecurityController.prototype as any)[handlerName];
        const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler);
        const guards = Reflect.getMetadata(GUARDS_METADATA, handler);
        expect(isPublic).toBe(true);
        expect(guards).toContain(MonitorBridgeGuard);
      }
    });

    it('retorna contrato exacto en access-logs, ip-summary y country-summary', async () => {
      const sampleRows = [
        {
          id: 1,
          source: 'AUTH',
          eventType: 'LOGIN_FAILED',
          ipAddress: '190.50.10.5',
          isPrivateIp: false,
          countryCode: 'AR',
          countryName: 'Argentina',
          region: 'Buenos Aires',
          city: 'CABA',
          ispOrg: 'AS7303 Telecom Argentina S.A.',
          userAgent: 'Chrome/120',
          method: 'POST',
          path: '/api/auth/login',
          statusCode: 401,
          usernameAttempted: 'admin',
          details: JSON.stringify({ message: 'Contraseña incorrecta' }),
          createdAt: new Date('2026-11-26T00:00:00.000Z'),
        },
        {
          id: 2,
          source: 'FRONTEND',
          eventType: 'FRONTEND_VISIT',
          ipAddress: '190.50.10.5',
          isPrivateIp: false,
          countryCode: 'AR',
          countryName: 'Argentina',
          region: 'Buenos Aires',
          city: 'CABA',
          ispOrg: 'AS7303 Telecom Argentina S.A.',
          userAgent: 'Chrome/120',
          method: 'GET',
          path: '/api/auth/me',
          statusCode: 200,
          usernameAttempted: 'admin',
          details: JSON.stringify({ message: 'Carga de sesión web' }),
          createdAt: new Date('2026-11-26T00:01:00.000Z'),
        },
      ];

      const accessLogModelMock: any = {
        findAndCountAll: jest.fn().mockResolvedValue({ rows: sampleRows, count: 2 }),
        findAll: jest.fn().mockResolvedValue(sampleRows),
        count: jest
          .fn()
          .mockResolvedValueOnce(1) // uniquePublicIps24h
          .mockResolvedValueOnce(1) // uniqueCountries24h
          .mockResolvedValueOnce(1) // failedLogins24h
          .mockResolvedValueOnce(1) // frontendVisits24h
          .mockResolvedValueOnce(1) // apiRejected24h
          .mockResolvedValueOnce(1) // errors4xx24h
          .mockResolvedValueOnce(0), // errors5xx24h
      };

      const sequelizeMock: any = {
        query: jest
          .fn()
          .mockResolvedValueOnce([
            { client_addr: '127.0.0.1' },
            { client_addr: '190.50.10.99' },
          ]),
      };

      const geoIpServiceMock: any = {
        getOrLookupIp: jest.fn(),
      };

      const bridgeService = new SecurityMonitorBridgeService(
        accessLogModelMock,
        geoIpServiceMock,
        sequelizeMock,
      );

      const accessLogsRes = await bridgeService.getAccessLogs({
        page: 0,
        pageSize: 25,
        onlyPublic: 'true',
        statusGroup: 'ERRORS',
      });

      expect(accessLogsRes.total).toBe(2);
      expect(accessLogsRes.data[0]).toEqual(
        expect.objectContaining({
          id: 1,
          source: 'AUTH',
          eventType: 'LOGIN_FAILED',
          ipAddress: '190.50.10.5',
          isPrivateIp: false,
          countryCode: 'AR',
          ispOrg: 'AS7303 Telecom Argentina S.A.',
          statusCode: 401,
          usernameAttempted: 'admin',
          createdAt: '2026-11-26T00:00:00.000Z',
        }),
      );
      expect(accessLogsRes.summary).toEqual({
        uniquePublicIps24h: 1,
        uniqueCountries24h: 1,
        failedLogins24h: 1,
        frontendVisits24h: 1,
        apiRejected24h: 1,
        errors4xx24h: 1,
        errors5xx24h: 0,
        activeDbConnections: 2,
        publicDbConnections: 1,
      });

      // Para ip-summary / country-summary sin PostgreSQL real, probar agregación fallback
      const bridgeNoSql = new SecurityMonitorBridgeService(
        accessLogModelMock,
        geoIpServiceMock,
        undefined,
      );
      const ipSummary = await bridgeNoSql.getIpSummary({ onlyPublic: 'true' });
      expect(ipSummary.data).toEqual([
        expect.objectContaining({
          ipAddress: '190.50.10.5',
          isPrivateIp: false,
          countryCode: 'AR',
          totalEvents: 2,
          loginFailedCount: 1,
          apiRejectedCount: 1,
          clientErrorCount: 1,
          serverErrorCount: 0,
          frontendVisitCount: 1,
          usernamesAttempted: 'admin',
        }),
      ]);

      const countrySummary = await bridgeNoSql.getCountrySummary({ onlyPublic: 'true' });
      expect(countrySummary.data).toEqual([
        expect.objectContaining({
          countryCode: 'AR',
          countryName: 'Argentina',
          isPrivateIp: false,
          uniqueIps: 1,
          totalEvents: 2,
          loginFailedCount: 1,
          apiRejectedCount: 1,
          clientErrorCount: 1,
          frontendVisitCount: 1,
          sampleIps: '190.50.10.5',
        }),
      ]);
    });
  });
});
