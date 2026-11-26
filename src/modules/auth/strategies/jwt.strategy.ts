import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { UsersService } from '../../users/users.service';
import { resolveJwtSecret } from '../../../config/env-resolver';
import { SecurityService } from '../../security/services/security.service';
import { SecurityLoginEventType } from '../../security/models/security-login-event.model';
import { extractClientIp } from '../../security/helpers/security-request.helper';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    @Optional() private readonly securityService?: SecurityService,
  ) {
    const secretOrKey = resolveJwtSecret();
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey,
      passReqToCallback: true,
    });
  }

  async validate(
    reqOrData: Request | JwtPayload,
    maybeData?: JwtPayload,
  ): Promise<any> {
    const req = maybeData ? (reqOrData as Request) : undefined;
    const data = maybeData || (reqOrData as JwtPayload);
    try {
      const user = await this.usersService.findOneByEmail(data.email);
      if (!user) {
        throw new UnauthorizedException('Usuario no encontrado');
      }
      if (user.status === 'INACTIVE' || user.status === 'SUSPENDED') {
        throw new UnauthorizedException('La cuenta se encuentra inactiva o suspendida');
      }
      if (user.activeSessionId && data.sessionId !== user.activeSessionId) {
        void this.securityService?.recordLoginEvent({
          eventType: SecurityLoginEventType.SESSION_REVOKED,
          usernameAttempted: user.username || data.email,
          userId: user.id,
          companyId: user.companyId ?? null,
          userRole: (user as any).role?.slug || data.role || null,
          ipAddress: req ? extractClientIp(req) : null,
          userAgent: req?.headers?.['user-agent'] || null,
          failureReason: 'SESSION_REPLACED',
          sessionId: data.sessionId || null,
        });
        throw new UnauthorizedException(
          'SESSION_REPLACED: Tu sesión fue cerrada porque se inició sesión desde otro dispositivo.',
        );
      }
      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Usuario no válido o sesión expirada');
    }
  }
}
