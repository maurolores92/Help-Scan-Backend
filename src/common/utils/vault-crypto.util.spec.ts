import * as os from 'os';
import * as path from 'path';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import {
  decryptFtpSecret,
  decryptVaultBuffer,
  encryptFtpSecret,
  encryptVaultBuffer,
  isEncryptedVaultBuffer,
  readDecryptedVaultFile,
  writeEncryptedVaultFile,
} from './vault-crypto.util';

describe('vault-crypto.util (AES-256-GCM Bóveda y Credenciales FTP)', () => {
  const prevVaultKey = process.env.VAULT_ENCRYPTION_KEY;
  const prevEnabled = process.env.VAULT_ENCRYPTION_ENABLED;
  let tempDir: string;

  beforeEach(() => {
    process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.VAULT_ENCRYPTION_ENABLED = 'true';
    tempDir = path.join(os.tmpdir(), `hc-scan-crypto-spec-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    process.env.VAULT_ENCRYPTION_KEY = prevVaultKey;
    process.env.VAULT_ENCRYPTION_ENABLED = prevEnabled;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('cifra en reposo con cabecera HCSV1 y descifra correctamente para la compañía dueña', () => {
    const plainPdf = Buffer.from('%PDF-1.7 Contenido confidencial de factura AFIP #1001');
    const encrypted = encryptVaultBuffer(plainPdf, 42);

    expect(isEncryptedVaultBuffer(encrypted)).toBe(true);
    expect(encrypted.equals(plainPdf)).toBe(false);
    expect(encrypted.toString('utf8')).not.toContain('AFIP #1001');

    const decrypted = decryptVaultBuffer(encrypted, 42);
    expect(decrypted.equals(plainPdf)).toBe(true);
  });

  it('impide descifrar un documento con la clave derivada de otra compañía (aislamiento criptográfico)', () => {
    const plainPdf = Buffer.from('%PDF-1.7 Secreto empresa 1');
    const encryptedForCompany1 = encryptVaultBuffer(plainPdf, 1);

    expect(() => decryptVaultBuffer(encryptedForCompany1, 2)).toThrow();
  });

  it('mantiene compatibilidad hacia atrás con PDFs legados sin cifrar en disco', () => {
    const legacyPlainPdf = Buffer.from('%PDF-1.4 Documento antiguo sin cabecera HCSV1');
    expect(isEncryptedVaultBuffer(legacyPlainPdf)).toBe(false);

    const readBack = decryptVaultBuffer(legacyPlainPdf, 9);
    expect(readBack.equals(legacyPlainPdf)).toBe(true);
  });

  it('escribe archivos cifrados en disco y los lee descifrados con readDecryptedVaultFile', () => {
    const targetFile = path.join(tempDir, 'vault-sample.pdf');
    const original = Buffer.from('%PDF-1.5 Escaneo HP E52645');

    writeEncryptedVaultFile(targetFile, original, 15);
    const rawDiskBytes = readFileSync(targetFile);
    expect(isEncryptedVaultBuffer(rawDiskBytes)).toBe(true);

    const restored = readDecryptedVaultFile(targetFile, 15);
    expect(restored.equals(original)).toBe(true);
  });

  it('cifra y descifra contraseñas FTP virtuales mediante encryptFtpSecret / decryptFtpSecret', () => {
    const secret = 'HP_E52645_UltraSecret#2026!';
    const stored = encryptFtpSecret(secret);

    expect(stored).not.toBe(secret);
    expect(stored.startsWith('hcs_enc_v1:')).toBe(true);
    expect(decryptFtpSecret(stored)).toBe(secret);
  });
});
