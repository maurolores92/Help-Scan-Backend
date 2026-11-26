import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Cron, CronExpression } from '@nestjs/schedule';
import { col, fn, Op } from 'sequelize';
import {
  SecurityIpIntelligence,
} from '../models/security-ip-intelligence.model';
import {
  SecurityLoginEvent,
  SecurityLoginEventType,
} from '../models/security-login-event.model';
import {
  SecurityErrorLog,
  SecurityErrorSeverity,
  SecurityErrorSource,
} from '../models/security-error-log.model';
import {
  QuerySecurityErrorsDto,
  QuerySecurityIpsDto,
  QuerySecurityLoginsDto,
  ToggleIpBlockDto,
} from '../dto/security-query.dto';
import { GeoIpService } from './geo-ip.service';
import {
  isPrivateOrLocalIp,
  normalizeIpAddress,
  parseUserAgentSummary,
  sanitizeSecurityPayload,
} from '../helpers/security-request.helper';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationsGateway } from '../../notifications/notifications.gateway';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';

interface BufferedTrafficHit {
  ipAddress: string;
  count: number;
  lastPath: string | null;
  lastUserAgent: string | null;
  lastUserId: number | null;
  lastCompanyId: number | null;
  lastSeenAt: Date;
}

const DEFAULT_RETENTION_DAYS = 60;
const BRUTE_FORCE_WINDOW_MS = 5 * 60 * 1000;
const BRUTE_FORCE_THRESHOLD = 5;

@Injectable()
export class SecurityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityService.name);
  private readonly blockedIps = new Set<string>();
  private readonly trafficBuffer = new Map<string, BufferedTrafficHit>();
  private readonly bruteForceCooldowns = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushingTraffic = false;

  constructor(
    @InjectModel(SecurityIpIntelligence)
    private readonly ipModel: typeof SecurityIpIntelligence,
    @InjectModel(SecurityLoginEvent)
    private readonly loginEventModel: typeof SecurityLoginEvent,
    @InjectModel(SecurityErrorLog)
    private readonly errorLogModel: typeof SecurityErrorLog,
    private readonly geoIpService: GeoIpService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly notificationsGateway?: NotificationsGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    AllExceptionsFilter.setErrorRecorder((err) => {
      void this.recordErrorLog({
        source: SecurityErrorSource.BACKEND,
        statusCode: err.statusCode,
        method: err.method,
        path: err.path,
        errorCode: err.errorCode,
        message: err.message,
        stackTrace: err.stackTrace,
        sanitizedPayload: err.payload,
        userId: err.userId,
        username: err.username,
        companyId: err.companyId,
        ipAddress: err.ipAddress,
        userAgent: err.userAgent,
      });
    });

    if (process.env.NODE_ENV !== 'test') {
      await this.purgePrivateIpRecords().catch(() => {});
      await this.reloadBlockedIps().catch((e) => {
        this.logger.warn(`No se pudo precargar lista de IPs bloqueadas: ${e?.message}`);
      });

      this.flushTimer = setInterval(() => {
        void this.flushTrafficBuffer();
      }, 5000);
      this.flushTimer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    AllExceptionsFilter.setErrorRecorder(null);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushTrafficBuffer().catch(() => {});
  }

  getRetentionDays(): number {
    const raw = Number(process.env.SECURITY_LOG_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_RETENTION_DAYS;
  }

  async purgePrivateIpRecords(): Promise<number> {
    const rows = await this.ipModel.findAll({
      where: { isBlocked: false },
      attributes: ['id', 'ipAddress'],
      raw: true,
    });
    const privateIds = rows
      .filter((row) => isPrivateOrLocalIp(row.ipAddress))
      .map((row) => row.id);
    if (privateIds.length === 0) return 0;

    return this.ipModel.destroy({
      where: { id: { [Op.in]: privateIds } },
    });
  }

  async reloadBlockedIps(): Promise<void> {
    const rows = await this.ipModel.findAll({
      where: { isBlocked: true },
      attributes: ['ipAddress'],
      raw: true,
    });
    this.blockedIps.clear();
    for (const row of rows) {
      if (row.ipAddress) {
        this.blockedIps.add(normalizeIpAddress(row.ipAddress));
      }
    }
  }

  isIpBlocked(rawIp: string): boolean {
    const ip = normalizeIpAddress(rawIp);
    if (isPrivateOrLocalIp(ip)) return false;
    return this.blockedIps.has(ip);
  }

  recordTrafficHit(params: {
    ipAddress: string;
    path?: string | null;
    userAgent?: string | null;
    userId?: number | null;
    companyId?: number | null;
  }): void {
    const ip = normalizeIpAddress(params.ipAddress);
    if (isPrivateOrLocalIp(ip)) return;
    const existing = this.trafficBuffer.get(ip);
    const now = new Date();
    if (existing) {
      existing.count += 1;
      existing.lastPath = params.path ? String(params.path).slice(0, 300) : existing.lastPath;
      existing.lastUserAgent = params.userAgent ? String(params.userAgent).slice(0, 500) : existing.lastUserAgent;
      existing.lastUserId = params.userId ?? existing.lastUserId;
      existing.lastCompanyId = params.companyId ?? existing.lastCompanyId;
      existing.lastSeenAt = now;
    } else {
      this.trafficBuffer.set(ip, {
        ipAddress: ip,
        count: 1,
        lastPath: params.path ? String(params.path).slice(0, 300) : null,
        lastUserAgent: params.userAgent ? String(params.userAgent).slice(0, 500) : null,
        lastUserId: params.userId ?? null,
        lastCompanyId: params.companyId ?? null,
        lastSeenAt: now,
      });
    }
  }

  async flushTrafficBuffer(): Promise<void> {
    if (this.isFlushingTraffic || this.trafficBuffer.size === 0) return;
    this.isFlushingTraffic = true;

    const batch = Array.from(this.trafficBuffer.values());
    this.trafficBuffer.clear();

    try {
      for (const hit of batch) {
        try {
          const [record, created] = await this.ipModel.findOrCreate({
            where: { ipAddress: hit.ipAddress },
            defaults: {
              ipAddress: hit.ipAddress,
              firstSeenAt: hit.lastSeenAt,
              lastSeenAt: hit.lastSeenAt,
              totalRequests: hit.count,
              lastPath: hit.lastPath,
              lastUserAgent: hit.lastUserAgent,
              lastUserId: hit.lastUserId,
              lastCompanyId: hit.lastCompanyId,
            } as never,
          });

          if (!created) {
            await record.update({
              lastSeenAt: hit.lastSeenAt,
              totalRequests: Number(record.totalRequests || 0) + hit.count,
              ...(hit.lastPath ? { lastPath: hit.lastPath } : {}),
              ...(hit.lastUserAgent ? { lastUserAgent: hit.lastUserAgent } : {}),
              ...(hit.lastUserId ? { lastUserId: hit.lastUserId } : {}),
              ...(hit.lastCompanyId !== null && hit.lastCompanyId !== undefined
                ? { lastCompanyId: hit.lastCompanyId }
                : {}),
            });
          }

          if (
            !record.lookupExpiresAt ||
            new Date(record.lookupExpiresAt).getTime() <= Date.now()
          ) {
            void this.geoIpService.getOrLookupIp(hit.ipAddress).catch(() => {});
          }
        } catch (err: any) {
          this.logger.debug(`Error persistiendo tráfico de IP ${hit.ipAddress}: ${err?.message}`);
        }
      }
    } finally {
      this.isFlushingTraffic = false;
    }
  }

  async recordLoginEvent(params: {
    eventType: SecurityLoginEventType;
    usernameAttempted?: string | null;
    userId?: number | null;
    companyId?: number | null;
    userRole?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    failureReason?: string | null;
    sessionId?: string | null;
  }): Promise<void> {
    try {
      const ip = normalizeIpAddress(params.ipAddress);
      const isPrivateIp = isPrivateOrLocalIp(ip);
      const geo = isPrivateIp
        ? {
            ipAddress: ip,
            countryCode: 'LOCAL',
            countryName: 'Red Local / Router Interno',
            isp: 'Red Privada',
          }
        : await this.geoIpService.getOrLookupIp(ip).catch(() => ({
            ipAddress: ip,
            countryCode: null,
            countryName: null,
            isp: null,
          }));
      const ua = parseUserAgentSummary(params.userAgent);

      const created = await this.loginEventModel.create({
        eventType: params.eventType,
        usernameAttempted: params.usernameAttempted
          ? String(params.usernameAttempted).slice(0, 150)
          : null,
        userId: params.userId ?? null,
        companyId: params.companyId ?? null,
        userRole: params.userRole ? String(params.userRole).slice(0, 50) : null,
        ipAddress: ip,
        countryCode: geo.countryCode || null,
        countryName: geo.countryName || null,
        ispOwner: geo.isp || null,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 1000) : null,
        browser: ua.browser,
        os: ua.os,
        deviceType: ua.deviceType,
        failureReason: params.failureReason
          ? String(params.failureReason).slice(0, 250)
          : null,
        sessionId: params.sessionId ? String(params.sessionId).slice(0, 64) : null,
      } as never);

      if (!isPrivateIp) {
        const [ipRecord] = await this.ipModel.findOrCreate({
          where: { ipAddress: ip },
          defaults: {
            ipAddress: ip,
            countryCode: geo.countryCode || null,
            countryName: geo.countryName || null,
            isp: geo.isp || null,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            totalRequests: 1,
            failedLoginsCount:
              params.eventType === SecurityLoginEventType.LOGIN_FAILED ? 1 : 0,
          } as never,
        });

        await ipRecord.update({
          lastSeenAt: new Date(),
          ...(params.userId ? { lastUserId: params.userId } : {}),
          ...(params.companyId !== undefined ? { lastCompanyId: params.companyId } : {}),
          ...(params.eventType === SecurityLoginEventType.LOGIN_FAILED
            ? { failedLoginsCount: Number(ipRecord.failedLoginsCount || 0) + 1 }
            : {}),
        });
      }

      this.notificationsGateway?.emitToSuperAdmins?.('security:event', {
        kind: 'LOGIN',
        id: created.id,
        eventType: params.eventType,
        username: params.usernameAttempted || null,
        ipAddress: ip,
        countryCode: geo.countryCode,
        countryName: geo.countryName,
        ispOwner: geo.isp,
        browser: ua.browser,
        os: ua.os,
        failureReason: params.failureReason || null,
        createdAt: (created as any).createdAt || new Date().toISOString(),
      });

      if (params.eventType === SecurityLoginEventType.LOGIN_FAILED) {
        await this.checkBruteForceThreshold(ip, geo.countryName, geo.isp);
      }
    } catch (err: any) {
      this.logger.warn(`Error registrando evento de login: ${err?.message}`);
    }
  }

  private async checkBruteForceThreshold(
    ip: string,
    countryName?: string | null,
    ispOwner?: string | null,
  ): Promise<void> {
    const lastAlert = this.bruteForceCooldowns.get(ip) || 0;
    if (Date.now() - lastAlert < 10 * 60 * 1000) return;

    const since = new Date(Date.now() - BRUTE_FORCE_WINDOW_MS);
    const recentFails = await this.loginEventModel.count({
      where: {
        ipAddress: ip,
        eventType: SecurityLoginEventType.LOGIN_FAILED,
        createdAt: { [Op.gte]: since },
      },
    });

    if (recentFails >= BRUTE_FORCE_THRESHOLD) {
      this.bruteForceCooldowns.set(ip, Date.now());
      await this.notificationsService.dispatch({
        type: 'security.threat_detected',
        title: '🛡️ Posible ataque de fuerza bruta',
        body: `La IP ${ip}${countryName ? ` (${countryName})` : ''}${ispOwner ? ` · ${ispOwner}` : ''} registró ${recentFails} intentos fallidos de acceso en los últimos 5 minutos.`,
        extraData: { ipAddress: ip, recentFails, link: '/security' },
      });
      this.notificationsGateway?.emitToSuperAdmins?.('security:event', {
        kind: 'THREAT',
        ipAddress: ip,
        countryName: countryName || null,
        ispOwner: ispOwner || null,
        failedAttempts: recentFails,
        message: `Fuerza bruta detectada (${recentFails} intentos fallidos en 5 min)`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async recordErrorLog(params: {
    source: SecurityErrorSource;
    statusCode: number;
    method?: string | null;
    path: string;
    frontendRoute?: string | null;
    errorCode?: string | null;
    message: string;
    stackTrace?: string | null;
    sanitizedPayload?: Record<string, any> | null;
    userId?: number | null;
    username?: string | null;
    companyId?: number | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    try {
      const statusCode = Number(params.statusCode || 0);
      if (
        params.source === SecurityErrorSource.BACKEND &&
        statusCode < 400
      ) {
        return;
      }

      const ip = normalizeIpAddress(params.ipAddress);
      const isPrivateIp = isPrivateOrLocalIp(ip);
      const geo = isPrivateIp
        ? {
            ipAddress: ip,
            countryCode: 'LOCAL',
            countryName: 'Red Local / Router Interno',
            isp: 'Red Privada',
          }
        : await this.geoIpService.getOrLookupIp(ip).catch(() => ({
            ipAddress: ip,
            countryCode: null,
            countryName: null,
            isp: null,
          }));

      const severity =
        statusCode >= 500 || statusCode === 0
          ? SecurityErrorSeverity.CRITICAL
          : SecurityErrorSeverity.WARN;

      const created = await this.errorLogModel.create({
        source: params.source,
        statusCode,
        severity,
        method: params.method ? String(params.method).toUpperCase().slice(0, 16) : null,
        path: String(params.path || '/').slice(0, 500),
        frontendRoute: params.frontendRoute
          ? String(params.frontendRoute).slice(0, 300)
          : null,
        errorCode: params.errorCode ? String(params.errorCode).slice(0, 80) : null,
        message: String(params.message || 'Error sin detalle').slice(0, 4000),
        stackTrace: params.stackTrace ? String(params.stackTrace).slice(0, 8000) : null,
        sanitizedPayload: params.sanitizedPayload
          ? sanitizeSecurityPayload(params.sanitizedPayload)
          : null,
        userId: params.userId ?? null,
        username: params.username ? String(params.username).slice(0, 150) : null,
        companyId: params.companyId ?? null,
        ipAddress: ip,
        countryCode: geo.countryCode || null,
        countryName: geo.countryName || null,
        ispOwner: geo.isp || null,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 1000) : null,
      } as never);

      if (!isPrivateIp) {
        const [ipRecord] = await this.ipModel.findOrCreate({
          where: { ipAddress: ip },
          defaults: {
            ipAddress: ip,
            countryCode: geo.countryCode || null,
            countryName: geo.countryName || null,
            isp: geo.isp || null,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            totalRequests: 1,
            errorCount: 1,
          } as never,
        });

        await ipRecord.update({
          lastSeenAt: new Date(),
          errorCount: Number(ipRecord.errorCount || 0) + 1,
        });
      }

      this.notificationsGateway?.emitToSuperAdmins?.('security:event', {
        kind: 'ERROR',
        id: created.id,
        source: params.source,
        statusCode,
        severity,
        method: params.method || null,
        path: params.path,
        message: String(params.message || '').slice(0, 220),
        ipAddress: ip,
        countryCode: geo.countryCode,
        countryName: geo.countryName,
        ispOwner: geo.isp,
        username: params.username || null,
        createdAt: (created as any).createdAt || new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(`Error registrando log de error de seguridad: ${err?.message}`);
    }
  }

  async getOverview(days = 7) {
    await this.flushTrafficBuffer().catch(() => {});
    const safeDays = Math.min(60, Math.max(1, Number(days || 7)));
    const sincePeriod = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalIpsTracked,
      activeIps24h,
      blockedIpsCount,
      loginsSuccessPeriod,
      loginsFailedPeriod,
      loginsBlockedPeriod,
      errors4xxPeriod,
      errors5xxPeriod,
      frontendErrorsPeriod,
      backendErrorsPeriod,
      topCountriesRaw,
    ] = await Promise.all([
      this.ipModel.count(),
      this.ipModel.count({ where: { lastSeenAt: { [Op.gte]: since24h } } }),
      this.ipModel.count({ where: { isBlocked: true } }),
      this.loginEventModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          eventType: {
            [Op.in]: [
              SecurityLoginEventType.LOGIN_SUCCESS,
              SecurityLoginEventType.SESSION_FORCED_TAKEOVER,
            ],
          },
        },
      }),
      this.loginEventModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          eventType: SecurityLoginEventType.LOGIN_FAILED,
        },
      }),
      this.loginEventModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          eventType: SecurityLoginEventType.LOGIN_BLOCKED_ACTIVE_SESSION,
        },
      }),
      this.errorLogModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          statusCode: { [Op.gte]: 400, [Op.lt]: 500 },
        },
      }),
      this.errorLogModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          [Op.or]: [
            { statusCode: { [Op.gte]: 500 } },
            { statusCode: 0 },
          ],
        },
      }),
      this.errorLogModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          source: SecurityErrorSource.FRONTEND,
        },
      }),
      this.errorLogModel.count({
        where: {
          createdAt: { [Op.gte]: sincePeriod },
          source: SecurityErrorSource.BACKEND,
        },
      }),
      this.ipModel.findAll({
        attributes: [
          'countryCode',
          'countryName',
          [fn('COUNT', col('id')), 'ipsCount'],
        ],
        where: {
          countryCode: { [Op.ne]: null },
        },
        group: ['countryCode', 'countryName'],
        order: [[fn('COUNT', col('id')), 'DESC']],
        limit: 8,
        raw: true,
      }) as unknown as Promise<Array<{ countryCode: string; countryName: string | null; ipsCount: string | number }>>,
    ]);

    return {
      periodDays: safeDays,
      retentionDays: this.getRetentionDays(),
      kpis: {
        totalIpsTracked,
        activeIps24h,
        blockedIpsCount,
        loginsSuccessPeriod,
        loginsFailedPeriod,
        loginsBlockedPeriod,
        errors4xxPeriod,
        errors5xxPeriod,
        frontendErrorsPeriod,
        backendErrorsPeriod,
      },
      topCountries: topCountriesRaw.map((row) => ({
        countryCode: row.countryCode,
        countryName: row.countryName || row.countryCode,
        ipsCount: Number(row.ipsCount || 0),
      })),
    };
  }

  async listIps(query: QuerySecurityIpsDto) {
    await this.flushTrafficBuffer().catch(() => {});
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 25);
    const offset = (page - 1) * limit;

    const where: any = {};
    if (query.blockedOnly === 'true') {
      where.isBlocked = true;
    }
    if (query.hasErrors === 'true') {
      where.errorCount = { [Op.gt]: 0 };
    }
    if (query.countryCode) {
      where.countryCode = query.countryCode.trim().toUpperCase();
    }
    if (query.search && query.search.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { ipAddress: { [Op.iLike]: term } },
        { countryName: { [Op.iLike]: term } },
        { countryCode: { [Op.iLike]: term } },
        { isp: { [Op.iLike]: term } },
        { organization: { [Op.iLike]: term } },
        { asn: { [Op.iLike]: term } },
      ];
    }

    const { rows, count } = await this.ipModel.findAndCountAll({
      where,
      order: [['lastSeenAt', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
    });

    return { items: rows, total: count, page, limit };
  }

  async refreshIpIntelligence(rawIp: string) {
    const ip = normalizeIpAddress(rawIp);
    await this.geoIpService.getOrLookupIp(ip, { forceRefresh: true });
    return this.ipModel.findOne({ where: { ipAddress: ip } });
  }

  async toggleIpBlock(
    rawIp: string,
    dto: ToggleIpBlockDto,
    actorUserId: number,
    requesterIp?: string,
  ) {
    const ip = normalizeIpAddress(rawIp);
    if (dto.blocked && isPrivateOrLocalIp(ip)) {
      throw new BadRequestException(
        'No se puede bloquear una dirección IP local o privada del servidor.',
      );
    }
    if (dto.blocked && requesterIp && normalizeIpAddress(requesterIp) === ip) {
      throw new BadRequestException(
        'No podés bloquear tu propia dirección IP actual de administración.',
      );
    }

    const geo = await this.geoIpService.getOrLookupIp(ip).catch(() => null);
    const [record] = await this.ipModel.findOrCreate({
      where: { ipAddress: ip },
      defaults: {
        ipAddress: ip,
        countryCode: geo?.countryCode || null,
        countryName: geo?.countryName || null,
        isp: geo?.isp || null,
        organization: geo?.organization || null,
        asn: geo?.asn || null,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      } as never,
    });

    await record.update({
      isBlocked: Boolean(dto.blocked),
      blockReason: dto.blocked
        ? (dto.reason?.trim() || 'Bloqueada manualmente desde el centro de seguridad.')
        : null,
      blockedByUserId: dto.blocked ? actorUserId : null,
      blockedAt: dto.blocked ? new Date() : null,
    });

    if (dto.blocked) {
      this.blockedIps.add(ip);
    } else {
      this.blockedIps.delete(ip);
    }

    await this.auditService.log({
      action: AuditAction.STATUS_CHANGE,
      entity: 'SecurityIpIntelligence',
      entityId: record.id,
      userId: actorUserId,
      ipAddress: requesterIp,
      payload: {
        ipAddress: ip,
        isBlocked: Boolean(dto.blocked),
        reason: record.blockReason,
      },
      description: dto.blocked
        ? `Bloqueó la IP ${ip} (${record.countryName || 'Desconocido'} · ${record.isp || 'Sin ISP'})`
        : `Desbloqueó la IP ${ip}`,
    });

    await this.notificationsService.dispatch({
      type: 'security.ip_blocked',
      title: dto.blocked ? `⛔ IP bloqueada: ${ip}` : `✅ IP desbloqueada: ${ip}`,
      body: dto.blocked
        ? `Motivo: ${record.blockReason}`
        : `La IP ${ip} volvió a quedar habilitada.`,
      extraData: { ipAddress: ip, isBlocked: Boolean(dto.blocked), link: '/security' },
    });

    this.notificationsGateway?.emitToSuperAdmins?.('security:event', {
      kind: 'IP_BLOCK',
      id: record.id,
      ipAddress: ip,
      isBlocked: Boolean(dto.blocked),
      reason: record.blockReason,
      countryName: record.countryName,
      ispOwner: record.isp,
      createdAt: new Date().toISOString(),
    });

    return record;
  }

  async listLoginEvents(query: QuerySecurityLoginsDto) {
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 25);
    const offset = (page - 1) * limit;

    const where: any = {};
    if (query.eventType) {
      where.eventType = query.eventType;
    }
    if (query.search && query.search.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { usernameAttempted: { [Op.iLike]: term } },
        { ipAddress: { [Op.iLike]: term } },
        { countryName: { [Op.iLike]: term } },
        { ispOwner: { [Op.iLike]: term } },
        { failureReason: { [Op.iLike]: term } },
      ];
    }

    const { rows, count } = await this.loginEventModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
    });

    return { items: rows, total: count, page, limit };
  }

  async listErrorLogs(query: QuerySecurityErrorsDto) {
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 25);
    const offset = (page - 1) * limit;

    const where: any = {};
    if (query.source) {
      where.source = query.source;
    }
    if (query.statusFamily === '4xx') {
      where.statusCode = { [Op.gte]: 400, [Op.lt]: 500 };
    } else if (query.statusFamily === '5xx') {
      where[Op.or] = [{ statusCode: { [Op.gte]: 500 } }, { statusCode: 0 }];
    }
    if (query.search && query.search.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { path: { [Op.iLike]: term } },
            { message: { [Op.iLike]: term } },
            { username: { [Op.iLike]: term } },
            { ipAddress: { [Op.iLike]: term } },
            { ispOwner: { [Op.iLike]: term } },
            { countryName: { [Op.iLike]: term } },
          ],
        },
      ];
    }

    const { rows, count } = await this.errorLogModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
    });

    return { items: rows, total: count, page, limit };
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredLogs(): Promise<{
    deletedLogins: number;
    deletedErrors: number;
    deletedIps: number;
  }> {
    const retentionDays = this.getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const ipCutoff = new Date(Date.now() - Math.max(retentionDays, 90) * 24 * 60 * 60 * 1000);

    const [deletedLogins, deletedErrors, deletedIps] = await Promise.all([
      this.loginEventModel.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
      this.errorLogModel.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
      this.ipModel.destroy({
        where: {
          isBlocked: false,
          lastSeenAt: { [Op.lt]: ipCutoff },
        },
      }),
    ]);

    if (deletedLogins > 0 || deletedErrors > 0 || deletedIps > 0) {
      this.logger.log(
        `[SecurityRetention ${retentionDays}d] Purgados ${deletedLogins} logins, ${deletedErrors} errores, ${deletedIps} IPs inactivas.`,
      );
    }

    return { deletedLogins, deletedErrors, deletedIps };
  }
}
