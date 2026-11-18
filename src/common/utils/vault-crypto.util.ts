import * as crypto from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { readEnv, resolveJwtSecret } from '../../config/env-resolver';

const VAULT_MAGIC_HEADER = Buffer.from('HCSV1', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MIN_ENCRYPTED_LENGTH = VAULT_MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH;
const SECRET_PREFIX = 'hcs_enc_v1';

/**
 * Resuelve la clave maestra de cifrado de bóveda desde `VAULT_ENCRYPTION_KEY`
 * (o respaldo determinístico sobre `JWT_SECRET` si aún no se configuró variable dedicada).
 */
function resolveMasterVaultKey(): string {
  return readEnv('VAULT_ENCRYPTION_KEY', 'ENCRYPTION_KEY') ?? resolveJwtSecret();
}

function deriveCompanyAes256Key(companyId: number): Buffer {
  const masterKey = resolveMasterVaultKey();
  return crypto
    .createHash('sha256')
    .update(`${masterKey}:helpscan:vault:company:${Number(companyId)}`)
    .digest();
}

function deriveFtpSecretAes256Key(): Buffer {
  const masterKey = resolveMasterVaultKey();
  return crypto
    .createHash('sha256')
    .update(`${masterKey}:helpscan:ftp:credentials`)
    .digest();
}

export function isVaultEncryptionEnabled(): boolean {
  return (readEnv('VAULT_ENCRYPTION_ENABLED') ?? 'true').toLowerCase() !== 'false';
}

export function hasCustomVaultEncryptionKey(): boolean {
  return Boolean(readEnv('VAULT_ENCRYPTION_KEY', 'ENCRYPTION_KEY'));
}

export function isEncryptedVaultBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < VAULT_MAGIC_HEADER.length) return false;
  return buffer.subarray(0, VAULT_MAGIC_HEADER.length).equals(VAULT_MAGIC_HEADER);
}

/**
 * Cifra un buffer PDF en memoria usando AES-256-GCM con llave derivada por compañía.
 * Formato binario: `HCSV1` (5B) + `IV` (12B) + `AuthTag` (16B) + `Ciphertext`.
 */
export function encryptVaultBuffer(plainBuffer: Buffer, companyId: number): Buffer {
  if (!isVaultEncryptionEnabled()) {
    return plainBuffer;
  }

  const key = deriveCompanyAes256Key(companyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([VAULT_MAGIC_HEADER, iv, authTag, encrypted]);
}

/**
 * Descifra un buffer de bóveda si posee cabecera `HCSV1`;
 * si es un PDF legado sin cifrar, lo devuelve intacto para compatibilidad hacia atrás.
 */
export function decryptVaultBuffer(storedBuffer: Buffer, companyId: number): Buffer {
  if (!isEncryptedVaultBuffer(storedBuffer)) {
    return storedBuffer;
  }

  if (storedBuffer.length < MIN_ENCRYPTED_LENGTH) {
    throw new Error('El archivo cifrado en bóveda está dañado o truncado.');
  }

  const ivStart = VAULT_MAGIC_HEADER.length;
  const tagStart = ivStart + IV_LENGTH;
  const cipherStart = tagStart + TAG_LENGTH;

  const iv = storedBuffer.subarray(ivStart, tagStart);
  const authTag = storedBuffer.subarray(tagStart, cipherStart);
  const ciphertext = storedBuffer.subarray(cipherStart);

  const key = deriveCompanyAes256Key(companyId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function writeEncryptedVaultFile(
  fullPath: string,
  plainBuffer: Buffer,
  companyId: number,
): void {
  const payload = encryptVaultBuffer(plainBuffer, companyId);
  writeFileSync(fullPath, payload);
}

export function readDecryptedVaultFile(fullPath: string, companyId: number): Buffer {
  const storedBuffer = readFileSync(fullPath);
  return decryptVaultBuffer(storedBuffer, companyId);
}

/**
 * Cifra contraseñas FTP de dispositivos antes de guardarlas en PostgreSQL.
 */
export function encryptFtpSecret(plainSecret: string): string {
  const key = deriveFtpSecretAes256Key();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainSecret, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${SECRET_PREFIX}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptFtpSecret(storedSecret: string): string {
  if (!storedSecret || !storedSecret.startsWith(`${SECRET_PREFIX}:`)) {
    return storedSecret;
  }

  const parts = storedSecret.split(':');
  if (parts.length !== 4) {
    throw new Error('Formato de credencial FTP cifrada inválido.');
  }

  const [, ivHex, tagHex, cipherHex] = parts;
  const key = deriveFtpSecretAes256Key();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

