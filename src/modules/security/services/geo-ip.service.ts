import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as geoip from 'geoip-lite';
import { SecurityIpIntelligence } from '../models/security-ip-intelligence.model';
import {
  isPrivateOrLocalIp,
  normalizeIpAddress,
} from '../helpers/security-request.helper';

export interface ResolvedGeoIpInfo {
  ipAddress: string;
  countryCode: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  organization: string | null;
  asn: string | null;
  lookupProvider: string;
}

const CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 días

@Injectable()
export class GeoIpService {
  private readonly logger = new Logger(GeoIpService.name);
  private readonly inFlightLookups = new Map<string, Promise<ResolvedGeoIpInfo>>();
  private readonly countryDisplayNames: Intl.DisplayNames | null = (() => {
    try {
      return new Intl.DisplayNames(['es'], { type: 'region' });
    } catch {
      return null;
    }
  })();

  constructor(
    @InjectModel(SecurityIpIntelligence)
    private readonly ipModel: typeof SecurityIpIntelligence,
  ) {}

  private resolveCountryName(countryCode?: string | null): string | null {
    const clean = String(countryCode || '').trim().toUpperCase();
    if (!clean || clean === 'LOCAL') return null;
    try {
      return this.countryDisplayNames?.of(clean) || clean;
    } catch {
      return clean;
    }
  }

  private parseOrgField(rawOrg?: string | null): {
    asn: string | null;
    organization: string | null;
    isp: string | null;
  } {
    const clean = String(rawOrg || '').trim();
    if (!clean) return { asn: null, organization: null, isp: null };

    const asnMatch = clean.match(/^(AS\d+)\s+(.+)$/i);
    if (asnMatch) {
      const asn = asnMatch[1].toUpperCase();
      const org = asnMatch[2].trim();
      return { asn, organization: org, isp: org };
    }
    return { asn: null, organization: clean, isp: clean };
  }

  private lookupOfflineGeoipLite(ip: string): ResolvedGeoIpInfo {
    const hit = geoip.lookup(ip);
    const countryCode = hit?.country ? String(hit.country).toUpperCase() : null;
    return {
      ipAddress: ip,
      countryCode,
      countryName: this.resolveCountryName(countryCode),
      region: hit?.region ? String(hit.region) : null,
      city: hit?.city ? String(hit.city) : null,
      isp: hit ? 'Proveedor no identificado (GeoIP Offline)' : null,
      organization: null,
      asn: null,
      lookupProvider: 'geoip-lite',
    };
  }

  private async lookupIpInfoApi(ip: string): Promise<ResolvedGeoIpInfo | null> {
    const token = process.env.IPINFO_TOKEN?.trim();
    const url = token
      ? `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`
      : `https://ipinfo.io/${encodeURIComponent(ip)}/json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const data: any = await response.json();
      if (!data || data.bogon || data.error) {
        return null;
      }

      const countryCode = data.country ? String(data.country).toUpperCase() : null;
      const parsedOrg = this.parseOrgField(data.org);

      return {
        ipAddress: ip,
        countryCode,
        countryName: this.resolveCountryName(countryCode),
        region: data.region ? String(data.region).slice(0, 100) : null,
        city: data.city ? String(data.city).slice(0, 100) : null,
        isp: parsedOrg.isp ? parsedOrg.isp.slice(0, 200) : null,
        organization: parsedOrg.organization ? parsedOrg.organization.slice(0, 200) : null,
        asn: parsedOrg.asn ? parsedOrg.asn.slice(0, 60) : null,
        lookupProvider: 'ipinfo',
      };
    } catch (err: any) {
      this.logger.debug(`IPinfo lookup fallback for ${ip}: ${err?.message || 'error'}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resuelve país, ciudad y dueño/ISP de una IP usando ipinfo.io y fallback offline geoip-lite.
   */
  async resolveExternalOrOffline(rawIp: string): Promise<ResolvedGeoIpInfo> {
    const ip = normalizeIpAddress(rawIp);

    if (isPrivateOrLocalIp(ip)) {
      return {
        ipAddress: ip,
        countryCode: 'LOCAL',
        countryName: 'Red Local / Servidor',
        region: null,
        city: 'Localhost',
        isp: 'Red Interna / Privada',
        organization: 'Red Privada',
        asn: null,
        lookupProvider: 'local',
      };
    }

    const fromApi = await this.lookupIpInfoApi(ip);
    if (fromApi) {
      return fromApi;
    }

    return this.lookupOfflineGeoipLite(ip);
  }

  /**
   * Obtiene información de IP desde caché en PostgreSQL o la enriquece sin duplicar consultas concurrentes.
   */
  async getOrLookupIp(
    rawIp: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<ResolvedGeoIpInfo> {
    const ip = normalizeIpAddress(rawIp);

    if (!options.forceRefresh) {
      const cached = await this.ipModel.findOne({ where: { ipAddress: ip } });
      const cacheValid =
        cached &&
        cached.lookupProvider &&
        cached.lookupExpiresAt &&
        new Date(cached.lookupExpiresAt).getTime() > Date.now() &&
        (cached.lookupProvider === 'ipinfo' || cached.lookupProvider === 'local');

      if (cacheValid && cached) {
        return {
          ipAddress: ip,
          countryCode: cached.countryCode,
          countryName: cached.countryName,
          region: cached.region,
          city: cached.city,
          isp: cached.isp,
          organization: cached.organization,
          asn: cached.asn,
          lookupProvider: cached.lookupProvider || 'cache',
        };
      }
    }

    const existingPromise = this.inFlightLookups.get(ip);
    if (existingPromise && !options.forceRefresh) {
      return existingPromise;
    }

    const lookupPromise = (async () => {
      const resolved = await this.resolveExternalOrOffline(ip);
      const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

      try {
        const [record, created] = await this.ipModel.findOrCreate({
          where: { ipAddress: ip },
          defaults: {
            ipAddress: ip,
            countryCode: resolved.countryCode,
            countryName: resolved.countryName,
            region: resolved.region,
            city: resolved.city,
            isp: resolved.isp,
            organization: resolved.organization,
            asn: resolved.asn,
            lookupProvider: resolved.lookupProvider,
            lookupExpiresAt: expiresAt,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          } as never,
        });

        if (!created) {
          await record.update({
            countryCode: resolved.countryCode ?? record.countryCode,
            countryName: resolved.countryName ?? record.countryName,
            region: resolved.region ?? record.region,
            city: resolved.city ?? record.city,
            isp: resolved.isp ?? record.isp,
            organization: resolved.organization ?? record.organization,
            asn: resolved.asn ?? record.asn,
            lookupProvider: resolved.lookupProvider,
            lookupExpiresAt: expiresAt,
          });
        }
      } catch (err: any) {
        this.logger.warn(`No se pudo persistir caché GeoIP para ${ip}: ${err?.message}`);
      }

      return resolved;
    })().finally(() => {
      this.inFlightLookups.delete(ip);
    });

    this.inFlightLookups.set(ip, lookupPromise);
    return lookupPromise;
  }
}
