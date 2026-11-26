import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  Optional,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SecurityService } from '../services/security.service';
import { SecurityMonitorBridgeService } from '../services/security-monitor-bridge.service';
import {
  extractClientIp,
  isPrivateOrLocalIp,
} from '../helpers/security-request.helper';

const ACCESS_LOG_THROTTLE_MS = 30 * 1000;
const FRONTEND_VISIT_THROTTLE_MS = 60 * 1000;

/**
 * Middleware global para verificar IPs bloqueadas, registrar tráfico de IPs públicas
 * y capturar accesos relevantes para `monitor`, omitiendo consultas propias de `/security/*`
 * y peticiones autenticadas con `x-monitor-key`.
 */
@Injectable()
export class SecurityTrafficMiddleware implements NestMiddleware {
  private readonly recentAccessHits = new Map<string, number>();

  constructor(
    private readonly securityService: SecurityService,
    @Optional()
    private readonly monitorBridgeService?: SecurityMonitorBridgeService,
  ) {}

  private shouldThrottleAccessLog(key: string, windowMs: number): boolean {
    const now = Date.now();
    const lastSeen = this.recentAccessHits.get(key) || 0;
    if (now - lastSeen < windowMs) {
      return true;
    }
    if (this.recentAccessHits.size >= 5000) {
      const oldestKey = this.recentAccessHits.keys().next().value;
      if (oldestKey) this.recentAccessHits.delete(oldestKey);
    }
    this.recentAccessHits.set(key, now);
    return false;
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const ip = extractClientIp(req);
    const reqPath = req.originalUrl || req.url || '';
    const hasMonitorKey = Boolean(req.headers?.['x-monitor-key']);
    const isSecurityPath =
      reqPath.startsWith('/api/security') || reqPath.startsWith('/security');

    if (this.securityService.isIpBlocked(ip)) {
      throw new ForbiddenException(
        'Acceso denegado: tu dirección IP fue bloqueada por el administrador de seguridad.',
      );
    }

    if (hasMonitorKey || isSecurityPath) {
      next();
      return;
    }

    // Solo persistir IPs públicas en inteligencia de red; ignorar routers/proxies locales
    if (!isPrivateOrLocalIp(ip)) {
      const reqUser = (req as any)?.user;
      this.securityService.recordTrafficHit({
        ipAddress: ip,
        path: reqPath,
        userAgent: req.headers['user-agent'] || null,
        userId: reqUser?.id ?? null,
        companyId: reqUser?.companyId ?? null,
      });
    }

    const method = (req.method || 'GET').toUpperCase();
    const isStaticOrNoise =
      method === 'OPTIONS' ||
      reqPath.startsWith('/api/images') ||
      reqPath.startsWith('/images') ||
      reqPath.startsWith('/socket.io') ||
      reqPath.includes('/notifications/unread-count') ||
      reqPath.includes('/auth/login') ||
      reqPath.includes('/auth/logout');

    if (!isStaticOrNoise && this.monitorBridgeService && typeof res?.on === 'function') {
      res.on('finish', () => {
        const statusCode = Number(res.statusCode || 200);
        // Los errores >= 400 ya quedan registrados en AllExceptionsFilter con stack/detalle sanitizado
        if (statusCode >= 400) return;

        const cleanPath = reqPath.split('?')[0] || '/';
        const isFrontendVisit = cleanPath.endsWith('/auth/me');
        const eventType = isFrontendVisit ? 'FRONTEND_VISIT' : 'HTTP_ACCESS';
        const windowMs = isFrontendVisit
          ? FRONTEND_VISIT_THROTTLE_MS
          : ACCESS_LOG_THROTTLE_MS;
        const throttleKey = `${ip}:${eventType}:${cleanPath}`;

        if (this.shouldThrottleAccessLog(throttleKey, windowMs)) {
          return;
        }

        const reqUser = (req as any)?.user;
        void this.monitorBridgeService?.recordAccessLog({
          source: isFrontendVisit ? 'FRONTEND' : 'API',
          eventType,
          ipAddress: ip,
          userAgent: req.headers['user-agent'] || null,
          method,
          path: cleanPath,
          statusCode,
          usernameAttempted: reqUser?.username || reqUser?.email || null,
          message: isFrontendVisit ? 'Carga de sesión web' : 'Acceso API',
        });
      });
    }

    next();
  }
}
