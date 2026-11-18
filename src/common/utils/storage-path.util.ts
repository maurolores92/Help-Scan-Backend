import { BadRequestException } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { basename, isAbsolute, join, resolve, sep } from 'path';

/**
 * Asegura la existencia de un directorio con permisos 0777 para que múltiples
 * contenedores (Backend como root/node, SFTPGo como sftpgo, OCR como python)
 * puedan escribir y leer sin colisiones de "permission denied".
 */
export function safeEnsureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o777 });
  }
  try {
    chmodSync(dirPath, 0o777);
  } catch {}
}

export interface TenantStorageDirectories {
  baseDir: string;
  inboxDir: string;
  vaultDir: string;
  quarantineDir: string;
  imagesDir: string;
}

/**
 * Obtiene la raíz del proyecto backend de forma canónica y determinista,
 * evitando que varíe según la carpeta desde donde se ejecutó el comando o proceso (process.cwd()).
 */
export function getBackendRootPath(): string {
  // En desarrollo (src/common/utils) o producción (dist/common/utils),
  // subiendo 3 niveles siempre se llega a la raíz de HC-SCAN-Backend.
  return resolve(__dirname, '..', '..', '..');
}

/**
 * Obtiene la ruta raíz del almacenamiento de archivos de la plataforma.
 * Configurable mediante `STORAGE_ROOT_PATH` o `STORAGE_ROOT` o `UPLOADS_DIR`;
 * por defecto centraliza todo en `HC-SCAN-Backend/uploads`.
 */
export function getStorageRootPath(): string {
  const envPath =
    process.env.STORAGE_ROOT_PATH?.trim() ||
    process.env.STORAGE_ROOT?.trim() ||
    process.env.UPLOADS_DIR?.trim();
  const backendRoot = getBackendRootPath();

  const storagePath = envPath
    ? isAbsolute(envPath)
      ? resolve(envPath)
      : resolve(backendRoot, envPath)
    : resolve(backendRoot, 'uploads');

  safeEnsureDir(storagePath);

  return storagePath;
}

/**
 * Valida estrictamente el identificador numérico de la compañía para impedir Path Traversal.
 */
export function sanitizeTenantId(companyId: number | string): number {
  const parsed = Number(companyId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException(`Identificador de compañía inválido para storage: ${companyId}`);
  }
  return parsed;
}

/**
 * Aprovisiona de forma idempotente la estructura aislada de una compañía dentro de uploads:
 * `uploads/tenancy/company_<id>_<nombre>/{inbox,vault,quarantine,images}`
 */
export function ensureTenantDirectories(
  companyId: number | string,
  companySlugOrName?: string,
): TenantStorageDirectories {
  const safeId = sanitizeTenantId(companyId);
  const tenancyRoot = join(getStorageRootPath(), 'tenancy');
  safeEnsureDir(tenancyRoot);

  let folderName = `company_${safeId}`;
  if (companySlugOrName && companySlugOrName.trim()) {
    const cleanSlug = companySlugOrName
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (cleanSlug) {
      folderName = `company_${safeId}_${cleanSlug}`;
      const legacyFolder = join(tenancyRoot, `company_${safeId}`);
      const newFolder = join(tenancyRoot, folderName);
      if (existsSync(legacyFolder) && !existsSync(newFolder)) {
        try {
          renameSync(legacyFolder, newFolder);
        } catch {
          folderName = `company_${safeId}`;
        }
      }
    }
  } else {
    // Si no se pasó slug, verificar si ya existe una carpeta como company_<id>_* en disco
    try {
      const existing = readdirSync(tenancyRoot, { withFileTypes: true });
      const match = existing.find(
        (d) =>
          d.isDirectory() &&
          (d.name === `company_${safeId}` || d.name.startsWith(`company_${safeId}_`)),
      );
      if (match) {
        folderName = match.name;
      }
    } catch {}
  }

  const baseDir = join(tenancyRoot, folderName);
  const inboxDir = join(baseDir, 'inbox');
  const vaultDir = join(baseDir, 'vault');
  const quarantineDir = join(baseDir, 'quarantine');
  const imagesDir = join(baseDir, 'images');

  for (const dir of [baseDir, inboxDir, vaultDir, quarantineDir, imagesDir]) {
    safeEnsureDir(dir);
  }

  return { baseDir, inboxDir, vaultDir, quarantineDir, imagesDir };
}

/**
 * Retorna la carpeta de imágenes (`uploads/tenancy/company_<id>/images`) para la compañía.
 */
export function getTenantImagesPath(companyId: number | string, subFolder?: string): string {
  const { imagesDir } = ensureTenantDirectories(companyId);
  if (!subFolder || !subFolder.trim()) {
    return imagesDir;
  }
  const cleanSub = subFolder.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = join(imagesDir, cleanSub);
  safeEnsureDir(targetDir);
  return targetDir;
}

/**
 * Retorna la carpeta raíz del tenant (`uploads/tenancy/company_<id>`).
 */
export function getTenantStoragePath(companyId: number | string): string {
  return ensureTenantDirectories(companyId).baseDir;
}

/**
 * Retorna la bandeja de entrada (`inbox`) vigilada en vivo para SFTP / carga local en carpeta.
 */
export function getTenantInboxPath(companyId: number | string): string {
  return ensureTenantDirectories(companyId).inboxDir;
}

/**
 * Normaliza y valida el nombre de subcarpeta de dispositivo FTP para evitar Path Traversal.
 */
export function sanitizeFtpSubFolder(subFolder: string): string {
  const cleaned = String(subFolder || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

  return cleaned || 'default_printer';
}

/**
 * Crea y retorna la carpeta `inbox/<subFolder>` aislada para un equipo HP específico.
 */
export function ensureTenantFtpInboxDir(
  companyId: number | string,
  subFolder?: string | null,
): { absoluteDir: string; relativeToStorage: string; cleanSubFolder: string } {
  const safeId = sanitizeTenantId(companyId);
  const { inboxDir, baseDir } = ensureTenantDirectories(safeId);
  const folderName = basename(baseDir);
  if (!subFolder || !subFolder.trim()) {
    return {
      absoluteDir: inboxDir,
      relativeToStorage: `tenancy/${folderName}/inbox`,
      cleanSubFolder: '',
    };
  }

  const cleanSubFolder = sanitizeFtpSubFolder(subFolder);
  const absoluteDir = join(inboxDir, cleanSubFolder);
  safeEnsureDir(absoluteDir);

  return {
    absoluteDir,
    relativeToStorage: `tenancy/${folderName}/inbox/${cleanSubFolder}`,
    cleanSubFolder,
  };
}

/**
 * Traduce rutas físicas reportadas por el contenedor SFTPGo al path real dentro del contenedor Backend.
 */
export function resolveInboxFileFromWebhook(
  companyId: number,
  reportedPath: string,
  fallbackSubFolder?: string | null,
): string {
  const root = getStorageRootPath();
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const normalized = (reportedPath || '').replace(/\\/g, '/');

  const tenancyIdx = normalized.indexOf('tenancy/');
  if (tenancyIdx >= 0) {
    const relFromTenancy = normalized.slice(tenancyIdx);
    const candidate = resolve(root, relFromTenancy);
    if (candidate.startsWith(rootPrefix)) {
      return candidate;
    }
  }

  // Fallback si SFTPGo reporta path relativo a la raíz del usuario chrooteado (ej. `/scan001.pdf`)
  const fileNameOnly = normalized.split('/').filter(Boolean).pop() || '';
  const { absoluteDir } = ensureTenantFtpInboxDir(companyId, fallbackSubFolder);
  const fallbackCandidate = resolve(absoluteDir, fileNameOnly);
  if (!fallbackCandidate.startsWith(rootPrefix)) {
    throw new BadRequestException('Ruta de webhook fuera de los límites permitidos');
  }
  return fallbackCandidate;
}

/**
 * Retorna la carpeta de cuarentena (`quarantine`) para archivos inválidos, duplicados o sin cupo.
 */
export function getTenantQuarantinePath(companyId: number | string): string {
  return ensureTenantDirectories(companyId).quarantineDir;
}

/**
 * Prepara la carpeta mensual dentro de la bóveda (`vault/YYYY/MM`) y retorna ruta absoluta y relativa.
 */
export function getTenantVaultMonthlyPath(
  companyId: number | string,
  refDate: Date = new Date(),
): { absoluteDir: string; relativeDir: string } {
  const safeId = sanitizeTenantId(companyId);
  const { vaultDir, baseDir } = ensureTenantDirectories(safeId);
  const folderName = basename(baseDir);
  const year = String(refDate.getUTCFullYear());
  const month = String(refDate.getUTCMonth() + 1).padStart(2, '0');
  const absoluteDir = join(vaultDir, year, month);

  if (!existsSync(absoluteDir)) {
    mkdirSync(absoluteDir, { recursive: true });
  }

  const relativeDir = `tenancy/${folderName}/vault/${year}/${month}`;
  return { absoluteDir, relativeDir };
}

/**
 * Resuelve de forma segura la ruta física de un documento verificando que jamás salga de `STORAGE_ROOT_PATH`.
 * Mantiene compatibilidad hacia atrás con registros previos (`tenancy/<id>/<fileName>`) y con nombres
 * de carpetas que incluyan o no el slug/nombre de la empresa.
 */
export function resolveSafeStorageFilePath(
  relativePath: string,
  fallbackCompanyId?: number,
  fallbackFileName?: string,
): string {
  const root = getStorageRootPath();
  const normalizedRel = (relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const primaryCandidate = resolve(root, normalizedRel);

  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!primaryCandidate.startsWith(rootPrefix)) {
    throw new BadRequestException('Ruta de almacenamiento fuera de los límites permitidos');
  }

  if (existsSync(primaryCandidate)) {
    return primaryCandidate;
  }

  // Compatibilidad dinámica: si la ruta guardada fue `tenancy/company_1/...` y en disco se llama `tenancy/company_1_helpcopies/...`
  const tenantDirMatch = normalizedRel.match(/^tenancy\/company_(\d+)(?:_[^/]+)?\/(.+)$/);
  if (tenantDirMatch) {
    const [, cId, restPath] = tenantDirMatch;
    try {
      const { baseDir } = ensureTenantDirectories(cId);
      const dynamicCandidate = resolve(baseDir, restPath);
      if (dynamicCandidate.startsWith(rootPrefix) && existsSync(dynamicCandidate)) {
        return dynamicCandidate;
      }
    } catch {}
  }

  // Fallback si el archivo existía previamente en 'backend/storage'
  const legacyStorageRoot = resolve(getBackendRootPath(), 'storage');
  const legacyStorageCandidate = resolve(legacyStorageRoot, normalizedRel);
  if (existsSync(legacyStorageCandidate)) {
    return legacyStorageCandidate;
  }

  // Fallback de compatibilidad para rutas antiguas `storage/tenancy/<id>/<fileName>`
  if (fallbackCompanyId && fallbackFileName) {
    const safeId = sanitizeTenantId(fallbackCompanyId);
    const legacyPath = resolve(root, 'tenancy', String(safeId), fallbackFileName);
    if (legacyPath.startsWith(rootPrefix) && existsSync(legacyPath)) {
      return legacyPath;
    }
    const legacyOldRootPath = resolve(legacyStorageRoot, 'tenancy', String(safeId), fallbackFileName);
    if (existsSync(legacyOldRootPath)) {
      return legacyOldRootPath;
    }
  }

  return primaryCandidate;
}
