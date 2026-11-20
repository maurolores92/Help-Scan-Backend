import { TelegramChannelService } from './services/telegram-channel.service';
import {
  TelegramSenderPolicy,
  TelegramSyncStatus,
} from './models/company-telegram-channel.model';
import { TelegramMessageStatus } from './models/telegram-message.model';
import { CompanyStatus } from '../companies/company.model';
import { DocumentSource } from '../documents/document.model';
import {
  buildDuplicateNoticeMessage,
  buildOcrCompletedMessage,
  buildReceiptAckMessage,
} from './helpers/channel-reply-formatter.helper';

describe('TelegramChannelService & Reply Formatter', () => {
  it('formatea mensajes profesionales de acuse inmediato y confirmación post-OCR esperando validación', () => {
    const ack = buildReceiptAckMessage({
      fileName: 'factura_100.pdf',
      documentId: 42,
      channelName: 'Telegram',
    });
    expect(ack).toContain('recibido exitosamente');
    expect(ack).toContain('factura_100.pdf');
    expect(ack).toContain('#DOC-42');
    expect(ack).toContain('esperando validación');

    const dup = buildDuplicateNoticeMessage({
      fileName: 'factura_100.pdf',
      documentId: 42,
    });
    expect(dup).toContain('ya registrado');

    const ocrDone = buildOcrCompletedMessage({
      id: 42,
      originalName: 'factura_100.pdf',
      documentType: 'factura',
      documentNumber: '0001-00001234',
      issuerName: 'Help Copies S.R.L.',
      currency: 'ARS',
      totalAmount: 15000,
    } as any);
    expect(ocrDone).toContain('Esperando validación');
    expect(ocrDone).toContain('0001-00001234');
    expect(ocrDone).toContain('Help Copies S.R.L.');
  });

  it('procesa PDF entrante de Telegram, envía acuse inmediato y rechaza chats fuera de lista blanca', async () => {
    const channelRecord: any = {
      id: 2,
      companyId: 8,
      senderPolicy: TelegramSenderPolicy.WHITELIST,
      allowedChatIds: ['99887766'],
      ignoreGroups: false,
      isActive: true,
      processImages: true,
      autoReplyConfirmation: true,
      lastSyncStatus: TelegramSyncStatus.IDLE,
      update: jest.fn().mockResolvedValue(undefined),
    };

    const createdMessages: any[] = [];
    const telegramMessageModel: any = {
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
        id: 8,
        name: 'Cliente Demo',
        status: CompanyStatus.ACTIVE,
        enabledModules: ['documents', 'telegram'],
      }),
    };

    const botClient: any = {
      downloadFileBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.7\nTelegram PDF'),
        filePath: 'documents/file_1.pdf',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const documentsService: any = {
      ingestPdfFromChannel: jest.fn().mockResolvedValue({
        document: { id: 777 },
        isDuplicate: false,
      }),
    };

    const service = new TelegramChannelService(
      {} as any,
      telegramMessageModel,
      companyModel,
      botClient,
      documentsService,
      { registerPostProcessHook: jest.fn() } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    // 1. Mensaje autorizado con PDF
    await service.handleIncomingMessage(channelRecord, '123:BOT_TOKEN', {
      message_id: 10,
      date: 1763590000,
      chat: { id: 99887766, type: 'private' },
      from: { id: 99887766, username: 'juan_admin', first_name: 'Juan' },
      document: {
        file_id: 'FILE_ID_1',
        file_name: 'remito_tg.pdf',
        mime_type: 'application/pdf',
      },
    });

    // 2. Mensaje de chat NO autorizado
    await service.handleIncomingMessage(channelRecord, '123:BOT_TOKEN', {
      message_id: 11,
      date: 1763590010,
      chat: { id: 555444333, type: 'private' },
      from: { id: 555444333, username: 'desconocido', first_name: 'Intruso' },
      document: {
        file_id: 'FILE_ID_2',
        file_name: 'spam.pdf',
        mime_type: 'application/pdf',
      },
    });

    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledTimes(1);
    expect(documentsService.ingestPdfFromChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 8,
        originalName: 'remito_tg.pdf',
        source: DocumentSource.TELEGRAM,
      }),
    );

    expect(botClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '123:BOT_TOKEN',
      '99887766',
      expect.stringContaining('esperando validación'),
    );

    expect(createdMessages).toHaveLength(2);
    expect(createdMessages[0].status).toBe(TelegramMessageStatus.PROCESSED);
    expect(createdMessages[0].documentId).toBe(777);
    expect(createdMessages[1].status).toBe(TelegramMessageStatus.REJECTED_SENDER);
  });
});
