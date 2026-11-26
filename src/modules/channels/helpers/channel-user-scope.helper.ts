import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { isPlatformSuperAdmin } from '../../../common/utils/tenant-scope.util';
import { Users } from '../../users/users.model';

export interface ChannelOwnerContext {
  companyId: number;
  userId: number;
  actorUserId: number;
  isCompanyAdmin: boolean;
}

/**
 * Determina si el usuario autenticado posee privilegios de administración
 * dentro de su compañía (`isAdmin`, `company_admin` o `admin`).
 */
export function isCompanyAdminUser(user: any): boolean {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  const slug =
    typeof user.role === 'string'
      ? user.role.toLowerCase()
      : String(user.role?.slug || '').toLowerCase();
  return slug === 'company_admin' || slug === 'admin';
}

/**
 * Valida la pertenencia a una compañía activa y resuelve de qué usuario es el canal
 * que se consulta o modifica. Solo el administrador de la compañía puede operar
 * canales de otro usuario mediante `requestedUserId`.
 */
export async function resolveChannelOwnerContext(
  user: any,
  requestedUserId?: number | string | null,
  usersModel?: typeof Users,
): Promise<ChannelOwnerContext> {
  if (isPlatformSuperAdmin(user)) {
    throw new ForbiddenException(
      'El Super Administrador de plataforma no gestiona canales privados de compañías.',
    );
  }

  const companyId = Number(user?.companyId);
  const actorUserId = Number(user?.id);
  if (
    !Number.isInteger(companyId) ||
    companyId <= 0 ||
    !Number.isInteger(actorUserId) ||
    actorUserId <= 0
  ) {
    throw new ForbiddenException(
      'Acceso denegado: Se requiere pertenecer a una compañía activa.',
    );
  }

  const admin = isCompanyAdminUser(user);
  const parsedRequested =
    requestedUserId !== undefined &&
    requestedUserId !== null &&
    String(requestedUserId).trim() !== ''
      ? Number(requestedUserId)
      : undefined;

  if (parsedRequested !== undefined) {
    if (!Number.isInteger(parsedRequested) || parsedRequested <= 0) {
      throw new ForbiddenException('Identificador de usuario inválido.');
    }
    if (parsedRequested !== actorUserId) {
      if (!admin) {
        throw new ForbiddenException(
          'Solo el administrador de la compañía puede configurar canales de otro usuario.',
        );
      }
      if (usersModel) {
        const target = await usersModel.findOne({
          where: { id: parsedRequested, companyId },
          attributes: ['id'],
        });
        if (!target) {
          throw new NotFoundException(
            'El usuario indicado no pertenece a esta compañía.',
          );
        }
      }
      return {
        companyId,
        userId: parsedRequested,
        actorUserId,
        isCompanyAdmin: admin,
      };
    }
  }

  return {
    companyId,
    userId: actorUserId,
    actorUserId,
    isCompanyAdmin: admin,
  };
}

/**
 * Resuelve el filtro efectivo de `userId` para consultas de bandejas (`/emails`, `/whatsapp`, `/telegram`).
 * Usuarios comunes siempre quedan restringidos a su propio `user.id`; administradores
 * pueden filtrar por un usuario puntual o ver toda la empresa (`undefined`).
 */
export function resolveInboxFilterUserId(
  user: any,
  requestedUserId?: number | string | null,
): number | undefined {
  if (!isCompanyAdminUser(user)) {
    return Number(user?.id);
  }
  if (
    requestedUserId !== undefined &&
    requestedUserId !== null &&
    String(requestedUserId).trim() !== ''
  ) {
    const parsed = Number(requestedUserId);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}
