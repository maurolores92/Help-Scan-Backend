import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { assertPlatformSuperAdmin } from '../../common/utils/tenant-scope.util';
import { SecurityService } from './services/security.service';
import { SecurityMonitorBridgeService } from './services/security-monitor-bridge.service';
import { MonitorBridgeGuard } from './guards/monitor-bridge.guard';
import {
  QueryAccessLogsDto,
  QueryBridgeSummaryDto,
  QuerySecurityErrorsDto,
  QuerySecurityIpsDto,
  QuerySecurityLoginsDto,
  ReportClientErrorDto,
  ToggleIpBlockDto,
} from './dto/security-query.dto';
import { SecurityErrorSource } from './models/security-error-log.model';
import { extractClientIp } from './helpers/security-request.helper';
import { resolveJwtSecret } from '../../config/env-resolver';

/**
 * Controlador de Monitoreo de Seguridad.
 * Incluye endpoints internos para Super Administrador y endpoints puente (`x-monitor-key`)
 * para el dashboard externo HelpCopies Monitor.
 */
@Controller('security')
@UseGuards(JwtAuthGuard)
export class SecurityController {
  constructor(
    private readonly securityService: SecurityService,
    private readonly jwtService: JwtService,
    private readonly monitorBridgeService: SecurityMonitorBridgeService,
  ) {}

  @Public()
  @UseGuards(MonitorBridgeGuard)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Get('access-logs')
  getMonitorAccessLogs(@Query() query: QueryAccessLogsDto) {
    return this.monitorBridgeService.getAccessLogs(query);
  }

  @Public()
  @UseGuards(MonitorBridgeGuard)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Get('ip-summary')
  getMonitorIpSummary(@Query() query: QueryBridgeSummaryDto) {
    return this.monitorBridgeService.getIpSummary(query);
  }

  @Public()
  @UseGuards(MonitorBridgeGuard)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Get('country-summary')
  getMonitorCountrySummary(@Query() query: QueryBridgeSummaryDto) {
    return this.monitorBridgeService.getCountrySummary(query);
  }

  @Public()
  @Throttle({ default: { limit: 25, ttl: 60000 } })
  @Post('client-errors')
  @HttpCode(HttpStatus.ACCEPTED)
  async reportClientError(
    @Body() dto: ReportClientErrorDto,
    @Req() req: Request,
  ) {
    let userId: number | null = null;
    let username: string | null = null;
    let companyId: number | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded: any = this.jwtService.verify(authHeader.slice(7), {
          secret: resolveJwtSecret(),
        });
        userId = decoded?.id ? Number(decoded.id) : null;
        username = decoded?.username || decoded?.email || null;
        companyId = decoded?.companyId ? Number(decoded.companyId) : null;
      } catch {
        // Token expirado o inválido: igualmente registramos el error de cliente
      }
    }

    await this.securityService.recordErrorLog({
      source: SecurityErrorSource.FRONTEND,
      statusCode: dto.statusCode ?? 0,
      method: dto.method || 'UI',
      path: dto.path,
      frontendRoute: dto.frontendRoute || null,
      errorCode: dto.errorCode || null,
      message: dto.message,
      stackTrace: dto.stackTrace || null,
      userId,
      username,
      companyId,
      ipAddress: extractClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    });

    return { accepted: true };
  }

  @Get('overview')
  getOverview(@Query('days') days: string, @GetUser() user: any) {
    assertPlatformSuperAdmin(
      user,
      'El centro de monitoreo de seguridad es exclusivo del Super Administrador.',
    );
    return this.securityService.getOverview(days ? Number(days) : 7);
  }

  @Get('ips')
  listIps(@Query() query: QuerySecurityIpsDto, @GetUser() user: any) {
    assertPlatformSuperAdmin(
      user,
      'El registro de IPs es exclusivo del Super Administrador.',
    );
    return this.securityService.listIps(query);
  }

  @Post('ips/:ip/refresh')
  refreshIp(@Param('ip') ip: string, @GetUser() user: any) {
    assertPlatformSuperAdmin(user);
    return this.securityService.refreshIpIntelligence(decodeURIComponent(ip));
  }

  @Patch('ips/:ip/block')
  toggleIpBlock(
    @Param('ip') ip: string,
    @Body() dto: ToggleIpBlockDto,
    @GetUser() user: any,
    @Req() req: Request,
  ) {
    assertPlatformSuperAdmin(user);
    return this.securityService.toggleIpBlock(
      decodeURIComponent(ip),
      dto,
      Number(user.id),
      extractClientIp(req),
    );
  }

  @Get('logins')
  listLoginEvents(@Query() query: QuerySecurityLoginsDto, @GetUser() user: any) {
    assertPlatformSuperAdmin(user);
    return this.securityService.listLoginEvents(query);
  }

  @Get('errors')
  listErrorLogs(@Query() query: QuerySecurityErrorsDto, @GetUser() user: any) {
    assertPlatformSuperAdmin(user);
    return this.securityService.listErrorLogs(query);
  }
}
