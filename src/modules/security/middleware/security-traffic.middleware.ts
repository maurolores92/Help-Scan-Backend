import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SecurityService } from '../services/security.service';
import {
  extractClientIp,
  isPrivateOrLocalIp,
} from '../helpers/security-request.helper';

/**
 * Middleware global para verificar IPs bloqueadas y registrar tráfico entrante de IPs públicas.
 */
@Injectable()
export class SecurityTrafficMiddleware implements NestMiddleware {
  constructor(private readonly securityService: SecurityService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const ip = extractClientIp(req);

    if (this.securityService.isIpBlocked(ip)) {
      throw new ForbiddenException(
        'Acceso denegado: tu dirección IP fue bloqueada por el administrador de seguridad.',
      );
    }

    // Solo persistir IPs públicas en inteligencia de red; ignorar routers/proxies locales
    if (!isPrivateOrLocalIp(ip)) {
      const reqUser = (req as any)?.user;
      this.securityService.recordTrafficHit({
        ipAddress: ip,
        path: req.originalUrl || req.url,
        userAgent: req.headers['user-agent'] || null,
        userId: reqUser?.id ?? null,
        companyId: reqUser?.companyId ?? null,
      });
    }

    next();
  }
}
