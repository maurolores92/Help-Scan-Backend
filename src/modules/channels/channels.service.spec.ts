jest.mock('sanitize-html', () => jest.fn((html: string) => html));

import { BadRequestException } from '@nestjs/common';
import { ChannelsService } from './services/channels.service';
import { ImapClientService } from './services/imap-client.service';
import {
  EmailProviderType,
  EmailSenderPolicy,
  EmailSyncStatus,
} from './models/company-email-channel.model';
import { CompanyStatus } from '../companies/company.model';

describe('ChannelsService (Lista Blanca de Correo IMAP & Webhook)', () => {
  const buildService = (overrides?: {
    emailChannelModel?: any;
    emailMessageModel?: any;
    companyModel?: any;
    imapClient?: any;
    documentsService?: any;
  }) => {
    const emailChannelModel = overrides?.emailChannelModel || {
      findOne: jest.fn(),
      create: jest.fn(),
    };
    const emailMessageModel = overrides?.emailMessageModel || {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const companyModel = overrides?.companyModel || {
      findByPk: jest.fn().mockResolvedValue({
        id: 10,
        status: CompanyStatus.ACTIVE,
        enabledModules: ['documents', 'email'],
      }),
    };
    const imapClient = overrides?.imapClient || {
      fetchUnreadEmails: jest.fn().mockResolvedValue([]),
      sanitizeEmailHtml: jest.fn((h) => h || null),
    };
    const documentsService = overrides?.documentsService || {
      ingestPdfFromChannel: jest.fn().mockResolvedValue({
        document: { id: 901 },
        isDuplicate: false,
      }),
    };

    const service = new ChannelsService(
      emailChannelModel,
      emailMessageModel,
      companyModel,
      imapClient,
      documentsService,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    return {
      service,
      emailChannelModel,
      emailMessageModel,
      imapClient,
      documentsService,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('guarda lista blanca normalizada (correos y dominios) y rechaza lista vacía o inválida', async () => {
    const existingChannel: any = {
      id: 5,
      companyId: 10,
      encryptedPassword: 'enc',
      webhookSecret: 'sec123',
      senderPolicy: EmailSenderPolicy.ALL,
      allowedSenders: [],
      update: jest.fn().mockImplementation(async function (this: any, patch: any) {
        Object.assign(this, patch);
        return this;
      }),
      toJSON: function () {
        return { ...this };
      },
    };

    const { service } = buildService({
      emailChannelModel: {
        findOne: jest.fn().mockResolvedValue(existingChannel),
      },
    });

    await expect(
      service.upsertEmailChannelConfig(
        {
          provider: EmailProviderType.GMAIL,
          host: 'imap.gmail.com',
          port: 993,
          emailUser: 'buzon@miempresa.com',
          senderPolicy: EmailSenderPolicy.WHITELIST,
          allowedSenders: [],
        },
        { id: 1, companyId: 10, role: 'company_admin' },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.upsertEmailChannelConfig(
        {
          provider: EmailProviderType.GMAIL,
          host: 'imap.gmail.com',
          port: 993,
          emailUser: 'buzon@miempresa.com',
          senderPolicy: EmailSenderPolicy.WHITELIST,
          allowedSenders: ['no-es-valido'],
        },
        { id: 1, companyId: 10, role: 'company_admin' },
      ),
    ).rejects.toThrow(BadRequestException);

    const saved = await service.upsertEmailChannelConfig(
      {
        provider: EmailProviderType.GMAIL,
        host: 'imap.gmail.com',
        port: 993,
        emailUser: 'buzon@miempresa.com',
        senderPolicy: EmailSenderPolicy.WHITELIST,
        allowedSenders: ['Facturas@Proveedor.com', 'banco.com.ar'],
      },
      { id: 1, companyId: 10, role: 'company_admin' },
    );

    expect(saved.channel.senderPolicy).toBe(EmailSenderPolicy.WHITELIST);
    expect(saved.channel.allowedSenders).toEqual([
      'facturas@proveedor.com',
      '@banco.com.ar',
    ]);
  });

  it('pasa filtro shouldProcessSender a IMAP para dejar sin leer los correos no autorizados y no guardarlos en DB', async () => {
    const channel: any = {
      id: 5,
      companyId: 10,
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      emailUser: 'buzon@miempresa.com',
      encryptedPassword: 'enc',
      folder: 'INBOX',
      markAsRead: true,
      processBodyWithoutAttachments: false,
      senderPolicy: EmailSenderPolicy.WHITELIST,
      allowedSenders: ['facturas@exacto.com', '@proveedor.com'],
      lastSyncStatus: EmailSyncStatus.IDLE,
      update: jest.fn().mockResolvedValue(undefined),
    };

    const imapClient = {
      fetchUnreadEmails: jest.fn().mockImplementation(async (_params, opts) => {
        // Verifica el callback real pasado a ImapClientService
        expect(typeof opts.shouldProcessSender).toBe('function');
        expect(opts.shouldProcessSender('spam@otro.com')).toBe(false);
        expect(opts.shouldProcessSender('facturas@exacto.com')).toBe(true);
        expect(opts.shouldProcessSender('cobros@proveedor.com')).toBe(true);

        return [
          {
            uid: 101,
            messageId: 'msg-unauth',
            senderName: 'Spam',
            senderEmail: 'spam@otro.com',
            subject: 'Promo',
            receivedAt: new Date(),
            bodyText: '',
            bodyHtmlSanitized: null,
            attachments: [
              {
                filename: 'promo.pdf',
                contentType: 'application/pdf',
                size: 10,
                content: Buffer.from('%PDF-1.7\nspam'),
              },
            ],
          },
          {
            uid: 102,
            messageId: 'msg-auth',
            senderName: 'Proveedor',
            senderEmail: 'cobros@proveedor.com',
            subject: 'Factura A',
            receivedAt: new Date(),
            bodyText: '',
            bodyHtmlSanitized: null,
            attachments: [
              {
                filename: 'factura.pdf',
                contentType: 'application/pdf',
                size: 10,
                content: Buffer.from('%PDF-1.7\nok'),
              },
            ],
          },
        ];
      }),
    };

    const createdEmails: any[] = [];
    const emailMessageModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (payload) => {
        const rec = {
          id: 50 + createdEmails.length,
          ...payload,
          update: jest.fn().mockResolvedValue(undefined),
        };
        createdEmails.push(rec);
        return rec;
      }),
    };

    const { service, documentsService } = buildService({
      emailChannelModel: { findOne: jest.fn().mockResolvedValue(channel) },
      emailMessageModel,
      imapClient,
    });

    const vaultCrypto = require('../../common/utils/vault-crypto.util');
    jest.spyOn(vaultCrypto, 'decryptFtpSecret').mockReturnValue('secret');

    const res: any = await service.syncCompanyEmailChannel(10);

    expect(res.processedEmails).toBe(1);
    expect(createdEmails).toHaveLength(1);
    expect(createdEmails[0].senderEmail).toBe('cobros@proveedor.com');
    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledTimes(1);
  });

  it('ignora por completo remitentes no autorizados en Webhook sin guardar registro ni documento', async () => {
    const channel: any = {
      id: 5,
      companyId: 10,
      webhookSecret: 'secret-token-123',
      processBodyWithoutAttachments: true,
      senderPolicy: EmailSenderPolicy.WHITELIST,
      allowedSenders: ['@autorizado.com'],
      update: jest.fn().mockResolvedValue(undefined),
    };

    const { service, emailMessageModel, documentsService } = buildService({
      emailChannelModel: {
        findOne: jest.fn().mockResolvedValue(channel),
        findAll: jest.fn().mockResolvedValue([channel]),
      },
    });

    const res = await service.ingestEmailFromWebhook(10, 'secret-token-123', {
      from: 'intruso@desconocido.com',
      subject: 'Factura falsa',
      text: 'Transferencia $1000',
    });

    expect(res.ok).toBe(true);
    expect(res.ignoredUnauthorized).toBe(true);
    expect(res.emailMessageId).toBeNull();
    expect(res.createdDocuments).toBe(0);
    expect(emailMessageModel.create).not.toHaveBeenCalled();
    expect(documentsService.ingestPdfFromChannel).not.toHaveBeenCalled();
  });

  it('ImapClientService deja sin leer los UIDs de remitentes no autorizados y solo marca Seen los autorizados', async () => {
    const rawMimeFrom = (from: string, subject: string) =>
      Buffer.from(
        `From: ${from}\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@test>\r\nContent-Type: text/plain\r\n\r\nCuerpo`,
      );

    const mockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      getMailboxLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
      search: jest.fn().mockResolvedValue([10, 11]),
      fetchAll: jest.fn().mockImplementation(async (uids: number[], attrs: any) => {
        if (attrs.envelope) {
          return [
            { uid: 10, envelope: { from: [{ address: 'newsletter@ajeno.com' }] } },
            { uid: 11, envelope: { from: [{ address: 'facturas@proveedor.com' }] } },
          ].filter((m) => uids.includes(m.uid));
        }
        return [
          { uid: 11, source: rawMimeFrom('facturas@proveedor.com', 'Factura 001') },
        ].filter((m) => uids.includes(m.uid));
      }),
      messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    const imapService = new ImapClientService();
    jest.spyOn(imapService as any, 'createClient').mockReturnValue(mockClient);

    const items = await imapService.fetchUnreadEmails(
      {
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        emailUser: 'buzon@miempresa.com',
        password: 'pwd',
      },
      {
        maxBatch: 20,
        markAsRead: true,
        shouldProcessSender: (email) => email.endsWith('@proveedor.com'),
      },
    );

    expect(items).toHaveLength(1);
    expect(items[0].senderEmail).toBe('facturas@proveedor.com');
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith([11], ['\\Seen'], {
      uid: true,
    });
  });
});
