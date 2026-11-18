import * as crypto from 'crypto';
import { FtpDevice, FtpProtocol } from '../ftp-device.model';
import { FtpServerPublicInfo } from '../services/sftpgo-client.service';

export function parseAllowedIpsInput(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value)
    ? value
    : String(value)
        .split(/[\s,;]+/)
        .filter(Boolean);

  return Array.from(
    new Set(list.map((ip) => String(ip).trim()).filter(Boolean)),
  );
}

export function serializeAllowedIpsForDb(ips?: string[] | null): string | null {
  if (!Array.isArray(ips) || ips.length === 0) return null;
  const clean = ips.map((ip) => String(ip).trim()).filter(Boolean);
  return clean.length > 0 ? clean.join(',') : null;
}

export function deserializeAllowedIpsFromDb(raw?: string | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

/**
 * Genera una contraseña aleatoria criptográficamente segura compatible con teclados/EWS de HP.
 */
export function generateStrongFtpPassword(length = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_#@';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet[bytes[i] % alphabet.length];
  }
  return result;
}

/**
 * Construye un usuario virtual único y válido para SFTP/FTPS/FTP aislado por compañía.
 */
export function buildFtpUsername(companyId: number, subFolder: string): string {
  const cleanSub = subFolder
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 16);
  const rand = crypto.randomBytes(2).toString('hex');
  return `hc_c${companyId}_${cleanSub || 'hp'}_${rand}`;
}

export function resolvePortForProtocol(
  protocol: FtpProtocol,
  serverMeta?: Pick<FtpServerPublicInfo, 'sftpPort' | 'ftpsPort' | 'ftpPort'>,
): number {
  if (!serverMeta) {
    return protocol === FtpProtocol.SFTP ? 2222 : 21;
  }
  if (protocol === FtpProtocol.SFTP) return serverMeta.sftpPort;
  if (protocol === FtpProtocol.FTPS) return serverMeta.ftpsPort;
  return serverMeta.ftpPort;
}

export function toSafeFtpDeviceDto(
  device: FtpDevice,
  serverMeta?: Pick<
    FtpServerPublicInfo,
    'host' | 'sftpPort' | 'ftpsPort' | 'ftpPort'
  >,
) {
  const raw = device.get({ plain: true }) as Record<string, any>;
  delete raw.passwordEncrypted;

  const allowedIpsList = deserializeAllowedIpsFromDb(device.allowedIps);
  const protocol = (device.protocol || FtpProtocol.SFTP) as FtpProtocol;

  return {
    ...raw,
    allowedIps: allowedIpsList,
    allowedIpsRaw: device.allowedIps,
    inboxRelativePath: `tenancy/company_${device.companyId}/inbox/${device.subFolder}`,
    ftpVirtualPath: '/',
    connectionHost: serverMeta?.host || 'ftp.helpcopies.com',
    connectionPort: resolvePortForProtocol(protocol, serverMeta),
    hasPassword: Boolean(device.passwordEncrypted),
  };
}

