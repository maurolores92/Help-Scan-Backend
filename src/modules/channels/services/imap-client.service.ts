import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import sanitizeHtml = require('sanitize-html');

export interface ImapConnectionParams {
  host: string;
  port: number;
  secure: boolean;
  emailUser: string;
  password: string;
  folder?: string;
}

export interface ParsedEmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface FetchedEmailItem {
  uid: number;
  messageId: string;
  senderName: string | null;
  senderEmail: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
  bodyHtmlSanitized: string | null;
  attachments: ParsedEmailAttachment[];
}

@Injectable()
export class ImapClientService {
  private readonly logger = new Logger(ImapClientService.name);

  private createClient(params: ImapConnectionParams): ImapFlow {
    return new ImapFlow({
      host: params.host.trim(),
      port: Number(params.port) || 993,
      secure: params.secure !== false,
      auth: {
        user: params.emailUser.trim(),
        pass: params.password,
      },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }

  /**
   * Sanitiza HTML de correos externos para prevenir XSS y scripts maliciosos
   * antes de guardarlo en la base de datos o mostrarlo en el frontend.
   */
  sanitizeEmailHtml(rawHtml?: string | false | null): string | null {
    if (!rawHtml || typeof rawHtml !== 'string') return null;

    const clean = sanitizeHtml(rawHtml, {
      allowedTags: [
        'p',
        'br',
        'b',
        'i',
        'strong',
        'em',
        'u',
        's',
        'h1',
        'h2',
        'h3',
        'h4',
        'ul',
        'ol',
        'li',
        'blockquote',
        'pre',
        'code',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'div',
        'span',
        'a',
        'hr',
      ],
      allowedAttributes: {
        a: ['href', 'target', 'rel'],
        td: ['colspan', 'rowspan', 'align'],
        th: ['colspan', 'rowspan', 'align'],
        '*': ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', {
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        }),
      },
    });

    return clean.trim() || null;
  }

  /**
   * Prueba la conexión IMAP en tiempo real verificando credenciales y buzón.
   */
  async testConnection(params: ImapConnectionParams): Promise<{
    ok: boolean;
    message: string;
    totalMessages: number;
    unreadCount: number;
    folder: string;
  }> {
    const client = this.createClient(params);
    const folder = (params.folder || 'INBOX').trim() || 'INBOX';

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const mailboxInfo = client.mailbox as any;
        const totalMessages = Number(mailboxInfo?.exists || 0);
        const unseenUids = await client.search({ seen: false }, { uid: true });
        const unreadCount = Array.isArray(unseenUids) ? unseenUids.length : 0;

        return {
          ok: true,
          folder,
          totalMessages,
          unreadCount,
          message: `Conexión IMAP exitosa con '${folder}'. ${totalMessages} correo(s) en buzón, ${unreadCount} no leído(s).`,
        };
      } finally {
        lock.release();
      }
    } catch (err: any) {
      this.logger.warn(`Fallo test IMAP para ${params.emailUser}@${params.host}: ${err?.message}`);
      throw new Error(
        this.formatImapError(err, params.host, params.port),
      );
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Lee los últimos `maxBatch` correos no leídos de la carpeta configurada.
   * Cuando se indica `shouldProcessSender`, los correos de remitentes no autorizados
   * se omiten sin descargarse ni marcarse como leídos en la casilla.
   */
  async fetchUnreadEmails(
    params: ImapConnectionParams,
    options?: {
      maxBatch?: number;
      markAsRead?: boolean;
      shouldProcessSender?: (senderEmail: string) => boolean;
    },
  ): Promise<FetchedEmailItem[]> {
    const client = this.createClient(params);
    const folder = (params.folder || 'INBOX').trim() || 'INBOX';
    const maxBatch = options?.maxBatch ?? 15;
    const markAsRead = options?.markAsRead ?? true;
    const shouldProcessSender = options?.shouldProcessSender;
    const fetched: FetchedEmailItem[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const searchResult = await client.search({ seen: false }, { uid: true });
        const validUids = Array.isArray(searchResult)
          ? searchResult.filter((u) => Number.isInteger(u) && u > 0)
          : [];

        if (validUids.length === 0) {
          return [];
        }

        let targetUids = validUids.slice(-maxBatch);

        if (shouldProcessSender) {
          const envelopeWindowUids = validUids.slice(-Math.max(maxBatch * 5, 100));
          const envelopes = await client.fetchAll(
            envelopeWindowUids,
            { uid: true, envelope: true },
            { uid: true },
          );
          const candidateUids: number[] = [];

          for (const envMsg of envelopes) {
            if (!Number.isInteger(envMsg.uid) || envMsg.uid <= 0) continue;
            const rawAddress = envMsg.envelope?.from?.[0]?.address;
            if (!rawAddress) {
              candidateUids.push(envMsg.uid);
              continue;
            }
            if (shouldProcessSender(rawAddress.toLowerCase().trim())) {
              candidateUids.push(envMsg.uid);
            }
          }

          if (candidateUids.length === 0) {
            return [];
          }
          targetUids = candidateUids.slice(-maxBatch);
        }

        // Procesar los más recientes primero en lotes acotados para evitar timeouts
        const rawMessages = await client.fetchAll(
          targetUids,
          { uid: true, source: true },
          { uid: true },
        );

        const seenUidsToMark: number[] = [];

        for (const message of rawMessages) {
          if (!message.source) continue;

          try {
            const parsed: ParsedMail = await simpleParser(message.source);
            const fromFirst = parsed.from?.value?.[0];
            const senderEmail = (fromFirst?.address || 'desconocido@correo.local').toLowerCase().trim();
            if (shouldProcessSender && !shouldProcessSender(senderEmail)) {
              continue;
            }
            const senderName = fromFirst?.name?.trim() || null;

            const messageId =
              parsed.messageId?.trim() ||
              `uid-${message.uid}-${(parsed.date || new Date()).getTime()}`;

            const bodyText = (parsed.text || '').trim();
            const htmlRaw = typeof parsed.html === 'string' ? parsed.html : null;
            const bodyHtmlSanitized = this.sanitizeEmailHtml(htmlRaw);

            const attachments: ParsedEmailAttachment[] = (parsed.attachments || [])
              .filter((att) => Buffer.isBuffer(att.content) && att.content.length > 0)
              .map((att, idx) => ({
                filename: att.filename || `adjunto_${idx + 1}`,
                contentType: (att.contentType || 'application/octet-stream').toLowerCase(),
                size: att.size || att.content.length,
                content: att.content,
              }));

            fetched.push({
              uid: message.uid,
              messageId: messageId.slice(0, 250),
              senderName: senderName ? senderName.slice(0, 250) : null,
              senderEmail: senderEmail.slice(0, 250),
              subject: (parsed.subject || '(Sin asunto)').trim().slice(0, 490),
              receivedAt: parsed.date || new Date(),
              bodyText,
              bodyHtmlSanitized,
              attachments,
            });

            if (markAsRead && Number.isInteger(message.uid) && message.uid > 0) {
              seenUidsToMark.push(message.uid);
            }
          } catch (parseErr: any) {
            this.logger.warn(
              `Error parseando correo UID ${message.uid} en ${params.emailUser}: ${parseErr?.message}`,
            );
          }
        }

        // Ejecutar comando STORE fuera del fetch para evitar deadlocks en imapflow
        if (markAsRead && seenUidsToMark.length > 0) {
          await client.messageFlagsAdd(seenUidsToMark, ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      throw new Error(this.formatImapError(err, params.host, params.port));
    } finally {
      await client.logout().catch(() => {});
    }

    return fetched;
  }

  /**
   * Mantiene una sesión IMAP IDLE abierta en tiempo real y dispara `onExistsChange`
   * apenas ingresa un correo nuevo a la casilla sin esperar al intervalo del cron.
   */
  async watchMailboxIdle(
    params: ImapConnectionParams,
    onExistsChange: () => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<void> {
    const client = this.createClient(params);
    const folder = (params.folder || 'INBOX').trim() || 'INBOX';

    const onAbort = () => {
      client.logout().catch(() => {
        try {
          client.close();
        } catch { }
      });
    };

    if (signal.aborted) return;
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        let debounceTimer: NodeJS.Timeout | null = null;
        client.on('exists', () => {
          if (signal.aborted) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            Promise.resolve(onExistsChange()).catch((err) => {
              this.logger.warn(
                `[IMAP IDLE] Error disparando sync en ${params.emailUser}: ${err?.message}`,
              );
            });
          }, 800);
        });

        while (!signal.aborted && client.usable) {
          await client.idle();
        }
      } finally {
        lock.release();
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      await client.logout().catch(() => {
        try {
          client.close();
        } catch { }
      });
    }
  }

  private formatImapError(err: any, host: string, port: number): string {
    const rawMsg = String(err?.responseText || err?.message || 'Error desconocido');
    if (/Invalid credentials|AUTHENTICATIONFAILED|Application-specific password required/i.test(rawMsg)) {
      return 'Credenciales rechazadas por el servidor. Si usas Gmail u Outlook con verificación en 2 pasos, debes usar una Contraseña de Aplicación (App Password).';
    }
    if (/ENOTFOUND|getaddrinfo/i.test(rawMsg)) {
      return `No se pudo resolver el servidor IMAP '${host}'. Verifica el nombre del host.`;
    }
    if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(rawMsg)) {
      return `No hubo respuesta del servidor IMAP '${host}:${port}'. Verifica puerto y SSL/TLS.`;
    }
    return `Error IMAP (${host}:${port}): ${rawMsg}`;
  }
}
