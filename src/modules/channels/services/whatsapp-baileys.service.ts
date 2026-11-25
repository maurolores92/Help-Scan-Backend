import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import * as QRCode from 'qrcode';
import pino from 'pino';
import {
  CompanyWhatsappChannel,
  WhatsappConnectionStatus,
  WhatsappSyncStatus,
} from '../models/company-whatsapp-channel.model';
import { Company, CompanyStatus } from '../../companies/company.model';
import { NotificationsGateway } from '../../notifications/notifications.gateway';
import { getTenantWhatsappSessionPath } from '../../../common/utils/storage-path.util';
import { extractWhatsappAttachmentInfo } from '../helpers/whatsapp-message.helper';

export interface WhatsappRuntimeSnapshot {
  companyId: number;
  connectionStatus: WhatsappConnectionStatus;
  qrDataUrl: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  lastError: string | null;
}

type IncomingMessagesHandler = (
  companyId: number,
  messages: any[],
) => Promise<void>;

interface ActiveSessionEntry {
  sock: any;
  connectionStatus: WhatsappConnectionStatus;
  qrDataUrl: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  lastError: string | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  manuallyStopped: boolean;
}

@Injectable()
export class WhatsappBaileysService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsappBaileysService.name);
  private readonly sessions = new Map<number, ActiveSessionEntry>();
  private readonly connectingLocks = new Set<number>();
  private readonly groupSubjectCache = new Map<number, Map<string, string>>();
  private incomingHandler: IncomingMessagesHandler | null = null;
  private baileysModulePromise: Promise<any> | null = null;

  constructor(
    @InjectModel(CompanyWhatsappChannel)
    private readonly whatsappChannelModel: typeof CompanyWhatsappChannel,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    @Optional() private readonly gateway?: NotificationsGateway,
  ) {}

  registerIncomingMessagesHandler(handler: IncomingMessagesHandler): void {
    this.incomingHandler = handler;
  }

  private async loadBaileys(): Promise<any> {
    if (!this.baileysModulePromise) {
      // Carga dinámica ESM segura para Node 22 + nodenext y compatible con Jest
      this.baileysModulePromise = Function(
        'return import("@whiskeysockets/baileys")',
      )();
    }
    return this.baileysModulePromise;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_WHATSAPP_SESSIONS === 'true'
    ) {
      return;
    }

    try {
      const channels = await this.whatsappChannelModel.findAll({
        where: { isActive: true },
      });

      for (const ch of channels) {
        const sessionDir = getTenantWhatsappSessionPath(ch.companyId);
        const credsPath = join(sessionDir, 'creds.json');
        if (!existsSync(credsPath)) {
          continue;
        }

        const company = await this.companyModel.findByPk(ch.companyId, {
          attributes: ['id', 'status', 'enabledModules'],
        });
        const enabledModules = Array.isArray(company?.enabledModules)
          ? company.enabledModules
          : [];

        if (
          !company ||
          company.status !== CompanyStatus.ACTIVE ||
          !enabledModules.includes('whatsapp')
        ) {
          continue;
        }

        this.logger.log(
          `📲 [WhatsApp] Restaurando sesión persistente para compañía #${ch.companyId}...`,
        );
        this.startSession(ch.companyId).catch((err) => {
          this.logger.warn(
            `[WhatsApp] No se pudo restaurar sesión de compañía #${ch.companyId}: ${err?.message}`,
          );
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `[WhatsApp] Error restaurando sesiones al iniciar: ${err?.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [companyId, entry] of this.sessions.entries()) {
      entry.manuallyStopped = true;
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      try {
        entry.sock?.end?.(undefined);
      } catch {}
      this.sessions.delete(companyId);
    }
  }

  getRuntimeSnapshot(
    companyId: number,
    channel?: CompanyWhatsappChannel | null,
  ): WhatsappRuntimeSnapshot {
    const active = this.sessions.get(companyId);
    if (active) {
      return {
        companyId,
        connectionStatus: active.connectionStatus,
        qrDataUrl: active.qrDataUrl,
        connectedPhone:
          active.connectedPhone || channel?.connectedPhone || null,
        connectedName: active.connectedName || channel?.connectedName || null,
        lastError: active.lastError,
      };
    }

    return {
      companyId,
      connectionStatus:
        channel?.connectionStatus === WhatsappConnectionStatus.CONNECTED
          ? WhatsappConnectionStatus.DISCONNECTED
          : channel?.connectionStatus || WhatsappConnectionStatus.DISCONNECTED,
      qrDataUrl: null,
      connectedPhone: channel?.connectedPhone || null,
      connectedName: channel?.connectedName || null,
      lastError: null,
    };
  }

  private emitRealtimeState(companyId: number): void {
    const snapshot = this.getRuntimeSnapshot(companyId);
    this.gateway?.emitToCompany(companyId, 'whatsapp:status', snapshot);
  }

  async startSession(companyId: number): Promise<WhatsappRuntimeSnapshot> {
    if (this.connectingLocks.has(companyId)) {
      return this.getRuntimeSnapshot(companyId);
    }

    const existing = this.sessions.get(companyId);
    if (
      existing &&
      (existing.connectionStatus === WhatsappConnectionStatus.CONNECTED ||
        existing.connectionStatus === WhatsappConnectionStatus.QR_READY ||
        existing.connectionStatus === WhatsappConnectionStatus.CONNECTING)
    ) {
      return this.getRuntimeSnapshot(companyId);
    }

    this.connectingLocks.add(companyId);
    try {
      // Cerrar cualquier socket residual previo
      if (existing) {
        existing.manuallyStopped = true;
        if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
        try {
          existing.sock?.end?.(undefined);
        } catch {}
        this.sessions.delete(companyId);
      }

      const baileys = await this.loadBaileys();
      const makeWASocket = baileys.default || baileys.makeWASocket;
      const {
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason,
        Browsers,
      } = baileys;

      const sessionDir = getTenantWhatsappSessionPath(companyId);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      let waVersion: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestBaileysVersion();
        waVersion = latest?.version;
      } catch {
        waVersion = undefined;
      }

      const sock = makeWASocket({
        ...(waVersion ? { version: waVersion } : {}),
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('HC-Scan'),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      const entry: ActiveSessionEntry = {
        sock,
        connectionStatus: WhatsappConnectionStatus.CONNECTING,
        qrDataUrl: null,
        connectedPhone: null,
        connectedName: null,
        lastError: null,
        reconnectTimer: null,
        reconnectAttempts: 0,
        manuallyStopped: false,
      };
      this.sessions.set(companyId, entry);

      await this.whatsappChannelModel.update(
        {
          connectionStatus: WhatsappConnectionStatus.CONNECTING,
          lastSyncStatus: WhatsappSyncStatus.IDLE,
          lastSyncMessage: 'Iniciando sesión WhatsApp...',
        },
        { where: { companyId } },
      );
      this.emitRealtimeState(companyId);

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err: any) {
          this.logger.warn(
            `[WhatsApp company_${companyId}] Error guardando credenciales: ${err?.message}`,
          );
        }
      });

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update || {};

        if (qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, {
              width: 280,
              margin: 2,
            });
            entry.connectionStatus = WhatsappConnectionStatus.QR_READY;
            entry.qrDataUrl = qrDataUrl;
            entry.lastError = null;

            await this.whatsappChannelModel.update(
              {
                connectionStatus: WhatsappConnectionStatus.QR_READY,
                lastQrAt: new Date(),
                lastSyncMessage:
                  'Código QR generado. Escanealo desde WhatsApp en tu celular.',
              },
              { where: { companyId } },
            );
            this.emitRealtimeState(companyId);
          } catch (qrErr: any) {
            this.logger.warn(
              `[WhatsApp company_${companyId}] Error generando QR PNG: ${qrErr?.message}`,
            );
          }
        }

        if (connection === 'connecting') {
          entry.connectionStatus = WhatsappConnectionStatus.CONNECTING;
          this.emitRealtimeState(companyId);
        }

        if (connection === 'open') {
          const rawJid = String(sock?.user?.id || '');
          const cleanPhone = rawJid
            .split(':')[0]
            .split('@')[0]
            .replace(/\D+/g, '');
          const cleanName = sock?.user?.name || null;

          entry.connectionStatus = WhatsappConnectionStatus.CONNECTED;
          entry.qrDataUrl = null;
          entry.connectedPhone = cleanPhone || null;
          entry.connectedName = cleanName;
          entry.lastError = null;
          entry.reconnectAttempts = 0;

          await this.whatsappChannelModel.update(
            {
              connectionStatus: WhatsappConnectionStatus.CONNECTED,
              connectedPhone: cleanPhone || null,
              connectedName: cleanName,
              lastSyncStatus: WhatsappSyncStatus.OK,
              lastSyncMessage: `Conectado como ${cleanName || cleanPhone || 'WhatsApp'}`,
            },
            { where: { companyId } },
          );
          this.emitRealtimeState(companyId);
          this.logger.log(
            `✅ [WhatsApp] Compañía #${companyId} conectada (+${cleanPhone})`,
          );
        }

        if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.statusCode;
          const errorMessage =
            lastDisconnect?.error?.message || 'Conexión cerrada';
          const isLoggedOut =
            statusCode === DisconnectReason.loggedOut || statusCode === 401;

          entry.qrDataUrl = null;

          if (entry.manuallyStopped) {
            return;
          }

          if (isLoggedOut) {
            this.clearSessionFiles(companyId);
            entry.connectionStatus = WhatsappConnectionStatus.DISCONNECTED;
            entry.connectedPhone = null;
            entry.connectedName = null;
            entry.lastError =
              'La sesión fue cerrada desde el celular. Escaneá un nuevo QR para reconectar.';
            this.sessions.delete(companyId);

            await this.whatsappChannelModel.update(
              {
                connectionStatus: WhatsappConnectionStatus.DISCONNECTED,
                connectedPhone: null,
                connectedName: null,
                lastSyncStatus: WhatsappSyncStatus.ERROR,
                lastSyncMessage: entry.lastError,
              },
              { where: { companyId } },
            );
            this.emitRealtimeState(companyId);
            return;
          }

          // Reconexión automática ante cortes transitorios o restartRequired (515)
          const channel = await this.whatsappChannelModel.findOne({
            where: { companyId },
            attributes: ['id', 'isActive'],
          });

          if (channel?.isActive && entry.reconnectAttempts < 6) {
            entry.reconnectAttempts += 1;
            const delayMs =
              statusCode === DisconnectReason.restartRequired
                ? 800
                : Math.min(15000, entry.reconnectAttempts * 2500);

            entry.connectionStatus = WhatsappConnectionStatus.CONNECTING;
            entry.lastError = `Reconectando (${entry.reconnectAttempts}/6)...`;
            this.emitRealtimeState(companyId);

            this.sessions.delete(companyId);
            const timer = setTimeout(() => {
              this.startSession(companyId).catch((err) => {
                this.logger.warn(
                  `[WhatsApp company_${companyId}] Reintento fallido: ${err?.message}`,
                );
              });
            }, delayMs);
            entry.reconnectTimer = timer;
          } else {
            entry.connectionStatus = WhatsappConnectionStatus.ERROR;
            entry.lastError = errorMessage;
            this.sessions.delete(companyId);

            await this.whatsappChannelModel.update(
              {
                connectionStatus: WhatsappConnectionStatus.ERROR,
                lastSyncStatus: WhatsappSyncStatus.ERROR,
                lastSyncMessage: errorMessage,
              },
              { where: { companyId } },
            );
            this.emitRealtimeState(companyId);
          }
        }
      });

      sock.ev.on('messages.upsert', async (upsert: any) => {
        if (upsert?.type !== 'notify' || !Array.isArray(upsert?.messages)) {
          return;
        }
        // Filtrar en origen: solo mensajes con adjunto (en grupos permitimos también fromMe para grupos autorizados)
        const attachmentMessages = upsert.messages.filter((m: any) => {
          if (!m) return false;
          const jid = String(m?.key?.remoteJid || '').trim();
          if (!jid || jid === 'status@broadcast') return false;
          const isGroup = jid.endsWith('@g.us');
          if (m?.key?.fromMe && !isGroup) return false;
          return extractWhatsappAttachmentInfo(m.message).hasAttachment;
        });

        if (attachmentMessages.length > 0 && this.incomingHandler) {
          this.logger.log(
            `[WhatsApp company_${companyId}] ${attachmentMessages.length} mensaje(s) con adjunto recibido(s): ${attachmentMessages
              .map((m: any) => `${m?.key?.remoteJid}${m?.key?.fromMe ? ' (fromMe)' : ''}`)
              .join(', ')}`,
          );
          await this.incomingHandler(companyId, attachmentMessages).catch(
            (err) => {
              this.logger.error(
                `[WhatsApp company_${companyId}] Error procesando mensajes entrantes: ${err?.message}`,
              );
            },
          );
        }
      });

      return this.getRuntimeSnapshot(companyId);
    } finally {
      this.connectingLocks.delete(companyId);
    }
  }

  async disconnectSession(
    companyId: number,
    clearFiles = true,
  ): Promise<void> {
    const entry = this.sessions.get(companyId);
    if (entry) {
      entry.manuallyStopped = true;
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      try {
        if (clearFiles) {
          await entry.sock?.logout?.().catch(() => {});
        }
        entry.sock?.end?.(undefined);
      } catch {}
      this.sessions.delete(companyId);
    }

    if (clearFiles) {
      this.clearSessionFiles(companyId);
    }

    await this.whatsappChannelModel.update(
      {
        connectionStatus: WhatsappConnectionStatus.DISCONNECTED,
        connectedPhone: clearFiles ? null : undefined,
        connectedName: clearFiles ? null : undefined,
        lastSyncStatus: WhatsappSyncStatus.IDLE,
        lastSyncMessage: 'Sesión desconectada manualmente.',
      },
      { where: { companyId } },
    );
    this.emitRealtimeState(companyId);
  }

  private clearSessionFiles(companyId: number): void {
    try {
      const dir = getTenantWhatsappSessionPath(companyId);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err: any) {
      this.logger.warn(
        `[WhatsApp company_${companyId}] No se pudo limpiar carpeta de sesión: ${err?.message}`,
      );
    }
  }

  async downloadMessageMedia(
    companyId: number,
    waMessage: any,
  ): Promise<Buffer> {
    const baileys = await this.loadBaileys();
    const { downloadMediaMessage } = baileys;
    const entry = this.sessions.get(companyId);

    const buffer = await downloadMediaMessage(
      waMessage,
      'buffer',
      {},
      entry?.sock
        ? {
            logger: pino({ level: 'silent' }),
            reuploadRequest: entry.sock.updateMediaMessage,
          }
        : undefined,
    );

    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  }

  async sendTextMessage(
    companyId: number,
    toJidOrPhone: string,
    text: string,
  ): Promise<void> {
    const entry = this.sessions.get(companyId);
    if (!entry?.sock || entry.connectionStatus !== WhatsappConnectionStatus.CONNECTED) {
      return;
    }

    const jid = toJidOrPhone.includes('@')
      ? toJidOrPhone
      : `${toJidOrPhone.replace(/\D+/g, '')}@s.whatsapp.net`;

    await entry.sock.sendMessage(jid, {
      text: text.slice(0, 4000),
    });
  }

  /**
   * Lista todos los grupos en los que participa la sesión conectada de WhatsApp.
   */
  async listParticipatingGroups(companyId: number): Promise<{
    connected: boolean;
    groups: Array<{ jid: string; name: string; participantsCount: number }>;
  }> {
    const entry = this.sessions.get(companyId);
    if (
      !entry?.sock ||
      entry.connectionStatus !== WhatsappConnectionStatus.CONNECTED
    ) {
      return { connected: false, groups: [] };
    }

    try {
      const participating = await entry.sock.groupFetchAllParticipating();
      const cache =
        this.groupSubjectCache.get(companyId) || new Map<string, string>();
      const list = Object.values(participating || {})
        .map((g: any) => {
          const jid = String(g?.id || '').trim();
          const name = String(g?.subject || jid).trim();
          const participantsCount = Array.isArray(g?.participants)
            ? g.participants.length
            : 0;
          if (jid && name) cache.set(jid, name);
          return { jid, name, participantsCount };
        })
        .filter((g) => g.jid.endsWith('@g.us'))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));

      this.groupSubjectCache.set(companyId, cache);
      return { connected: true, groups: list };
    } catch (err: any) {
      this.logger.warn(
        `[WhatsApp company_${companyId}] Error listando grupos: ${err?.message}`,
      );
      return { connected: true, groups: [] };
    }
  }

  /**
   * Resuelve el asunto/nombre de un grupo a partir de caché o metadata de Baileys.
   */
  async resolveGroupSubject(
    companyId: number,
    groupJid: string,
  ): Promise<string | null> {
    const cached = this.groupSubjectCache.get(companyId)?.get(groupJid);
    if (cached) return cached;

    const entry = this.sessions.get(companyId);
    if (
      !entry?.sock ||
      entry.connectionStatus !== WhatsappConnectionStatus.CONNECTED
    ) {
      return null;
    }

    try {
      const meta = await entry.sock.groupMetadata(groupJid);
      const subject = meta?.subject ? String(meta.subject).trim() : null;
      if (subject) {
        const cache =
          this.groupSubjectCache.get(companyId) || new Map<string, string>();
        cache.set(groupJid, subject);
        this.groupSubjectCache.set(companyId, cache);
      }
      return subject;
    } catch {
      return null;
    }
  }
}
