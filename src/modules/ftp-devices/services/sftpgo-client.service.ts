import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readEnv } from '../../../config/env-resolver';
import { ensureTenantFtpInboxDir } from '../../../common/utils/storage-path.util';
import { FtpDevice, FtpDeviceStatus, FtpProtocol } from '../ftp-device.model';

export interface SftpGoSyncResult {
  synced: boolean;
  error: string | null;
}

export interface FtpServerPublicInfo {
  host: string;
  sftpPort: number;
  ftpsPort: number;
  ftpPort: number;
  passivePorts: string;
  sftpgoConfigured: boolean;
  sftpgoReachable: boolean;
  error?: string | null;
}

/**
 * Cliente HTTP desacoplado para la API REST v2 de SFTPGo (`http://sftpgo:8080/api/v2`).
 * Permite crear, suspender, rotar y eliminar usuarios virtuales chrooteados por compañía/impresora
 * sin crear usuarios reales en el sistema operativo Linux.
 */
@Injectable()
export class SftpGoClientService implements OnModuleInit {
  private readonly logger = new Logger(SftpGoClientService.name);
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  async onModuleInit() {
    const cfg = this.getConfig();
    if (cfg.adminUrl) {
      try {
        const info = await this.getServerInfoWithHealth();
        if (info.sftpgoReachable) {
          this.logger.log(
            `🚀 [SFTPGo Client] Conexión exitosa con la API de SFTPGo en ${cfg.adminUrl} (Servidor FTP: ONLINE)`,
          );
        } else {
          this.logger.error(
            `❌ [SFTPGo Client] Falló la verificación de SFTPGo en ${cfg.adminUrl}: ${info.error || 'Credenciales o conexión inválida'}`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `❌ [SFTPGo Client] Error crítico de conexión contra SFTPGo en ${cfg.adminUrl}: ${err?.message}`,
        );
      }
    } else {
      this.logger.log(
        '[SFTPGo Client] SFTPGO_ADMIN_URL no configurada. Operando en modo carpeta local.',
      );
    }
  }

  private getConfig() {
    return {
      adminUrl: (readEnv('SFTPGO_ADMIN_URL') || '').replace(/\/+$/, ''),
      adminUser: readEnv('SFTPGO_ADMIN_USER') || 'admin',
      adminPassword: readEnv('SFTPGO_ADMIN_PASSWORD') || '',
      storageRootInContainer: (
        readEnv('SFTPGO_STORAGE_ROOT') || '/srv/helpscan/uploads'
      ).replace(/\/+$/, ''),
      publicHost:
        readEnv('FTP_PUBLIC_HOST') ||
        readEnv('COOLIFY_FQDN') ||
        'ftp.helpcopies.com',
      sftpPort: Number(readEnv('FTP_SFTP_PORT') || 2222),
      ftpsPort: Number(readEnv('FTP_FTPS_PORT') || 21),
      ftpPort: Number(readEnv('FTP_PLAIN_PORT') || 21),
      passivePorts: readEnv('FTP_PASSIVE_PORTS') || '21000-21005',
    };
  }

  getPublicServerMetadata(): Omit<FtpServerPublicInfo, 'sftpgoReachable'> {
    const cfg = this.getConfig();
    return {
      host: cfg.publicHost,
      sftpPort: cfg.sftpPort,
      ftpsPort: cfg.ftpsPort,
      ftpPort: cfg.ftpPort,
      passivePorts: cfg.passivePorts,
      sftpgoConfigured: Boolean(cfg.adminUrl && cfg.adminPassword),
    };
  }

  async getServerInfoWithHealth(): Promise<FtpServerPublicInfo> {
    const baseMeta = this.getPublicServerMetadata();
    if (!baseMeta.sftpgoConfigured) {
      return {
        ...baseMeta,
        sftpgoReachable: false,
        error:
          'SFTPGO_ADMIN_URL o SFTPGO_ADMIN_PASSWORD no configurados en las variables de entorno.',
      };
    }

    try {
      await this.getAccessToken();
      return { ...baseMeta, sftpgoReachable: true, error: null };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.logger.warn(`[SFTPGo Client] Error de verificación de salud: ${errMsg}`);
      return { ...baseMeta, sftpgoReachable: false, error: errMsg };
    }
  }

  buildContainerHomeDir(companyId: number, subFolder: string): string {
    const { storageRootInContainer } = this.getConfig();
    try {
      const { relativeToStorage } = ensureTenantFtpInboxDir(companyId, subFolder);
      return `${storageRootInContainer}/${relativeToStorage}`;
    } catch {
      return `${storageRootInContainer}/tenancy/company_${companyId}/inbox/${subFolder}`;
    }
  }

  normalizeAllowedIps(ips?: string | string[] | null): string[] {
    if (!ips) return [];
    const list = Array.isArray(ips) ? ips : String(ips).split(',');
    const normalized: string[] = [];

    for (const raw of list) {
      const cleaned = String(raw || '').trim();
      if (!cleaned) continue;
      if (cleaned.includes('/')) {
        normalized.push(cleaned);
      } else if (cleaned.includes(':')) {
        normalized.push(`${cleaned}/128`);
      } else {
        normalized.push(`${cleaned}/32`);
      }
    }

    return normalized;
  }

  private resolveDeniedProtocols(protocol: FtpProtocol): string[] {
    if (protocol === FtpProtocol.SFTP) {
      return ['FTP', 'DAV'];
    }
    return ['SSH', 'DAV'];
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    const { adminUrl, adminUser, adminPassword } = this.getConfig();
    if (!adminUrl || !adminPassword) {
      throw new Error(
        'SFTPGO_ADMIN_URL o SFTPGO_ADMIN_PASSWORD no configurados en el entorno.',
      );
    }

    if (!forceRefresh && this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const basicAuth = Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');
    const response = await fetch(`${adminUrl}/api/v2/token`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) {
      throw new Error(`Error autenticando contra SFTPGo (${response.status})`);
    }

    const body = (await response.json()) as {
      access_token: string;
      expires_at?: string;
    };

    if (!body?.access_token) {
      throw new Error('Respuesta inválida de token SFTPGo.');
    }

    this.cachedToken = body.access_token;
    const expiresMs = body.expires_at
      ? Math.max(Date.now() + 60_000, new Date(body.expires_at).getTime() - 30_000)
      : Date.now() + 5 * 60_000;
    this.tokenExpiresAt = expiresMs;

    return this.cachedToken;
  }

  async syncVirtualUser(
    device: FtpDevice,
    plainPassword?: string,
  ): Promise<SftpGoSyncResult> {
    const { adminUrl, adminPassword } = this.getConfig();
    if (!adminUrl || !adminPassword) {
      return {
        synced: false,
        error:
          'SFTPGo no está configurado en variables de entorno (modo almacenamiento local activo).',
      };
    }

    try {
      const token = await this.getAccessToken();
      const homeDir = this.buildContainerHomeDir(device.companyId, device.subFolder);

      const userPayload: Record<string, any> = {
        username: device.username,
        status: device.status === FtpDeviceStatus.ACTIVE ? 1 : 0,
        home_dir: homeDir,
        permissions: {
          '/': ['upload', 'list', 'create_dirs', 'stat'],
        },
        filters: {
          allowed_ip: this.normalizeAllowedIps(device.allowedIps),
          denied_login_methods: ['publickey', 'keyboard-interactive'],
          denied_protocols: this.resolveDeniedProtocols(device.protocol),
        },
        filesystem: {
          provider: 0,
        },
        max_sessions: 4,
        quota_size: 0,
        quota_files: 0,
        description: `Help Scan | Company #${device.companyId} | ${device.deviceName}`,
      };

      if (plainPassword) {
        userPayload.password = plainPassword;
      }

      let response = await fetch(
        `${adminUrl}/api/v2/users/${encodeURIComponent(device.username)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(userPayload),
          signal: AbortSignal.timeout(5000),
        },
      );

      if (response.status === 404) {
        if (!plainPassword) {
          return {
            synced: false,
            error:
              'El usuario aún no existía en SFTPGo y no se proporcionó contraseña para aprovisionarlo.',
          };
        }

        response = await fetch(`${adminUrl}/api/v2/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(userPayload),
          signal: AbortSignal.timeout(5000),
        });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const msg = `SFTPGo rechazó la sincronización (${response.status}): ${text.slice(0, 180)}`;
        this.logger.warn(msg);
        return { synced: false, error: msg };
      }

      return { synced: true, error: null };
    } catch (err: any) {
      const msg = err?.message || 'No se pudo conectar al servidor SFTPGo';
      this.logger.warn(
        `Sync SFTPGo omitida para '${device.username}' (company_${device.companyId}): ${msg}`,
      );
      return { synced: false, error: msg };
    }
  }

  async deleteVirtualUser(username: string): Promise<void> {
    const { adminUrl, adminPassword } = this.getConfig();
    if (!adminUrl || !adminPassword) return;

    try {
      const token = await this.getAccessToken();
      const response = await fetch(
        `${adminUrl}/api/v2/users/${encodeURIComponent(username)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(4000),
        },
      );

      if (!response.ok && response.status !== 404) {
        this.logger.warn(
          `No se pudo eliminar usuario virtual '${username}' en SFTPGo (${response.status}).`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Error eliminando usuario SFTPGo '${username}': ${err?.message}`,
      );
    }
  }
}
