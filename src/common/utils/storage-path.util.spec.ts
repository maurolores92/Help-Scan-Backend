import { basename, join, resolve } from 'path';
import { getBackendRootPath, getStorageRootPath } from './storage-path.util';

describe('storage-path.util', () => {
  const originalStorageRootPath = process.env.STORAGE_ROOT_PATH;

  afterEach(() => {
    if (originalStorageRootPath !== undefined) {
      process.env.STORAGE_ROOT_PATH = originalStorageRootPath;
    } else {
      delete process.env.STORAGE_ROOT_PATH;
    }
  });

  it('resuelve la raíz del backend donde está package.json y nunca dentro de dist/', () => {
    const root = getBackendRootPath();
    expect(basename(root).toLowerCase()).not.toBe('dist');
    expect(root).toBe(resolve(__dirname, '..', '..', '..'));
  });

  it('resuelve STORAGE_ROOT_PATH relativo contra la raíz real de backend y no dentro de dist/', () => {
    process.env.STORAGE_ROOT_PATH = './uploads';
    const storageRoot = getStorageRootPath();
    expect(storageRoot).toBe(join(getBackendRootPath(), 'uploads'));
    expect(storageRoot.replace(/\\/g, '/')).not.toContain('/dist/');
  });
});
