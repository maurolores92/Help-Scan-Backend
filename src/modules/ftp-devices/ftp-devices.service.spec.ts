import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { UnauthorizedException } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { FtpDevicesService } from './ftp-devices.service';
import { FtpDevice, FtpDeviceStatus, FtpProtocol } from './ftp-device.model';
import { Company, CompanyStatus } from '../companies/company.model';
import { SftpGoClientService } from './services/sftpgo-client.service';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';
import { TenantInboxWatcherService } from '../documents/services/tenant-inbox-watcher.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ensureTenantDirectories,
  ensureTenantFtpInboxDir,
} from '../../common/utils/storage-path.util';
import { encryptFtpSecret } from '../../common/utils/vault-crypto.util';

describe('FtpDevicesService (HP E52645 / SFTPGo)', () => {
  let service: FtpDevicesService;
  let ftpDeviceModelMock: any;
  let companyModelMock: any;
  let sftpGoClientMock: any;
  let inboxWatcherMock: any;
  let auditServiceMock: any;
  let tempStorageDir: string;
  const prevStorageRoot = process.env.STORAGE_ROOT;
  const prevStorageRootPath = process.env.STORAGE_ROOT_PATH;
  const prevWebhookSecret = process.env.SFTPGO_WEBHOOK_SECRET;
  const prevVaultKey = process.env.VAULT_ENCRYPTION_KEY;

  beforeEach(async () => {
    tempStorageDir = path.join(os.tmpdir(), `hc-scan-ftp-spec-${Date.now()}`);
    process.env.STORAGE_ROOT = tempStorageDir;
    process.env.STORAGE_ROOT_PATH = tempStorageDir;
    process.env.SFTPGO_WEBHOOK_SECRET = 'test_webhook_secret_123';
    process.env.VAULT_ENCRYPTION_KEY =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    ftpDeviceModelMock = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (payload) => {
        const record: any = {
          id: 11,
          ...payload,
          get: () => ({ id: 11, ...payload }),
          update: jest.fn().mockImplementation(async (patch) => {
            Object.assign(record, patch);
            return record;
          }),
          destroy: jest.fn().mockResolvedValue(undefined),
        };
        return record;
      }),
    };

    companyModelMock = {
      findByPk: jest.fn().mockResolvedValue({
        id: 5,
        name: 'Imprenta Sur',
        status: CompanyStatus.ACTIVE,
        enabledModules: ['documents'],
      }),
    };

    sftpGoClientMock = {
      getServerInfoWithHealth: jest.fn().mockResolvedValue({
        host: 'ftp.helpcopies.com',
        sftpPort: 2222,
        ftpsPort: 21,
        ftpPort: 21,
        passivePorts: '50000-50100',
        sftpgoConfigured: true,
        sftpgoReachable: true,
      }),
      getPublicServerMetadata: jest.fn().mockReturnValue({
        host: 'ftp.helpcopies.com',
        sftpPort: 2222,
        ftpsPort: 21,
        ftpPort: 21,
        passivePorts: '50000-50100',
        sftpgoConfigured: true,
      }),
      syncVirtualUser: jest.fn().mockResolvedValue({ synced: true, error: null }),
      deleteVirtualUser: jest.fn().mockResolvedValue(undefined),
    };

    inboxWatcherMock = {
      registerTenantInbox: jest.fn(),
      scanTenantInbox: jest.fn().mockResolvedValue({ imported: 0 }),
      ingestSingleInboxFile: jest.fn().mockResolvedValue({
        status: 'imported',
        document: { id: 901 },
      }),
    };

    auditServiceMock = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FtpDevicesService,
        { provide: getModelToken(FtpDevice), useValue: ftpDeviceModelMock },
        { provide: getModelToken(Company), useValue: companyModelMock },
        { provide: SftpGoClientService, useValue: sftpGoClientMock },
        {
          provide: TenantQuotasService,
          useValue: {
            getCompanyQuotaSummary: jest.fn().mockResolvedValue({ storageMb: { current: 10, max: 500 } }),
          },
        },
        { provide: TenantInboxWatcherService, useValue: inboxWatcherMock },
        { provide: AuditService, useValue: auditServiceMock },
        {
          provide: NotificationsService,
          useValue: { dispatch: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<FtpDevicesService>(FtpDevicesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env.STORAGE_ROOT = prevStorageRoot;
    process.env.STORAGE_ROOT_PATH = prevStorageRootPath;
    process.env.SFTPGO_WEBHOOK_SECRET = prevWebhookSecret;
    process.env.VAULT_ENCRYPTION_KEY = prevVaultKey;
    try {
      rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {}
  });

  it('fuerza companyId del usuario tenant aunque solicite otro companyId en findAll', async () => {
    await service.findAll(
      { id: 3, companyId: 5, role: 'company_admin' },
      999,
    );

    expect(ftpDeviceModelMock.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 5 },
      }),
    );
  });

  it('crea equipo HP E52645 con clave cifrada, oculta hash en device y sincroniza SFTPGo', async () => {
    const result = await service.create(
      {
        deviceName: 'HP E52645 Contabilidad',
        protocol: FtpProtocol.SFTP,
        allowedIps: ['190.12.34.56'],
      },
      { id: 7, companyId: 5, role: 'company_admin' },
    );

    expect(result.credentials.password.length).toBeGreaterThanOrEqual(16);
    expect((result.device as any).passwordEncrypted).toBeUndefined();
    expect(sftpGoClientMock.syncVirtualUser).toHaveBeenCalledTimes(1);
    expect(inboxWatcherMock.registerTenantInbox).toHaveBeenCalledWith(5);
    expect(auditServiceMock.log).toHaveBeenCalled();
  });

  it('descifra credenciales en getCredentials y audita el acceso', async () => {
    ftpDeviceModelMock.findOne.mockResolvedValue({
      id: 11,
      companyId: 5,
      deviceName: 'HP E52645 Deposito',
      deviceModel: 'HP LaserJet Managed E52645',
      protocol: FtpProtocol.SFTP,
      username: 'hc_c5_deposito_a1b2',
      subFolder: 'deposito',
      passwordEncrypted: encryptFtpSecret('SuperClaveHP#99'),
      status: FtpDeviceStatus.ACTIVE,
    });

    const creds = await service.getCredentials(11, {
      id: 7,
      companyId: 5,
      role: 'company_admin',
    });

    expect(creds.password).toBe('SuperClaveHP#99');
    expect(creds.port).toBe(2222);
    expect(auditServiceMock.log).toHaveBeenCalled();
  });

  it('rechaza webhook SFTPGo si el token secreto es inválido o está ausente', async () => {
    await expect(
      service.handleSftpGoWebhook('wrong_secret', undefined, {
        action: 'upload',
        username: 'hc_c5_hp',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('procesa webhook SFTPGo válido, resuelve subcarpeta del equipo y llama a ingestSingleInboxFile', async () => {
    ensureTenantFtpInboxDir(5, 'recepcion');
    const inboxDeviceDir = path.join(
      ensureTenantDirectories(5).inboxDir,
      'recepcion',
    );
    expect(existsSync(inboxDeviceDir)).toBe(true);
    const uploadedPdf = path.join(inboxDeviceDir, 'scan_hp_001.pdf');
    writeFileSync(uploadedPdf, Buffer.from('%PDF-1.7 OK'));

    ftpDeviceModelMock.findOne.mockResolvedValue({
      id: 22,
      companyId: 5,
      deviceName: 'HP E52645 Recepción',
      subFolder: 'recepcion',
      username: 'hc_c5_recepcion_01',
    });

    const res = await service.handleSftpGoWebhook(
      'test_webhook_secret_123',
      undefined,
      {
        action: 'upload',
        username: 'hc_c5_recepcion_01',
        virtual_path: '/scan_hp_001.pdf',
      },
    );

    expect(res).toEqual(
      expect.objectContaining({
        processed: true,
        companyId: 5,
        deviceId: 22,
        status: 'imported',
      }),
    );
    expect(inboxWatcherMock.ingestSingleInboxFile).toHaveBeenCalledWith(
      5,
      uploadedPdf,
      undefined,
      true,
      { id: 22, deviceName: 'HP E52645 Recepción' },
    );
  });
});
