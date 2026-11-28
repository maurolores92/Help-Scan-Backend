import { Op, QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

export const DEFAULT_MAX_SECURITY_LOG_ROWS = 500;

export type AllowedSecurityLogTable =
  | 'security_error_logs'
  | 'security_access_logs'
  | 'security_login_events';

/**
 * Resuelve el límite máximo de registros a retener por tabla de logs de seguridad.
 * Valor por defecto: 500 registros más recientes.
 */
export function resolveMaxSecurityLogRows(): number {
  const raw = Number(
    process.env.SECURITY_MAX_LOG_ROWS || DEFAULT_MAX_SECURITY_LOG_ROWS,
  );
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_MAX_SECURITY_LOG_ROWS;
}

/**
 * Mantiene como máximo `maxRows` registros más recientes en una tabla de seguridad,
 * eliminando los más antiguos (`created_at ASC, id ASC`) para evitar crecimiento masivo.
 */
export async function pruneExcessSecurityLogRows(params: {
  model: any;
  tableName: AllowedSecurityLogTable;
  maxRows?: number;
  sequelize?: Sequelize | null;
}): Promise<number> {
  const maxRows = Math.max(
    1,
    Math.floor(params.maxRows ?? resolveMaxSecurityLogRows()),
  );
  const db = params.sequelize || params.model?.sequelize || null;

  if (db && typeof db.query === 'function') {
    try {
      const rows = (await db.query(
        `WITH stale AS (
           SELECT "id"
           FROM "${params.tableName}"
           ORDER BY "created_at" DESC, "id" DESC
           OFFSET :maxRows
         ),
         deleted AS (
           DELETE FROM "${params.tableName}"
           WHERE "id" IN (SELECT "id" FROM stale)
           RETURNING "id"
         )
         SELECT COUNT(*)::int AS "deletedCount" FROM deleted`,
        {
          replacements: { maxRows },
          type: QueryTypes.SELECT,
        },
      )) as Array<{ deletedCount?: number }>;

      return Number(rows?.[0]?.deletedCount || 0);
    } catch {
      // Fallback a API de Sequelize si el entorno no soporta CTE con RETURNING (o en mocks)
    }
  }

  if (
    typeof params.model?.findAll === 'function' &&
    typeof params.model?.destroy === 'function'
  ) {
    const staleRows = await params.model.findAll({
      attributes: ['id'],
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      offset: maxRows,
      raw: true,
    });
    const staleIds = Array.isArray(staleRows)
      ? staleRows.map((row: any) => row?.id).filter((id) => id !== undefined && id !== null)
      : [];

    if (staleIds.length === 0) return 0;

    return Number(
      await params.model.destroy({
        where: { id: { [Op.in]: staleIds } },
      }),
    );
  }

  return 0;
}
