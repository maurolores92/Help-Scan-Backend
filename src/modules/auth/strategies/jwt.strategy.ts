import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { UsersService } from '../../users/users.service';
import { resolveJwtSecret } from '../../../config/env-resolver';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    const secretOrKey = resolveJwtSecret();
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey,
    });
  }

  async validate(data: JwtPayload): Promise<any> {
    try {
      const user = await this.usersService.findOneByEmail(data.email);
      if (!user) {
        throw new UnauthorizedException('Usuario no encontrado');
      }
      if (user.status === 'INACTIVE' || user.status === 'SUSPENDED') {
        throw new UnauthorizedException('La cuenta se encuentra inactiva o suspendida');
      }
      if (user.activeSessionId && data.sessionId !== user.activeSessionId) {
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
