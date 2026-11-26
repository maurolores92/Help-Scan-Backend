import { Op, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

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
): Promise<{ ftpUsernames: string[] }> {
  const models = sequelize.models || {};

  const UsersModel = models['Users'];
  const RoleModel = models['Role'];
  const DocumentModel = models['Document'];
  const FtpDeviceModel = models['FtpDevice'];

  const [companyUsers, companyRoles, companyDocs, ftpDevices] = await Promise.all([
    UsersModel
      ? UsersModel.findAll({
          where: { companyId },
          attributes: ['id'],
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
          attributes: ['id'],
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
  const roleIds = (companyRoles as unknown as Array<{ id: number }>).map((r) => Number(r.id)).filter(Boolean);
  const docIds = (companyDocs as unknown as Array<{ id: number }>).map((d) => Number(d.id)).filter(Boolean);
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

  // 5. Auditoría (incluye FK user_id con ON DELETE NO ACTION)
  const AuditModel = models['Audit'];
  if (AuditModel) {
    await AuditModel.destroy({ where: { companyId }, transaction });
    if (userIds.length > 0) {
      await AuditModel.update(
        { userId: null },
        { where: { userId: { [Op.in]: userIds } }, transaction },
      );
    }
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

  return { ftpUsernames };
}
