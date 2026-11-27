import {
  normalizeWhatsappPhone,
  WhatsappChannelService,
} from './services/whatsapp-channel.service';
import {
  WhatsappConnectionStatus,
  WhatsappGroupPolicy,
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
      findByPk: jest.fn().mockResolvedValue(channelRecord),
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

    expect(baileysService.startSession).toHaveBeenCalledWith(1);
    expect(res.runtime.connectionStatus).toBe(WhatsappConnectionStatus.QR_READY);
    expect(res.runtime.qrDataUrl).toBe('data:image/png;base64,MOCK_QR');
  });

  it('procesa PDF entrante, ignora grupos/fromMe y rechaza números fuera de lista blanca', async () => {
    const channelRecord: any = {
      id: 3,
      companyId: 7,
      userId: 9,
      sessionKey: 'company_7_user_9',
      senderPolicy: WhatsappSenderPolicy.WHITELIST,
      allowedPhones: ['5491144445555'],
      ignoreGroups: true,
      isActive: true,
      processImages: true,
      autoReplyConfirmation: true,
      lastSyncStatus: WhatsappSyncStatus.IDLE,
      update: jest.fn().mockResolvedValue(undefined),
    };

    const createdMessages: any[] = [];
    const whatsappChannelModel: any = {
      findOne: jest.fn().mockResolvedValue(channelRecord),
      findByPk: jest.fn().mockResolvedValue(channelRecord),
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

    await service.handleIncomingBaileysMessages(3, 7, 9, [
      // 1. Mensaje propio saliente -> debe ignorarse
      {
        key: { id: 'wa.fromme', fromMe: true, remoteJid: '5491144445555@s.whatsapp.net' },
        message: { conversation: 'hola' },
      },
      // 2. Mensaje de texto plano sin archivo adjunto -> NO debe guardarse ni procesarse
      {
        key: { id: 'wa.textonly', fromMe: false, remoteJid: '5491144445555@s.whatsapp.net' },
        message: { conversation: 'Hola buenas tardes!' },
      },
      // 3. Mensaje de grupo -> debe ignorarse porque ignoreGroups = true
      {
        key: { id: 'wa.group', fromMe: false, remoteJid: '120363000@g.us' },
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'grupo.pdf' },
        },
      },
      // 4. Remitente autorizado con PDF envuelto en documentWithCaptionMessage
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
      // 5. Remitente NO autorizado con archivo adjunto -> REJECTED_SENDER
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

    // Procesamiento 100% interno: nunca debe enviar mensajes salientes por WhatsApp
    expect(baileysService.sendTextMessage).not.toHaveBeenCalled();
  });

  it('procesa PDFs de cualquier integrante en grupos autorizados e ignora grupos no autorizados', async () => {
    const channelRecord: any = {
      id: 4,
      companyId: 7,
      sessionKey: 'company_7',
      senderPolicy: WhatsappSenderPolicy.WHITELIST,
      allowedPhones: ['5491144445555'],
      ignoreGroups: false,
      groupPolicy: WhatsappGroupPolicy.WHITELIST,
      allowedGroups: [{ jid: '120363999@g.us', name: 'Facturas Proveedores' }],
      isActive: true,
      processImages: true,
      autoReplyConfirmation: false,
      lastSyncStatus: WhatsappSyncStatus.IDLE,
      update: jest.fn().mockResolvedValue(undefined),
    };

    const createdMessages: any[] = [];
    const whatsappChannelModel: any = {
      findOne: jest.fn().mockResolvedValue(channelRecord),
      findByPk: jest.fn().mockResolvedValue(channelRecord),
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
      downloadMessageMedia: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nGroupPDF')),
      resolveGroupSubject: jest.fn().mockResolvedValue('Facturas Proveedores'),
    };
    const documentsService: any = {
      ingestPdfFromChannel: jest.fn().mockResolvedValue({
        document: { id: 808 },
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

    await service.handleIncomingBaileysMessages(4, 7, 9, [
      // Grupo NO autorizado -> debe ignorarse
      {
        key: {
          id: 'wa.unauth_group',
          fromMe: false,
          remoteJid: '120363111@g.us',
          participant: '5491199998888@s.whatsapp.net',
        },
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'asado.pdf' },
        },
      },
      // Grupo autorizado + integrante NO listado en allowedPhones -> debe procesarse
      {
        key: {
          id: 'wa.auth_group',
          fromMe: false,
          remoteJid: '120363999@g.us',
          participant: '5491177776666@s.whatsapp.net',
        },
        pushName: 'Proveedor Nuevo',
        messageTimestamp: 1763590020,
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'factura_prov.pdf' },
        },
      },
      // Grupo autorizado + mensaje enviado por tu propia cuenta (fromMe=true) -> también debe procesarse
      {
        key: {
          id: 'wa.auth_group_fromme',
          fromMe: true,
          remoteJid: '120363999@g.us',
        },
        pushName: 'Mi Cuenta',
        messageTimestamp: 1763590030,
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'factura_propia.pdf' },
        },
      },
    ]);

    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledTimes(2);
    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 7,
        originalName: 'factura_prov.pdf',
        channelContextLabel: expect.stringContaining("WhatsApp Grupo 'Facturas Proveedores'"),
      }),
    );
    expect(createdMessages).toHaveLength(2);
    expect(createdMessages[0].status).toBe(WhatsappMessageStatus.PROCESSED);
    expect(createdMessages[0].groupJid).toBe('120363999@g.us');
    expect(createdMessages[0].groupName).toBe('Facturas Proveedores');
    expect(createdMessages[1].status).toBe(WhatsappMessageStatus.PROCESSED);
    expect(createdMessages[1].groupJid).toBe('120363999@g.us');
  });

  it('envía notificación breve al recibir y al indexar hacia el usuario o grupo según los switches activos', async () => {
    const channelRecord: any = {
      id: 8,
      companyId: 7,
      userId: 9,
      sessionKey: 'company_7_user_9',
      senderPolicy: WhatsappSenderPolicy.ALL,
      allowedPhones: [],
      ignoreGroups: false,
      groupPolicy: WhatsappGroupPolicy.ALL,
      allowedGroups: [],
      isActive: true,
      processImages: true,
      notifyOnReceive: true,
      notifyOnIndexed: true,
      autoReplyConfirmation: true,
      lastSyncStatus: WhatsappSyncStatus.IDLE,
      update: jest.fn().mockImplementation(async (patch) => {
        Object.assign(channelRecord, patch);
        return channelRecord;
      }),
      toJSON: () => ({ ...channelRecord }),
    };

    const whatsappChannelModel: any = {
      findOrCreate: jest.fn().mockResolvedValue([channelRecord, false]),
      findOne: jest.fn().mockResolvedValue(channelRecord),
      findByPk: jest.fn().mockResolvedValue(channelRecord),
    };
    const whatsappMessageModel: any = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 44,
          companyId: 7,
          channelId: 8,
          userId: 9,
          documentId: 912,
          replyJid: '120363999@g.us',
          groupJid: '120363999@g.us',
          senderPhone: '5491177776666',
        }),
      create: jest.fn().mockImplementation(async (payload) => {
        const rec: any = {
          id: 44,
          ...payload,
          update: jest.fn().mockImplementation(async (patch) => {
            Object.assign(rec, patch);
            return rec;
          }),
        };
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
      downloadMessageMedia: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nNotifyPDF')),
      resolveGroupSubject: jest.fn().mockResolvedValue('Comprobantes'),
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
      getRuntimeSnapshot: jest.fn().mockReturnValue({
        channelId: 8,
        companyId: 7,
        userId: 9,
        connectionStatus: WhatsappConnectionStatus.CONNECTED,
        qrDataUrl: null,
        connectedPhone: '5491100001111',
        connectedName: 'HelpScan',
        lastError: null,
      }),
    };
    const documentsService: any = {
      ingestPdfFromChannel: jest.fn().mockResolvedValue({
        document: { id: 912 },
        isDuplicate: false,
      }),
    };

    let registeredPostHook: ((doc: any) => Promise<void>) | null = null;
    const processingQueue: any = {
      registerPostProcessHook: jest.fn().mockImplementation((cb) => {
        registeredPostHook = cb;
      }),
    };

    const service = new WhatsappChannelService(
      whatsappChannelModel,
      whatsappMessageModel,
      companyModel,
      baileysService,
      documentsService,
      processingQueue,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    service.onModuleInit();
    expect(registeredPostHook).toBeDefined();

    // 1. Guardar preferencias con switches activos
    await service.upsertSettings(
      {
        notifyOnReceive: true,
        notifyOnIndexed: true,
      },
      { id: 9, companyId: 7, role: 'company_admin' },
    );
    expect(channelRecord.notifyOnReceive).toBe(true);
    expect(channelRecord.notifyOnIndexed).toBe(true);

    // 2. Recibir archivo en grupo -> notifica recepción al grupo
    await service.handleIncomingBaileysMessages(8, 7, 9, [
      {
        key: {
          id: 'wa.notify_group',
          fromMe: false,
          remoteJid: '120363999@g.us',
          participant: '5491177776666@s.whatsapp.net',
        },
        pushName: 'Chofer',
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'remito.pdf' },
        },
      },
    ]);

    expect(baileysService.sendTextMessage).toHaveBeenCalledWith(
      8,
      '120363999@g.us',
      '📥 Documento recibido en HelpScan',
    );

    // 3. Ejecutar post-process hook al indexar -> notifica indexado al mismo grupo
    await registeredPostHook!({
      id: 912,
      companyId: 7,
      source: DocumentSource.WHATSAPP,
    });

    expect(baileysService.sendTextMessage).toHaveBeenCalledWith(
      8,
      '120363999@g.us',
      '✅ Documento indexado en HelpScan',
    );

    // 4. Si se apagan los switches, no envía más mensajes salientes
    channelRecord.notifyOnIndexed = false;
    whatsappMessageModel.findOne.mockResolvedValueOnce({
      id: 44,
      companyId: 7,
      channelId: 8,
      userId: 9,
      documentId: 912,
      replyJid: '120363999@g.us',
    });
    await registeredPostHook!({
      id: 912,
      companyId: 7,
      source: DocumentSource.WHATSAPP,
    });
    expect(baileysService.sendTextMessage).toHaveBeenCalledTimes(2);
  });
});
