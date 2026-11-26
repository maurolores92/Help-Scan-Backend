const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'jwt',
  'creditcard',
];

/**
 * Normaliza direcciones IP (remueve prefijo IPv6-mapped `::ffff:` y puertos).
 */
export function normalizeIpAddress(raw?: string | null): string {
  let value = String(raw || '').trim();
  if (!value) return '127.0.0.1';

  if (value.includes(',')) {
    value = value.split(',')[0].trim();
  }

  if (value.startsWith('::ffff:')) {
    value = value.slice(7);
  }

  if (value === '::1') {
    return '127.0.0.1';
  }

  // IPv6 con corchetes y puerto (ej: [2800:810::1]:54321)
  const ipv6BracketMatch = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6BracketMatch) {
    value = ipv6BracketMatch[1];
    if (value.startsWith('::ffff:')) {
      value = value.slice(7);
    }
  }

  // IPv4 con puerto (ej: 190.18.10.2:54321)
  const ipv4PortMatch = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4PortMatch) {
    value = ipv4PortMatch[1];
  }

  return value.slice(0, 64) || '127.0.0.1';
}

/**
 * Determina si una IP pertenece a un rango local, loopback o privado RFC1918.
 */
export function isPrivateOrLocalIp(rawIp?: string | null): boolean {
  const ip = normalizeIpAddress(rawIp).toLowerCase();
  if (
    ip === '127.0.0.1' ||
    ip.startsWith('127.') ||
    ip === '::1' ||
    ip === 'localhost' ||
    ip === '0.0.0.0'
  ) {
    return true;
  }
  if (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80:')
  ) {
    return true;
  }
  const match172 = ip.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const secondOctet = Number(match172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }
  return false;
}

function splitHeaderValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => splitHeaderValues(entry));
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseForwardedHeader(raw: unknown): string[] {
  const entries = splitHeaderValues(raw);
  const ips: string[] = [];
  for (const entry of entries) {
    const match = entry.match(/for=(?:"?\[?([^;\],"]+)\]?"?)/i);
    if (match?.[1]) {
      ips.push(match[1].trim());
    }
  }
  return ips;
}

/**
 * Extrae la IP real del cliente respetando proxies inversos (Cloudflare / Nginx / X-Forwarded-For),
 * priorizando siempre direcciones IP públicas y descartando IPs de routers/proxies internos.
 */
export function extractClientIp(req: any): string {
  const headers = req?.headers || {};
  const candidates: string[] = [
    ...splitHeaderValues(headers['cf-connecting-ip']),
    ...splitHeaderValues(headers['true-client-ip']),
    ...splitHeaderValues(headers['x-client-ip']),
    ...splitHeaderValues(headers['x-real-ip']),
    ...splitHeaderValues(headers['x-forwarded-for']),
    ...parseForwardedHeader(headers['forwarded']),
    ...(Array.isArray(req?.ips) ? req.ips : []),
    ...(typeof req?.ip === 'string' ? [req.ip] : []),
    ...(typeof req?.socket?.remoteAddress === 'string' ? [req.socket.remoteAddress] : []),
    ...(typeof req?.connection?.remoteAddress === 'string'
      ? [req.connection.remoteAddress]
      : []),
  ];

  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) {
      const normalized = normalizeIpAddress(cand);
      if (!isPrivateOrLocalIp(normalized)) {
        return normalized;
      }
    }
  }

  const fallback = candidates.find((c) => typeof c === 'string' && c.trim());
  return normalizeIpAddress(fallback || '127.0.0.1');
}

/**
 * Extrae navegador, sistema operativo y tipo de dispositivo de un User-Agent sin dependencias externas.
 */
export function parseUserAgentSummary(userAgent?: string | null): {
  browser: string;
  os: string;
  deviceType: string;
} {
  const ua = String(userAgent || '').trim();
  if (!ua) {
    return { browser: 'Desconocido', os: 'Desconocido', deviceType: 'Desconocido' };
  }

  let browser = 'Otro';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/PostmanRuntime/i.test(ua)) browser = 'Postman';
  else if (/curl\//i.test(ua)) browser = 'cURL';
  else if (/node|axios|undici|python/i.test(ua)) browser = 'Cliente API / Script';

  let os = 'Otro';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let deviceType = 'Desktop';
  if (/PostmanRuntime|curl|axios|node|python|bot|crawler/i.test(ua)) {
    deviceType = 'API / Bot';
  } else if (/iPad|Tablet/i.test(ua)) {
    deviceType = 'Tablet';
  } else if (/Mobile|Android|iPhone/i.test(ua)) {
    deviceType = 'Mobile';
  }

  return { browser, os, deviceType };
}

/**
 * Enmascara recursivamente claves sensibles antes de persistir payloads de error.
 */
export function sanitizeSecurityPayload(value: any, depth = 0): any {
  if (value === null || value === undefined) return null;
  if (depth > 4) return '[TRUNCADO]';

  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeSecurityPayload(item, depth + 1));
  }

  const output: Record<string, any> = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) {
    const lowerKey = k.toLowerCase();
    if (SENSITIVE_KEY_FRAGMENTS.some((frag) => lowerKey.includes(frag))) {
      output[k] = '[OCULTO]';
    } else {
      output[k] = sanitizeSecurityPayload(v, depth + 1);
    }
  }
  return output;
}
