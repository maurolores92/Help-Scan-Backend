/**
 * Payload enviado por SFTPGo al webhook interno cuando una impresora HP finaliza una carga.
 * Se define como interface para tolerar todos los metadatos nativos enviados por SFTPGo
 * sin colisionar con `ValidationPipe({ forbidNonWhitelisted: true })`.
 */
export interface SftpGoWebhookPayload {
  action?: string;
  username?: string;
  path?: string;
  fs_path?: string;
  virtual_path?: string;
  companyId?: number;
  file_size?: number;
  status?: number | string;
  protocol?: string;
  ip?: string;
  timestamp?: number;
  error?: string;
}

