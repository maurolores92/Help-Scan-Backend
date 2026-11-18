/**
 * Resolución tolerante de variables de entorno.
 * Acepta ambas convenciones de nombres (`DATABASE_*` / `DB_*`, `JWT_SECRET_KEY` / `JWT_SECRET`)
 * para evitar que la conexión a PostgreSQL o la firma JWT reciban `undefined`.
 */
export const readEnv = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
};

export interface ResolvedDatabaseEnv {
  host: string;
  port: number;
  username: string | undefined;
  password: string;
  database: string | undefined;
}

export const resolveDatabaseEnv = (): ResolvedDatabaseEnv => {
  const dbUrl = readEnv('DATABASE_URL');
  let parsedUrl: { host?: string; port?: number; username?: string; password?: string; database?: string } = {};
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      parsedUrl = {
        host: u.hostname,
        port: u.port ? Number(u.port) : 5432,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : '',
        database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
      };
    } catch {}
  }

  return {
    host: readEnv('DATABASE_HOST', 'DB_HOST') ?? parsedUrl.host ?? 'localhost',
    port: Number(readEnv('DATABASE_PORT', 'DB_PORT') ?? parsedUrl.port ?? 5432),
    username: readEnv('DATABASE_USER', 'DATABASE_USERNAME', 'DB_USERNAME', 'DB_USER') ?? parsedUrl.username,
    // `pg` exige que la contraseña sea siempre string (SCRAM-SHA-256)
    password: readEnv('DATABASE_PASSWORD', 'DB_PASSWORD') ?? parsedUrl.password ?? '',
    database: readEnv('DATABASE_NAME', 'DB_DATABASE', 'DB_NAME') ?? parsedUrl.database,
  };
};

export const resolveJwtSecret = (): string =>
  readEnv('JWT_SECRET_KEY', 'JWT_SECRET') ?? 'hc_scan_jwt_secret_key_2026';

