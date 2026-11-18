import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as crypto from 'crypto';
import { readEnv } from '../../config/env-resolver';
import {
  ensureTenantFtpInboxDir,
  resolveInboxFileFromWebhook,
  sanitizeFtpSubFolder,
} from '../../common/utils/storage-path.util';
import {
  decryptFtpSecret,
  encryptFtpSecret,
} from '../../common/utils/vault-crypto.util';
import {
  isPlatformSuperAdmin,
  requireTenantCompanyId,
} from '../../common/utils/tenant-scope.util';
import { AuditAction } from '../audit/audit.model';
import { AuditService } from '../audit/audit.service';
import { Company, CompanyStatus } from '../companies/company.model';
import { TenantInboxWatcherService } from '../documents/services/tenant-inbox-watcher.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';
import { CreateFtpDeviceDto } from './dto/create-ftp-device.dto';
import { SftpGoWebhookPayload } from './dto/sftpgo-webhook.dto';
import { UpdateFtpDeviceDto } from './dto/update-ftp-device.dto';
import { FtpDevice, FtpDeviceStatus, FtpProtocol } from './ftp-device.model';
import {
  buildFtpUsername,
  generateStrongFtpPassword,
  resolvePortForProtocol,
  serializeAllowedIpsForDb,
  toSafeFtpDeviceDto,
} from './helpers/ftp-device.helper';
import { SftpGoClientService } from './services/sftpgo-client.service';

@Injectable()
export class FtpDevicesService {
  private readonly logger = new Logger(FtpDevicesService.name);

  constructor(
    @InjectModel(FtpDevice) private readonly ftpDeviceModel: typeof FtpDevice,
    @InjectModel(Company) private readonly companyModel: typeof Company,
    private readonly sftpGoClient: SftpGoClientService,
    private readonly tenantQuotasService: TenantQuotasService,
    private readonly inboxWatcherService: TenantInboxWatcherService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async assertCompanyOperational(
    companyId: number,
    enforceTenantModule: boolean,
  ): Promise<Company> {
    const company = await this.companyModel.findByPk(companyId);
    if (!company) {
      throw new NotFoundException(`La compañía #${companyId} no existe.`);
    }

    if (enforceTenantModule) {
      if (company.status !== CompanyStatus.ACTIVE) {
        throw new ForbiddenException(
          'La compañía se encuentra inactiva o suspendida.',
        );
      }
      const modules = Array.isArray(company.enabledModules)
        ? company.enabledModules
        : [];
      if (!modules.includes('documents')) {
        throw new ForbiddenException(
          "El módulo 'documents' no se encuentra habilitado para su empresa.",
        );
      }
    }

    return company;
  }

  private async resolveScopedTargetCompany(
    user: any,
    requestedCompanyId?: number,
    requireCompany = true,
  ): Promise<number | null> {
    if (!isPlatformSuperAdmin(user)) {
      const companyId = requireTenantCompanyId(user);
      await this.assertCompanyOperational(companyId, true);
      return companyId;
    }

    if (requestedCompanyId) {
      await this.assertCompanyOperational(requestedCompanyId, false);
      return requestedCompanyId;
    }

    if (requireCompany) {
      throw new BadRequestException(
        'El Super Administrador debe indicar el `companyId` de la compañía destino.',
      );
    }

    return null;
  }

  private async findScopedDevice(id: number, user: any): Promise<FtpDevice> {
    const isSuper = isPlatformSuperAdmin(user);
    const where: Record<string, any> = { id };

    if (!isSuper) {
      const companyId = requireTenantCompanyId(user);
      await this.assertCompanyOperational(companyId, true);
      where.companyId = companyId;
    }

    const device = await this.ftpDeviceModel.findOne({ where });
    if (!device) {
      throw new NotFoundException(
        `No se encontró el equipo HP / acceso FTP #${id}.`,
      );
    }

    return device;
  }

  async findAll(user: any, requestedCompanyId?: number) {
    const scopedCompanyId = await this.resolveScopedTargetCompany(
      user,
      requestedCompanyId,
      false,
    );

    const where = scopedCompanyId ? { companyId: scopedCompanyId } : {};
    const devices = await this.ftpDeviceModel.findAll({
      where,
      include: [
        {
          model: Company,
          attributes: ['id', 'name', 'slug', 'status'],
        },
      ],
      order: [
        ['companyId', 'ASC'],
        ['createdAt', 'DESC'],
      ],
    });

    const serverInfo = await this.sftpGoClient.getServerInfoWithHealth();
    const quotaSummary = scopedCompanyId
      ? await this.tenantQuotasService.getCompanyQuotaSummary(scopedCompanyId)
      : null;

    return {
      devices: devices.map((d) => toSafeFtpDeviceDto(d, serverInfo)),
      serverInfo,
      quotaSummary,
    };
  }

  async create(dto: CreateFtpDeviceDto, user: any) {
    const companyId = await this.resolveScopedTargetCompany(
      user,
      dto.companyId,
      true,
    );
    if (!companyId) {
      throw new BadRequestException('Compañía requerida.');
    }

    const cleanSubFolder = sanitizeFtpSubFolder(
      dto.subFolder || dto.deviceName || 'hp-scanner',
    );

    const existingSubFolder = await this.ftpDeviceModel.findOne({
      where: { companyId, subFolder: cleanSubFolder },
    });
    const finalSubFolder = existingSubFolder
      ? sanitizeFtpSubFolder(
          `${cleanSubFolder}-${crypto.randomBytes(2).toString('hex')}`,
        )
      : cleanSubFolder;

    ensureTenantFtpInboxDir(companyId, finalSubFolder);
    this.inboxWatcherService.registerTenantInbox(companyId);

    const plainPassword =
      dto.customPassword?.trim() || generateStrongFtpPassword(20);
    const username = buildFtpUsername(companyId, finalSubFolder);
    const protocol = dto.protocol || FtpProtocol.SFTP;
    const status = FtpDeviceStatus.ACTIVE;

    const device = await this.ftpDeviceModel.create({
      companyId,
      deviceName: dto.deviceName.trim(),
      deviceModel:
        dto.deviceModel?.trim() || 'HP LaserJet Managed E52645',
      protocol,
      username,
      passwordEncrypted: encryptFtpSecret(plainPassword),
      subFolder: finalSubFolder,
      allowedIps: serializeAllowedIpsForDb(dto.allowedIps),
      status,
      sftpgoSynced: false,
      createdBy: user?.id ?? null,
    } as never);

    const syncResult = await this.sftpGoClient.syncVirtualUser(
      device,
      plainPassword,
    );
    await device.update({
      sftpgoSynced: syncResult.synced,
      lastSyncError: syncResult.error,
    });

    await this.auditService.log({
      action: AuditAction.CREATE,
      entity: 'FtpDevice',
      entityId: device.id,
      companyId,
      userId: user?.id,
      payload: {
        deviceId: device.id,
        deviceName: device.deviceName,
        protocol,
        subFolder: finalSubFolder,
        username,
        sftpgoSynced: syncResult.synced,
      },
      description: `Se dio de alta acceso ${protocol} para '${device.deviceName}' (carpeta inbox/${finalSubFolder})`,
    });

    await this.notificationsService.dispatch({
      type: 'ftp_device.configured',
      title: '🖨️ Nuevo equipo HP conectado',
      body: `Se creó el acceso ${protocol} '${username}' para '${device.deviceName}'.`,
      companyId,
      actorUser: user,
      extraData: { ftpDeviceId: device.id, link: '/printers-ftp' },
    });

    const serverMeta = this.sftpGoClient.getPublicServerMetadata();
    return {
      device: toSafeFtpDeviceDto(device, serverMeta),
      credentials: {
        host: serverMeta.host,
        port: resolvePortForProtocol(protocol, serverMeta),
        protocol,
        username,
        password: plainPassword,
        remotePath: '/',
      },
      syncResult,
    };
  }

  async update(id: number, dto: UpdateFtpDeviceDto, user: any) {
    const device = await this.findScopedDevice(id, user);
    const prevStatus = device.status;
    const prevSnapshot = toSafeFtpDeviceDto(device);

    const nextSubFolder = dto.subFolder
      ? sanitizeFtpSubFolder(dto.subFolder)
      : device.subFolder;
    if (nextSubFolder !== device.subFolder) {
      const collision = await this.ftpDeviceModel.findOne({
        where: { companyId: device.companyId, subFolder: nextSubFolder },
      });
      if (collision && collision.id !== device.id) {
        throw new BadRequestException(
          `La subcarpeta 'inbox/${nextSubFolder}' ya está asignada a otra impresora de esta compañía.`,
        );
      }
      ensureTenantFtpInboxDir(device.companyId, nextSubFolder);
    }

    let plainPassword: string | undefined;
    if (dto.regeneratePassword) {
      plainPassword = generateStrongFtpPassword(20);
    } else {
      plainPassword = decryptFtpSecret(device.passwordEncrypted);
    }

    await device.update({
      deviceName: dto.deviceName?.trim() || device.deviceName,
      deviceModel:
        dto.deviceModel !== undefined
          ? dto.deviceModel.trim() || null
          : device.deviceModel,
      protocol: dto.protocol ?? device.protocol,
      subFolder: nextSubFolder,
      allowedIps:
        dto.allowedIps !== undefined
          ? serializeAllowedIpsForDb(dto.allowedIps)
          : device.allowedIps,
      status: dto.status ?? device.status,
      ...(dto.regeneratePassword
        ? { passwordEncrypted: encryptFtpSecret(plainPassword) }
        : {}),
    });

    const syncResult = await this.sftpGoClient.syncVirtualUser(
      device,
      plainPassword,
    );
    await device.update({
      sftpgoSynced: syncResult.synced,
      lastSyncError: syncResult.error,
    });

    await this.auditService.log({
      action:
        dto.status && dto.status !== prevStatus
          ? AuditAction.STATUS_CHANGE
          : AuditAction.UPDATE,
      entity: 'FtpDevice',
      entityId: device.id,
      companyId: device.companyId,
      userId: user?.id,
      payload: {
        previous: prevSnapshot,
        updated: toSafeFtpDeviceDto(device),
        passwordRotated: Boolean(dto.regeneratePassword),
      },
      description: `Se actualizó el equipo HP '${device.deviceName}' (${device.status})`,
    });

    if (dto.status && dto.status !== prevStatus) {
      await this.notificationsService.dispatch({
        type: 'ftp_device.configured',
        title:
          device.status === FtpDeviceStatus.ACTIVE
            ? '✅ Acceso FTP reactivado'
            : '⏸️ Acceso FTP suspendido',
        body: `El equipo '${device.deviceName}' pasó a estado ${device.status}.`,
        companyId: device.companyId,
        actorUser: user,
        extraData: { ftpDeviceId: device.id, link: '/printers-ftp' },
      });
    }

    const serverMeta = this.sftpGoClient.getPublicServerMetadata();
    return {
      device: toSafeFtpDeviceDto(device, serverMeta),
      ...(dto.regeneratePassword ? { rotatedPassword: plainPassword } : {}),
      syncResult,
    };
  }

  async getCredentials(id: number, user: any) {
    const device = await this.findScopedDevice(id, user);
    const password = decryptFtpSecret(device.passwordEncrypted);
    const serverMeta = this.sftpGoClient.getPublicServerMetadata();

    await this.auditService.log({
      action: AuditAction.READ,
      entity: 'FtpDevice',
      entityId: device.id,
      companyId: device.companyId,
      userId: user?.id,
      description: `Se consultaron las credenciales ${device.protocol} de '${device.deviceName}'`,
    });

    return {
      deviceId: device.id,
      deviceName: device.deviceName,
      deviceModel: device.deviceModel,
      protocol: device.protocol,
      host: serverMeta.host,
      port: resolvePortForProtocol(device.protocol, serverMeta),
      username: device.username,
      password,
      remotePath: '/',
      inboxRelativePath: `tenancy/company_${device.companyId}/inbox/${device.subFolder}`,
    };
  }

  async retrySync(id: number, user: any) {
    const device = await this.findScopedDevice(id, user);
    ensureTenantFtpInboxDir(device.companyId, device.subFolder);
    const plainPassword = decryptFtpSecret(device.passwordEncrypted);
    const syncResult = await this.sftpGoClient.syncVirtualUser(
      device,
      plainPassword,
    );

    await device.update({
      sftpgoSynced: syncResult.synced,
      lastSyncError: syncResult.error,
    });

    return {
      device: toSafeFtpDeviceDto(device, this.sftpGoClient.getPublicServerMetadata()),
      syncResult,
    };
  }

  async scanDeviceInbox(id: number, user: any) {
    const device = await this.findScopedDevice(id, user);
    ensureTenantFtpInboxDir(device.companyId, device.subFolder);
    return this.inboxWatcherService.scanTenantInbox(device.companyId, user?.id);
  }

  async remove(id: number, user: any) {
    const device = await this.findScopedDevice(id, user);
    const snapshot = toSafeFtpDeviceDto(device);

    await this.sftpGoClient.deleteVirtualUser(device.username);
    await device.destroy();

    await this.auditService.log({
      action: AuditAction.DELETE,
      entity: 'FtpDevice',
      entityId: id,
      companyId: device.companyId,
      userId: user?.id,
      payload: snapshot,
      description: `Se eliminó el acceso FTP '${device.username}' de '${device.deviceName}'`,
    });

    return {
      success: true,
      message: `Acceso FTP '${device.deviceName}' eliminado correctamente.`,
    };
  }

  /**
   * Sincroniza en lote todos los equipos HP de una compañía cuando cambia su estado o se elimina.
   */
  async syncCompanyDevicesStatus(
    companyId: number,
    active: boolean,
    deleteAll = false,
  ): Promise<void> {
    try {
      const devices = await this.ftpDeviceModel.findAll({ where: { companyId } });
      if (devices.length === 0) return;

      for (const device of devices) {
        if (deleteAll) {
          await this.sftpGoClient.deleteVirtualUser(device.username);
          await device.destroy();
          continue;
        }

        const nextStatus = active
          ? FtpDeviceStatus.ACTIVE
          : FtpDeviceStatus.SUSPENDED;
        if (device.status !== nextStatus) {
          await device.update({ status: nextStatus });
        }

        const plainPassword = decryptFtpSecret(device.passwordEncrypted);
        const syncResult = await this.sftpGoClient.syncVirtualUser(
          device,
          plainPassword,
        );
        await device.update({
          sftpgoSynced: syncResult.synced,
          lastSyncError: syncResult.error,
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `Error sincronizando dispositivos FTP para company_${companyId}: ${err?.message}`,
      );
    }
  }

  private verifyWebhookSecret(
    headerSecret?: string,
    querySecret?: string,
  ): void {
    const expected = readEnv('SFTPGO_WEBHOOK_SECRET');
    if (!expected) {
      throw new UnauthorizedException(
        'SFTPGO_WEBHOOK_SECRET no configurado en el servidor.',
      );
    }

    const provided = (headerSecret || querySecret || '').trim();
    if (!provided) {
      throw new UnauthorizedException('Falta token secreto del webhook SFTPGo.');
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Token secreto del webhook SFTPGo inválido.');
    }
  }

  async handleSftpGoWebhook(
    headerSecret: string | undefined,
    querySecret: string | undefined,
    payload: SftpGoWebhookPayload,
  ) {
    this.verifyWebhookSecret(headerSecret, querySecret);

    const action = String(payload?.action || '').toLowerCase();
    if (action && action !== 'upload' && action !== 'first-upload') {
      return { ignored: true, reason: `Acción '${action}' omitida` };
    }

    const username = String(payload?.username || '').trim();
    if (!username) {
      return { ignored: true, reason: 'Payload sin username' };
    }

    const device = await this.ftpDeviceModel.findOne({ where: { username } });
    if (!device) {
      this.logger.warn(
        `Webhook SFTPGo recibido para usuario desconocido '${username}'.`,
      );
      return { ignored: true, reason: 'Usuario FTP no registrado' };
    }

    const company = await this.companyModel.findByPk(device.companyId, {
      attributes: ['id', 'status'],
    });
    if (!company || company.status !== CompanyStatus.ACTIVE) {
      return { ignored: true, reason: 'Compañía inactiva o suspendida' };
    }

    const reportedPath =
      payload?.virtual_path || payload?.path || payload?.fs_path || '';
    const resolvedFullPath = resolveInboxFileFromWebhook(
      device.companyId,
      reportedPath,
      device.subFolder,
    );

    if (!resolvedFullPath) {
      this.logger.warn(
        `No se pudo resolver ruta segura para webhook '${reportedPath}' (company_${device.companyId}).`,
      );
      return { ignored: true, reason: 'Ruta de archivo fuera de scope' };
    }

    const result = await this.inboxWatcherService.ingestSingleInboxFile(
      device.companyId,
      resolvedFullPath,
      undefined,
      true,
      { id: device.id, deviceName: device.deviceName },
    );

    return {
      processed: true,
      companyId: device.companyId,
      deviceId: device.id,
      status: result.status,
      documentId: result.document?.id ?? null,
    };
  }
}
