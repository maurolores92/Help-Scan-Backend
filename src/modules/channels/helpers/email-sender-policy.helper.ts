import { EmailSenderPolicy } from '../models/company-email-channel.model';

const EXACT_EMAIL_REGEX = /^[^\s@]+@[^\s@.]+\.[^\s@.]+(?:\.[^\s@.]+)*$/;
const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Extrae una dirección de correo limpia desde valores como `"Nombre <mail@dominio.com>"` o `"Mail@Dominio.com"`.
 */
export function extractEmailAddress(raw?: string | null): string {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';

  const bracketMatch = value.match(/<([^<>]+)>/);
  const candidate = (bracketMatch ? bracketMatch[1] : value).trim();
  return candidate;
}

/**
 * Normaliza una regla de lista blanca de correo.
 * Acepta:
 * - Direcciones exactas: `facturas@proveedor.com`
 * - Dominios completos: `@proveedor.com`, `proveedor.com` o `*.proveedor.com` (se normalizan a `@proveedor.com`)
 */
export function normalizeEmailSenderRule(raw?: string | null): string | null {
  const cleaned = extractEmailAddress(raw);
  if (!cleaned || /\s/.test(cleaned)) {
    return null;
  }

  if (cleaned.startsWith('*.')) {
    const domain = cleaned.slice(2);
    return DOMAIN_REGEX.test(domain) ? `@${domain}` : null;
  }

  if (cleaned.startsWith('@')) {
    const domain = cleaned.slice(1);
    return DOMAIN_REGEX.test(domain) ? `@${domain}` : null;
  }

  if (cleaned.includes('@')) {
    return EXACT_EMAIL_REGEX.test(cleaned) ? cleaned : null;
  }

  return DOMAIN_REGEX.test(cleaned) ? `@${cleaned}` : null;
}

/**
 * Normaliza y deduplica un arreglo de reglas de remitentes autorizados,
 * ignorando entradas inválidas o vacías.
 */
export function normalizeAllowedEmailSenders(rawList?: string[] | null): string[] {
  if (!Array.isArray(rawList)) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of rawList) {
    const normalized = normalizeEmailSenderRule(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Verifica si un correo remitente está autorizado según la política configurada en el canal.
 */
export function isEmailSenderAuthorized(
  senderEmail: string | null | undefined,
  senderPolicy: EmailSenderPolicy | string | null | undefined,
  allowedSenders?: string[] | null,
): boolean {
  if (senderPolicy !== EmailSenderPolicy.WHITELIST) {
    return true;
  }

  const normalizedSender = extractEmailAddress(senderEmail);
  const atIndex = normalizedSender.lastIndexOf('@');
  if (!normalizedSender || atIndex <= 0 || atIndex === normalizedSender.length - 1) {
    return false;
  }

  const senderDomain = normalizedSender.slice(atIndex + 1);
  const rules = normalizeAllowedEmailSenders(allowedSenders);
  if (rules.length === 0) {
    return false;
  }

  for (const rule of rules) {
    if (rule.startsWith('@')) {
      const ruleDomain = rule.slice(1);
      if (senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`)) {
        return true;
      }
    } else if (normalizedSender === rule) {
      return true;
    }
  }

  return false;
}
