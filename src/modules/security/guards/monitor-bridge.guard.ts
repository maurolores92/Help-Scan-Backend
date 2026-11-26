import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Guard exclusivo para el puente de monitoreo externo HelpCopies Monitor.
 * Valida el header `x-monitor-key` contra `process.env.MONITOR_BRIDGE_KEY`
 * utilizando comparación en tiempo constante (`timingSafeEqual`), sin depender de JWT.
 */
@Injectable()
export class MonitorBridgeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedKey = process.env.MONITOR_BRIDGE_KEY?.trim();
    if (!expectedKey) {
      throw new UnauthorizedException(
        'MONITOR_BRIDGE_KEY no está configurada en el servidor.',
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const rawHeader = req.headers['x-monitor-key'];
    const providedKey = Array.isArray(rawHeader)
      ? String(rawHeader[0] || '').trim()
      : typeof rawHeader === 'string'
        ? rawHeader.trim()
        : '';

    if (!providedKey) {
      throw new UnauthorizedException('Header x-monitor-key requerido.');
    }

    // Hash SHA-256 fijo (32 bytes) para usar timingSafeEqual sin filtrar longitud
    const expectedDigest = createHash('sha256').update(expectedKey, 'utf8').digest();
    const providedDigest = createHash('sha256').update(providedKey, 'utf8').digest();

    if (!timingSafeEqual(expectedDigest, providedDigest)) {
      throw new ForbiddenException('Credencial x-monitor-key inválida.');
    }

    return true;
  }
}
