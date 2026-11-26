import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { col, fn, Op, QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { SecurityAccessLog } from '../models/security-access-log.model';
import {
  QueryAccessLogsDto,
  QueryBridgeSummaryDto,
} from '../dto/security-query.dto';
import { GeoIpService } from './geo-ip.service';
import {
  isPrivateOrLocalIp,
  normalizeIpAddress,
  sanitizeSecurityDetails,
} from '../helpers/security-request.helper';

export interface RecordAccessLogParams {
  source: string;
  eventType: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  usernameAttempted?: string | null;
  message?: string | null;
  stackTrace?: string | null;
}

const DEFAULT_RETENTION_DAYS = 60;

/**
 * Servicio puente de telemetría para HelpCopies Monitor (`/api/security/access-logs`,
 * `/api/security/ip-summary` y `/api/security/country-summary`).
 */
@Injectable()
export class SecurityMonitorBridgeService {
  private readonly logger = new Logger(SecurityMonitorBridgeService.name);

  constructor(
    @InjectModel(SecurityAccessLog)
    private readonly accessLogModel: typeof SecurityAccessLog,
    private readonly geoIpService: GeoIpService,
    @Optional() private readonly sequelize?: Sequelize,
  ) {}

  async recordAccessLog(params: RecordAccessLogParams): Promise<void> {
    try {
      const ip = normalizeIpAddress(params.ipAddress);
      const isPrivateIp = isPrivateOrLocalIp(ip);

      const geo = isPrivateIp
        ? {
            countryCode: 'LOCAL',
            countryName: 'Red Local / Servidor',
            region: null,
            city: 'Localhost',
            isp: 'Red Privada',
            organization: 'Red Privada',
            asn: null,
          }
        : await this.geoIpService.getOrLookupIp(ip).catch(() => ({
            countryCode: null,
            countryName: null,
            region: null,
            city: null,
            isp: null,
            organization: null,
            asn: null,
          }));

      const ispParts = [geo.asn, geo.isp || geo.organization].filter(Boolean);
      const ispOrg = ispParts.length > 0 ? ispParts.join(' ').slice(0, 255) : null;

      await this.accessLogModel.create({
        source: String(params.source || 'BACKEND').slice(0, 30),
        eventType: String(params.eventType || 'HTTP_ACCESS').slice(0, 50),
        ipAddress: ip,
        isPrivateIp,
        countryCode: isPrivateIp ? 'LOCAL' : geo.countryCode || null,
        countryName: geo.countryName || null,
        region: geo.region || null,
        city: geo.city || null,
        ispOrg,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 1000) : null,
        method: params.method
          ? String(params.method).toUpperCase().slice(0, 16)
          : null,
        path: params.path ? String(params.path).slice(0, 500) : null,
        statusCode:
          params.statusCode !== undefined && params.statusCode !== null
            ? Number(params.statusCode)
            : null,
        usernameAttempted: params.usernameAttempted
          ? String(params.usernameAttempted).slice(0, 150)
          : null,
        details: sanitizeSecurityDetails(params.message, params.stackTrace),
      } as never);
    } catch (err: any) {
      this.logger.debug(`Error persistiendo access log: ${err?.message}`);
    }
  }

  private async getActiveDbConnectionStats(): Promise<{
    activeDbConnections: number;
    publicDbConnections: number;
  }> {
    const db = this.sequelize || this.accessLogModel?.sequelize;
    if (!db) {
      return { activeDbConnections: 0, publicDbConnections: 0 };
    }

    try {
      const rows = (await db.query(
        `SELECT host(client_addr) AS client_addr
         FROM pg_stat_activity
         WHERE datname = current_database()`,
        { type: QueryTypes.SELECT },
      )) as Array<{ client_addr?: string | null }>;

      let publicCount = 0;
      for (const row of rows) {
        if (row.client_addr && !isPrivateOrLocalIp(row.client_addr)) {
          publicCount += 1;
        }
      }

      return {
        activeDbConnections: rows.length,
        publicDbConnections: publicCount,
      };
    } catch {
      return { activeDbConnections: 0, publicDbConnections: 0 };
    }
  }

  async getAccessLogs(query: QueryAccessLogsDto) {
    const page = Math.max(0, Number(query.page ?? 0) || 0);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 25) || 25));
    const offset = page * pageSize;

    const where: any = {};
    const andConditions: any[] = [];

    if (query.onlyPublic === 'true') {
      where.isPrivateIp = false;
    }

    const statusGroup = String(query.statusGroup || '').trim().toUpperCase();
    if (statusGroup === 'ERRORS') {
      andConditions.push({
        [Op.or]: [{ statusCode: { [Op.gte]: 400 } }, { statusCode: 0 }],
      });
    } else if (statusGroup === '5XX') {
      andConditions.push({
        [Op.or]: [{ statusCode: { [Op.gte]: 500 } }, { statusCode: 0 }],
      });
    } else if (statusGroup === '4XX') {
      andConditions.push({
        statusCode: { [Op.gte]: 400, [Op.lt]: 500 },
      });
    }

    if (query.countryCode && query.countryCode.trim()) {
      where.countryCode = query.countryCode.trim().toUpperCase();
    }

    if (query.search && query.search.trim()) {
      const term = `%${query.search.trim()}%`;
      andConditions.push({
        [Op.or]: [
          { ipAddress: { [Op.iLike]: term } },
          { path: { [Op.iLike]: term } },
          { usernameAttempted: { [Op.iLike]: term } },
          { details: { [Op.iLike]: term } },
          { countryName: { [Op.iLike]: term } },
          { ispOrg: { [Op.iLike]: term } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where[Op.and] = andConditions;
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      { rows, count },
      uniquePublicIps24h,
      uniqueCountries24h,
      failedLogins24h,
      frontendVisits24h,
      apiRejected24h,
      errors4xx24h,
      errors5xx24h,
      dbStats,
    ] = await Promise.all([
      this.accessLogModel.findAndCountAll({
        where,
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: pageSize,
        offset,
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          isPrivateIp: false,
        },
        distinct: true,
        col: 'ipAddress',
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          isPrivateIp: false,
          countryCode: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: 'LOCAL' }] },
        },
        distinct: true,
        col: 'countryCode',
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          eventType: 'LOGIN_FAILED',
        },
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          eventType: 'FRONTEND_VISIT',
        },
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          [Op.or]: [
            { statusCode: { [Op.in]: [401, 403] } },
            {
              eventType: {
                [Op.in]: [
                  'API_REJECTED',
                  'LOGIN_BLOCKED_ACTIVE_SESSION',
                  'SESSION_REVOKED',
                ],
              },
            },
          ],
        },
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          statusCode: { [Op.gte]: 400, [Op.lt]: 500 },
        },
      }),
      this.accessLogModel.count({
        where: {
          createdAt: { [Op.gte]: since24h },
          [Op.or]: [{ statusCode: { [Op.gte]: 500 } }, { statusCode: 0 }],
        },
      }),
      this.getActiveDbConnectionStats(),
    ]);

    return {
      data: rows.map((row: any) => ({
        id: Number(row.id),
        source: row.source,
        eventType: row.eventType,
        ipAddress: row.ipAddress,
        isPrivateIp: Boolean(row.isPrivateIp),
        countryCode: row.countryCode ?? null,
        countryName: row.countryName ?? null,
        region: row.region ?? null,
        city: row.city ?? null,
        ispOrg: row.ispOrg ?? null,
        userAgent: row.userAgent ?? null,
        method: row.method ?? null,
        path: row.path ?? null,
        statusCode:
          row.statusCode !== undefined && row.statusCode !== null
            ? Number(row.statusCode)
            : null,
        usernameAttempted: row.usernameAttempted ?? null,
        details: row.details ?? null,
        createdAt: new Date(row.createdAt || Date.now()).toISOString(),
      })),
      total: Number(count || 0),
      summary: {
        uniquePublicIps24h: Number(uniquePublicIps24h || 0),
        uniqueCountries24h: Number(uniqueCountries24h || 0),
        failedLogins24h: Number(failedLogins24h || 0),
        frontendVisits24h: Number(frontendVisits24h || 0),
        apiRejected24h: Number(apiRejected24h || 0),
        errors4xx24h: Number(errors4xx24h || 0),
        errors5xx24h: Number(errors5xx24h || 0),
        activeDbConnections: dbStats.activeDbConnections,
        publicDbConnections: dbStats.publicDbConnections,
      },
    };
  }

  async getIpSummary(query: QueryBridgeSummaryDto) {
    const db = this.sequelize || this.accessLogModel?.sequelize;
    const onlyPublic = query.onlyPublic === 'true';

    if (db) {
      try {
        const whereSql = onlyPublic ? 'WHERE is_private_ip = false' : '';
        const rows = (await db.query(
          `SELECT
            ip_address AS "ipAddress",
            BOOL_OR(is_private_ip) AS "isPrivateIp",
            MAX(country_code) AS "countryCode",
            MAX(country_name) AS "countryName",
            MAX(region) AS "region",
            MAX(city) AS "city",
            MAX(isp_org) AS "ispOrg",
            COUNT(*)::int AS "totalEvents",
            COUNT(*) FILTER (WHERE event_type IN ('LOGIN_SUCCESS', 'SESSION_FORCED_TAKEOVER'))::int AS "loginSuccessCount",
            COUNT(*) FILTER (WHERE event_type = 'LOGIN_FAILED')::int AS "loginFailedCount",
            COUNT(*) FILTER (WHERE status_code IN (401, 403) OR event_type IN ('API_REJECTED', 'LOGIN_BLOCKED_ACTIVE_SESSION', 'SESSION_REVOKED'))::int AS "apiRejectedCount",
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::int AS "clientErrorCount",
            COUNT(*) FILTER (WHERE status_code >= 500 OR status_code = 0)::int AS "serverErrorCount",
            COUNT(*) FILTER (WHERE event_type = 'FRONTEND_VISIT')::int AS "frontendVisitCount",
            MAX(created_at) AS "lastSeenAt",
            NULLIF(STRING_AGG(DISTINCT username_attempted, ', '), '') AS "usernamesAttempted",
            (ARRAY_AGG(user_agent ORDER BY created_at DESC NULLS LAST) FILTER (WHERE user_agent IS NOT NULL))[1] AS "lastUserAgent"
          FROM security_access_logs
          ${whereSql}
          GROUP BY ip_address
          ORDER BY MAX(created_at) DESC
          LIMIT 500`,
          { type: QueryTypes.SELECT },
        )) as Array<any>;

        return {
          data: rows.map((row) => ({
            ipAddress: row.ipAddress,
            isPrivateIp: Boolean(row.isPrivateIp),
            countryCode: row.countryCode ?? null,
            countryName: row.countryName ?? null,
            region: row.region ?? null,
            city: row.city ?? null,
            ispOrg: row.ispOrg ?? null,
            totalEvents: Number(row.totalEvents || 0),
            loginSuccessCount: Number(row.loginSuccessCount || 0),
            loginFailedCount: Number(row.loginFailedCount || 0),
            apiRejectedCount: Number(row.apiRejectedCount || 0),
            clientErrorCount: Number(row.clientErrorCount || 0),
            serverErrorCount: Number(row.serverErrorCount || 0),
            frontendVisitCount: Number(row.frontendVisitCount || 0),
            lastSeenAt: new Date(row.lastSeenAt || Date.now()).toISOString(),
            usernamesAttempted: row.usernamesAttempted ?? null,
            lastUserAgent: row.lastUserAgent ?? null,
          })),
        };
      } catch (err: any) {
        this.logger.warn(`Error en SQL ip-summary, usando fallback: ${err?.message}`);
      }
    }

    const where: any = onlyPublic ? { isPrivateIp: false } : {};
    const rows = await this.accessLogModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 2000,
      raw: true,
    });
    return { data: this.aggregateIpRowsInMemory(rows as any[]) };
  }

  async getCountrySummary(query: QueryBridgeSummaryDto) {
    const db = this.sequelize || this.accessLogModel?.sequelize;
    const onlyPublic = query.onlyPublic === 'true';

    if (db) {
      try {
        const whereSql = onlyPublic ? 'WHERE is_private_ip = false' : '';
        const rows = (await db.query(
          `SELECT
            COALESCE(country_code, CASE WHEN is_private_ip THEN 'LOCAL' ELSE 'UNKNOWN' END) AS "countryCode",
            MAX(country_name) AS "countryName",
            BOOL_AND(is_private_ip) AS "isPrivateIp",
            COUNT(DISTINCT ip_address)::int AS "uniqueIps",
            COUNT(*)::int AS "totalEvents",
            COUNT(*) FILTER (WHERE event_type IN ('LOGIN_SUCCESS', 'SESSION_FORCED_TAKEOVER'))::int AS "loginSuccessCount",
            COUNT(*) FILTER (WHERE event_type = 'LOGIN_FAILED')::int AS "loginFailedCount",
            COUNT(*) FILTER (WHERE status_code IN (401, 403) OR event_type IN ('API_REJECTED', 'LOGIN_BLOCKED_ACTIVE_SESSION', 'SESSION_REVOKED'))::int AS "apiRejectedCount",
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::int AS "clientErrorCount",
            COUNT(*) FILTER (WHERE status_code >= 500 OR status_code = 0)::int AS "serverErrorCount",
            COUNT(*) FILTER (WHERE event_type = 'FRONTEND_VISIT')::int AS "frontendVisitCount",
            MAX(created_at) AS "lastSeenAt",
            NULLIF(ARRAY_TO_STRING((ARRAY_AGG(DISTINCT ip_address))[1:5], ', '), '') AS "sampleIps"
          FROM security_access_logs
          ${whereSql}
          GROUP BY COALESCE(country_code, CASE WHEN is_private_ip THEN 'LOCAL' ELSE 'UNKNOWN' END)
          ORDER BY COUNT(*) DESC, MAX(created_at) DESC
          LIMIT 250`,
          { type: QueryTypes.SELECT },
        )) as Array<any>;

        return {
          data: rows.map((row) => ({
            countryCode: row.countryCode === 'UNKNOWN' ? null : row.countryCode ?? null,
            countryName: row.countryName ?? null,
            isPrivateIp: Boolean(row.isPrivateIp),
            uniqueIps: Number(row.uniqueIps || 0),
            totalEvents: Number(row.totalEvents || 0),
            loginSuccessCount: Number(row.loginSuccessCount || 0),
            loginFailedCount: Number(row.loginFailedCount || 0),
            apiRejectedCount: Number(row.apiRejectedCount || 0),
            clientErrorCount: Number(row.clientErrorCount || 0),
            serverErrorCount: Number(row.serverErrorCount || 0),
            frontendVisitCount: Number(row.frontendVisitCount || 0),
            lastSeenAt: new Date(row.lastSeenAt || Date.now()).toISOString(),
            sampleIps: row.sampleIps ?? null,
          })),
        };
      } catch (err: any) {
        this.logger.warn(`Error en SQL country-summary, usando fallback: ${err?.message}`);
      }
    }

    const where: any = onlyPublic ? { isPrivateIp: false } : {};
    const rows = await this.accessLogModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 2000,
      raw: true,
    });
    return { data: this.aggregateCountryRowsInMemory(rows as any[]) };
  }

  private aggregateIpRowsInMemory(rows: any[]) {
    const map = new Map<string, any>();
    for (const r of rows) {
      const ip = r.ipAddress;
      let acc = map.get(ip);
      if (!acc) {
        acc = {
          ipAddress: ip,
          isPrivateIp: Boolean(r.isPrivateIp),
          countryCode: r.countryCode ?? null,
          countryName: r.countryName ?? null,
          region: r.region ?? null,
          city: r.city ?? null,
          ispOrg: r.ispOrg ?? null,
          totalEvents: 0,
          loginSuccessCount: 0,
          loginFailedCount: 0,
          apiRejectedCount: 0,
          clientErrorCount: 0,
          serverErrorCount: 0,
          frontendVisitCount: 0,
          lastSeenAt: new Date(r.createdAt || Date.now()).toISOString(),
          _usernames: new Set<string>(),
          lastUserAgent: r.userAgent ?? null,
        };
        map.set(ip, acc);
      }
      acc.totalEvents += 1;
      const status = Number(r.statusCode ?? -1);
      if (r.eventType === 'LOGIN_SUCCESS' || r.eventType === 'SESSION_FORCED_TAKEOVER') {
        acc.loginSuccessCount += 1;
      }
      if (r.eventType === 'LOGIN_FAILED') acc.loginFailedCount += 1;
      if (
        status === 401 ||
        status === 403 ||
        ['API_REJECTED', 'LOGIN_BLOCKED_ACTIVE_SESSION', 'SESSION_REVOKED'].includes(r.eventType)
      ) {
        acc.apiRejectedCount += 1;
      }
      if (status >= 400 && status < 500) acc.clientErrorCount += 1;
      if (status >= 500 || status === 0) acc.serverErrorCount += 1;
      if (r.eventType === 'FRONTEND_VISIT') acc.frontendVisitCount += 1;
      if (r.usernameAttempted) acc._usernames.add(r.usernameAttempted);
    }

    return Array.from(map.values()).map(({ _usernames, ...rest }) => ({
      ...rest,
      usernamesAttempted:
        _usernames.size > 0 ? Array.from(_usernames).join(', ') : null,
    }));
  }

  private aggregateCountryRowsInMemory(rows: any[]) {
    const map = new Map<string, any>();
    for (const r of rows) {
      const code = r.countryCode || (r.isPrivateIp ? 'LOCAL' : 'UNKNOWN');
      let acc = map.get(code);
      if (!acc) {
        acc = {
          countryCode: code === 'UNKNOWN' ? null : code,
          countryName: r.countryName ?? null,
          isPrivateIp: Boolean(r.isPrivateIp),
          _ips: new Set<string>(),
          totalEvents: 0,
          loginSuccessCount: 0,
          loginFailedCount: 0,
          apiRejectedCount: 0,
          clientErrorCount: 0,
          serverErrorCount: 0,
          frontendVisitCount: 0,
          lastSeenAt: new Date(r.createdAt || Date.now()).toISOString(),
        };
        map.set(code, acc);
      }
      if (r.ipAddress) acc._ips.add(r.ipAddress);
      acc.totalEvents += 1;
      const status = Number(r.statusCode ?? -1);
      if (r.eventType === 'LOGIN_SUCCESS' || r.eventType === 'SESSION_FORCED_TAKEOVER') {
        acc.loginSuccessCount += 1;
      }
      if (r.eventType === 'LOGIN_FAILED') acc.loginFailedCount += 1;
      if (
        status === 401 ||
        status === 403 ||
        ['API_REJECTED', 'LOGIN_BLOCKED_ACTIVE_SESSION', 'SESSION_REVOKED'].includes(r.eventType)
      ) {
        acc.apiRejectedCount += 1;
      }
      if (status >= 400 && status < 500) acc.clientErrorCount += 1;
      if (status >= 500 || status === 0) acc.serverErrorCount += 1;
      if (r.eventType === 'FRONTEND_VISIT') acc.frontendVisitCount += 1;
    }

    return Array.from(map.values()).map(({ _ips, ...rest }) => ({
      ...rest,
      uniqueIps: _ips.size,
      sampleIps: _ips.size > 0 ? Array.from(_ips).slice(0, 5).join(', ') : null,
    }));
  }

  async purgeExpired(retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    return this.accessLogModel.destroy({
      where: { createdAt: { [Op.lt]: cutoff } },
    });
  }
}
