import {
  normalizeWhatsappPhone,
  WhatsappChannelService,
} from './services/whatsapp-channel.service';
import {
  WhatsappConnectionStatus,
  WhatsappSenderPolicy,
  WhatsappSyncStatus,
} from './models/company-whatsapp-channel.model';
import { WhatsappMessageStatus } from './models/whatsapp-message.model';
import { CompanyStatus } from '../companies/company.model';
import { DocumentSource } from '../documents/document.model';

describe('WhatsappChannelService (QR Baileys)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normaliza teléfonos eliminando JID y caracteres no numéricos', () => {
    expect(normalizeWhatsappPhone('+54 9 11 5555-1234')).toBe('5491155551234');
    expect(normalizeWhatsappPhone('5491155551234:12@s.whatsapp.net')).toBe('5491155551234');
  });

  it('inicia sesión QR para la compañía y retorna el snapshot de runtime', async () => {
    const channelRecord: any = {
      id: 1,
      companyId: 7,
      sessionKey: 'company_7',
      connectionStatus: WhatsappConnectionStatus.DISCONNECTED,
      isActive: true,
      toJSON: () => ({ id: 1, companyId: 7, isActive: true }),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const whatsappChannelModel: any = {
      findOrCreate: jest.fn().mockResolvedValue([channelRecord, true]),
      findOne: jest.fn().mockResolvedValue(channelRecord),
    };

    const baileysService: any = {
      registerIncomingMessagesHandler: jest.fn(),
      startSession: jest.fn().mockResolvedValue(undefined),
      getRuntimeSnapshot: jest.fn().mockReturnValue({
        companyId: 7,
        connectionStatus: WhatsappConnectionStatus.QR_READY,
        qrDataUrl: 'data:image/png;base64,MOCK_QR',
        connectedPhone: null,
        connectedName: null,
        lastError: null,
      }),
    };

    const service = new WhatsappChannelService(
      whatsappChannelModel,
      {} as any,
      {} as any,
      baileysService,
      {} as any,
      { registerPostProcessHook: jest.fn() } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    const res = await service.connectQr({ id: 9, companyId: 7, role: 'company_admin' });

    expect(baileysService.startSession).toHaveBeenCalledWith(7);
    expect(res.runtime.connectionStatus).toBe(WhatsappConnectionStatus.QR_READY);
    expect(res.runtime.qrDataUrl).toBe('data:image/png;base64,MOCK_QR');
  });

  it('procesa PDF entrante, ignora grupos/fromMe y rechaza números fuera de lista blanca', async () => {
    const channelRecord: any = {
      id: 3,
      companyId: 7,
      sessionKey: 'company_7',
      senderPolicy: WhatsappSenderPolicy.WHITELIST,
      allowedPhones: ['5491144445555'],
      ignoreGroups: true,
      isActive: true,
      processImages: true,
      autoReplyConfirmation: false,
      lastSyncStatus: WhatsappSyncStatus.IDLE,
      update: jest.fn().mockResolvedValue(undefined),
    };

    const createdMessages: any[] = [];
    const whatsappChannelModel: any = {
      findOne: jest.fn().mockResolvedValue(channelRecord),
    };
    const whatsappMessageModel: any = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (payload) => {
        const rec: any = {
          id: createdMessages.length + 1,
          ...payload,
          update: jest.fn().mockImplementation(async (patch) => {
            Object.assign(rec, patch);
            return rec;
          }),
        };
        createdMessages.push(rec);
        return rec;
      }),
    };
    const companyModel: any = {
      findByPk: jest.fn().mockResolvedValue({
        id: 7,
        status: CompanyStatus.ACTIVE,
        enabledModules: ['documents', 'whatsapp'],
      }),
    };

    const baileysService: any = {
      registerIncomingMessagesHandler: jest.fn(),
      downloadMessageMedia: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nMocked')),
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
    };

    const documentsService: any = {
      ingestPdfFromChannel: jest.fn().mockResolvedValue({
        document: { id: 505 },
        isDuplicate: false,
      }),
    };

    const service = new WhatsappChannelService(
      whatsappChannelModel,
      whatsappMessageModel,
      companyModel,
      baileysService,
      documentsService,
      { registerPostProcessHook: jest.fn() } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await service.handleIncomingBaileysMessages(7, [
      // 1. Mensaje propio saliente -> debe ignorarse
      {
        key: { id: 'wa.fromme', fromMe: true, remoteJid: '5491144445555@s.whatsapp.net' },
        message: { conversation: 'hola' },
      },
      // 2. Mensaje de grupo -> debe ignorarse porque ignoreGroups = true
      {
        key: { id: 'wa.group', fromMe: false, remoteJid: '120363000@g.us' },
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'grupo.pdf' },
        },
      },
      // 3. Remitente autorizado con PDF envuelto en documentWithCaptionMessage
      {
        key: { id: 'wa.valid', fromMe: false, remoteJid: '5491144445555@s.whatsapp.net' },
        pushName: 'Juan Chofer',
        messageTimestamp: 1763590000,
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                mimetype: 'application/pdf',
                fileName: 'remito_001.pdf',
                caption: 'Remito entregado',
              },
            },
          },
        },
      },
      // 4. Remitente NO autorizado
      {
        key: { id: 'wa.intruder', fromMe: false, remoteJid: '5491199990000@s.whatsapp.net' },
        pushName: 'Desconocido',
        messageTimestamp: 1763590010,
        message: {
          documentMessage: {
            mimetype: 'application/pdf',
            fileName: 'intruso.pdf',
          },
        },
      },
    ]);

    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledTimes(1);
    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 7,
        originalName: 'remito_001.pdf',
        source: DocumentSource.WHATSAPP,
      }),
    );

    expect(createdMessages).toHaveLength(2);
    expect(createdMessages[0].status).toBe(WhatsappMessageStatus.PROCESSED);
    expect(createdMessages[0].documentId).toBe(505);
    expect(createdMessages[0].replyJid).toBe('5491144445555@s.whatsapp.net');
    expect(createdMessages[1].status).toBe(WhatsappMessageStatus.REJECTED_SENDER);
  });
});
