import { join } from 'path';
import * as fs from 'fs';
import { getStorageRootPath } from './storage-path.util';

/**
 * Retorna la ruta absoluta al directorio raíz `backend/uploads`.
 * Unificado canónicamente con `getStorageRootPath()` para que todo el almacenamiento
 * de archivos y espacio por compañía resida centralizado en `uploads`.
 */
export function getUploadsRootPath(): string {
  const root = getStorageRootPath();
  return ensureUploadsStructure(root);
}

/**
 * Garantiza que la carpeta raíz y las subcarpetas estándar existan en disco.
 */
export function ensureUploadsStructure(rootPath: string): string {
  if (!fs.existsSync(rootPath)) {
    fs.mkdirSync(rootPath, { recursive: true });
  }

  const standardFolders = ['brands', 'models', 'users', 'companies', 'tmp', 'tenancy'];
  for (const folder of standardFolders) {
    const folderPath = join(rootPath, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  }

  return rootPath;
}

