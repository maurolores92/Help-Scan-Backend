import { Logger } from '@nestjs/common';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { Op, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  getBackendRootPath,
  getStorageRootPath,
  resolveSafeStorageFilePath,
  sanitizeTenantId,
} from '../../../common/utils/storage-path.util';

export interface PurgeCompanyRelationsResult {
  ftpUsernames: string[];
  documentPaths: string[];
  userImagePaths: string[];
}

/**
 * Elimina de forma ordenada y dentro de una transacción todos los registros
 * dependientes de una compañía antes de destruir la fila en `companies`,
 * evitando violaciones de claves foráneas (`ftp_devices`, canales, documentos,
 * clientes, usuarios, roles, auditoría, notificaciones y telemetría).
 */
export async function purgeCompanyRelationsInTransaction(
  sequelize: Sequelize,
  companyId: number,
  transaction: Transaction,
): Promise<PurgeCompanyRelationsResult> {
  const models = sequelize.models || {};

  const UsersModel = models['Users'];
  const RoleModel = models['Role'];
  const DocumentModel = models['Document'];
  const FtpDeviceModel = models['FtpDevice'];

  const [companyUsers, companyRoles, companyDocs, ftpDevices] = await Promise.all([
    UsersModel
      ? UsersModel.findAll({
          where: { companyId },
          attributes: ['id', 'image'],
          raw: true,
          transaction,
        })
      : Promise.resolve([]),
    RoleModel
      ? RoleModel.findAll({
          where: { companyId },
          attributes: ['id'],
          raw: true,
          transaction,
        })
      : Promise.resolve([]),
    DocumentModel
      ? DocumentModel.findAll({
          where: { companyId },
          attributes: ['id', 'filePath'],
          raw: true,
          transaction,
        })
      : Promise.resolve([]),
    FtpDeviceModel
      ? FtpDeviceModel.findAll({
          where: { companyId },
          attributes: ['id', 'username'],
          raw: true,
          transaction,
        })
      : Promise.resolve([]),
  ]);

  const userIds = (companyUsers as unknown as Array<{ id: number }>).map((u) => Number(u.id)).filter(Boolean);
  const userImagePaths = (companyUsers as unknown as Array<{ image?: string | null }>)
    .map((u) => u.image || '')
    .filter(Boolean);
  const roleIds = (companyRoles as unknown as Array<{ id: number }>).map((r) => Number(r.id)).filter(Boolean);
  const docIds = (companyDocs as unknown as Array<{ id: number }>).map((d) => Number(d.id)).filter(Boolean);
  const documentPaths = (companyDocs as unknown as Array<{ filePath?: string | null }>)
    .map((d) => d.filePath || '')
    .filter(Boolean);
  const ftpUsernames = (ftpDevices as Array<{ username?: string }>)
    .map((d) => d.username || '')
    .filter(Boolean);

  const destroyByCompany = async (modelName: string) => {
    const model = models[modelName];
    if (model) {
      await model.destroy({ where: { companyId }, transaction });
    }
  };

  // 1. Mensajes y canales externos
  await destroyByCompany('EmailMessage');
  await destroyByCompany('WhatsappMessage');
  await destroyByCompany('TelegramMessage');
  await destroyByCompany('CompanyEmailChannel');
  await destroyByCompany('CompanyWhatsappChannel');
  await destroyByCompany('CompanyTelegramChannel');

  // 2. Vínculos documentales, registros dinámicos, documentos, esquemas y clientes
  const DocumentLinkModel = models['DocumentLink'];
  if (DocumentLinkModel) {
    const linkOr: any[] = [{ companyId }];
    if (docIds.length > 0) {
      linkOr.push({ sourceDocumentId: { [Op.in]: docIds } });
      linkOr.push({ targetDocumentId: { [Op.in]: docIds } });
    }
    await DocumentLinkModel.destroy({ where: { [Op.or]: linkOr }, transaction });
  }
  await destroyByCompany('DocumentFormRecord');
  await destroyByCompany('Document');
  await destroyByCompany('DocumentTypeForm');
  await destroyByCompany('Client');

  // 3. Dispositivos FTP y consumos mensuales
  await destroyByCompany('FtpDevice');
  await destroyByCompany('CompanyMonthlyUsage');

  // 4. Notificaciones y preferencias de usuario
  const NotificationModel = models['Notification'];
  if (NotificationModel) {
    const notifOr: any[] = [{ companyId }];
    if (userIds.length > 0) {
      notifOr.push({ userId: { [Op.in]: userIds } });
    }
    await NotificationModel.destroy({ where: { [Op.or]: notifOr }, transaction });
  }

  if (userIds.length > 0) {
    for (const userChildModel of [
      'NotificationPreference',
      'PushSubscription',
      'UserPermission',
    ]) {
      const m = models[userChildModel];
      if (m) {
        await m.destroy({ where: { userId: { [Op.in]: userIds } }, transaction });
      }
    }
  }

  // 5. Auditoría (modelo AuditLog -> tabla `audits`, incluye FK user_id con ON DELETE NO ACTION)
  const AuditModel = models['AuditLog'] || models['Audit'];
  if (AuditModel) {
    const auditOr: any[] = [{ companyId }];
    if (userIds.length > 0) {
      auditOr.push({ userId: { [Op.in]: userIds } });
    }
    await AuditModel.destroy({ where: { [Op.or]: auditOr }, transaction });
  }

  // 6. Desvincular logs de seguridad (preserving historical logs without dangling company/user IDs)
  for (const secModelName of ['SecurityLoginEvent', 'SecurityErrorLog']) {
    const m = models[secModelName];
    if (m) {
      await m.update({ companyId: null, userId: null }, { where: { companyId }, transaction });
      if (userIds.length > 0) {
        await m.update(
          { userId: null },
          { where: { userId: { [Op.in]: userIds } }, transaction },
        );
      }
    }
  }

  const SecurityIpModel = models['SecurityIpIntelligence'];
  if (SecurityIpModel) {
    await SecurityIpModel.update(
      { lastCompanyId: null, lastUserId: null },
      { where: { lastCompanyId: companyId }, transaction },
    );
  }

  // 7. Roles y usuarios de la compañía
  if (RoleModel && userIds.length > 0) {
    await RoleModel.update(
      { userId: null },
      { where: { userId: { [Op.in]: userIds } }, transaction },
    );
  }

  if (UsersModel) {
    await UsersModel.destroy({ where: { companyId }, transaction });
  }

  if (roleIds.length > 0) {
    const RolePermissionModel = models['RolePermission'];
    if (RolePermissionModel) {
      await RolePermissionModel.destroy({
        where: { roleId: { [Op.in]: roleIds } },
        transaction,
      });
    }
    if (RoleModel) {
      await RoleModel.destroy({ where: { id: { [Op.in]: roleIds } }, transaction });
    }
  }

  return { ftpUsernames, documentPaths, userImagePaths };
}

const diskCleanupLogger = new Logger('CompanyDiskCleanup');

/**
 * Elimina físicamente del disco (uploads y storage legado) todas las carpetas del tenant
 * (`tenancy/company_<id>*` y `tenancy/<id>`), documentos individuales y assets locales
 * (logo de empresa y fotos de perfil de usuarios), validando límites para evitar Path Traversal.
 */
export function purgeCompanyDiskFiles(params: {
  companyId: number;
  documentPaths?: string[];
  assetPaths?: Array<string | null | undefined>;
}): { removedDirectories: number; removedFiles: number } {
  const safeId = sanitizeTenantId(params.companyId);
  const storageRoot = resolve(getStorageRootPath());
  const legacyStorageRoot = resolve(getBackendRootPath(), 'storage');
  const rootsToScan = Array.from(new Set([storageRoot, legacyStorageRoot]));

  let removedDirectories = 0;
  let removedFiles = 0;

  for (const root of rootsToScan) {
    const tenancyDir = join(root, 'tenancy');
    if (!existsSync(tenancyDir)) continue;

    try {
      const entries = readdirSync(tenancyDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const matchesTenantDir =
          entry.name === `company_${safeId}` ||
          entry.name.startsWith(`company_${safeId}_`) ||
          entry.name === String(safeId);
        if (!matchesTenantDir) continue;

        const targetDir = resolve(tenancyDir, entry.name);
        const tenancyPrefix = tenancyDir.endsWith(sep) ? tenancyDir : `${tenancyDir}${sep}`;
        if (!targetDir.startsWith(tenancyPrefix)) continue;

        try {
          rmSync(targetDir, { recursive: true, force: true });
          removedDirectories += 1;
        } catch (err: any) {
          diskCleanupLogger.warn(
            `No se pudo eliminar directorio tenant ${targetDir}: ${err?.message}`,
          );
        }
      }
    } catch (err: any) {
      diskCleanupLogger.warn(
        `No se pudo inspeccionar ${tenancyDir} al limpiar company_${safeId}: ${err?.message}`,
      );
    }
  }

  for (const docPath of params.documentPaths || []) {
    if (!docPath) continue;
    try {
      const resolvedDoc = resolveSafeStorageFilePath(docPath, safeId);
      if (existsSync(resolvedDoc)) {
        rmSync(resolvedDoc, { force: true });
        removedFiles += 1;
      }
    } catch {
      // Ignorar rutas inválidas fuera del almacenamiento
    }
  }

  const rootPrefix = storageRoot.endsWith(sep) ? storageRoot : `${storageRoot}${sep}`;
  for (const rawAsset of params.assetPaths || []) {
    const cleanRaw = String(rawAsset || '').trim();
    if (
      !cleanRaw ||
      cleanRaw.startsWith('http://') ||
      cleanRaw.startsWith('https://') ||
      cleanRaw.startsWith('data:')
    ) {
      continue;
    }

    const stripped = cleanRaw
      .replace(/\\/g, '/')
      .replace(/^\/?(?:api\/)?images\//i, '')
      .replace(/^\/+/, '');
    if (!stripped) continue;

    const candidate = resolve(storageRoot, stripped);
    if (!candidate.startsWith(rootPrefix)) continue;

    try {
      if (existsSync(candidate)) {
        rmSync(candidate, { force: true });
        removedFiles += 1;
      }
    } catch (err: any) {
      diskCleanupLogger.warn(`No se pudo eliminar archivo ${candidate}: ${err?.message}`);
    }
  }

  return { removedDirectories, removedFiles };
}
