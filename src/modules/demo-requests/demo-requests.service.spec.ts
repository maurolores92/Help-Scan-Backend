import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { DemoRequestsService } from './demo-requests.service';
import { DemoRequestStatus } from './demo-request.model';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

describe('DemoRequestsService', () => {
  const originalEnv = process.env;
  let service: DemoRequestsService;
  let mockModel: any;
  let mockAuditService: any;
  let createdRecord: any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    createdRecord = {
      id: 42,
      fullName: 'Ana <Admin>',
      companyName: 'Comercial Norte SRL',
      email: 'ana@norte.com.ar',
      status: DemoRequestStatus.RECIBIDO,
      emailSent: false,
      update: jest.fn().mockImplementation(async (patch: any) => {
        Object.assign(createdRecord, patch);
        return createdRecord;
      }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    mockModel = {
      create: jest.fn().mockResolvedValue(createdRecord),
      findAll: jest.fn().mockResolvedValue([createdRecord]),
      findByPk: jest.fn().mockResolvedValue(createdRecord),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new DemoRequestsService(mockModel, mockAuditService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('persists record and throws ServiceUnavailableException when SMTP env vars are missing', async () => {
    process.env.SMTP_HOST = '';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    process.env.DEMO_REQUEST_TO_EMAIL = '';

    await expect(
      service.sendDemoRequest({
        fullName: 'Juan Pérez',
        companyName: 'Acme S.A.',
        email: 'juan@acme.com',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(mockModel.create).toHaveBeenCalledTimes(1);
    expect(createdRecord.update).not.toHaveBeenCalled();
  });

  it('persists record, sends escaped HTML email with replyTo, and marks emailSent=true', async () => {
    const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: sendMailMock,
    });

    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'bot@helpcopies.com.ar';
    process.env.SMTP_PASS = 'secret';
    process.env.SMTP_FROM_NAME = 'Help Scan Web';
    process.env.SMTP_FROM_EMAIL = 'noreply@helpcopies.com.ar';
    process.env.DEMO_REQUEST_TO_EMAIL = 'ventas@helpcopies.com.ar';

    const result = await service.sendDemoRequest({
      fullName: 'Ana <Admin>',
      companyName: 'Comercial Norte SRL',
      email: 'ana@norte.com.ar',
      phone: '+54 11 5555-1234',
      managementSystem: 'Tango',
      selectedDemo: 'Validación de datos y control sin errores',
      message: 'Queremos probar con facturas & remitos.',
      source: 'demo_modal',
    });

    expect(result).toEqual({
      ok: true,
      id: 42,
      message: 'Solicitud de demostración enviada correctamente.',
    });
    expect(mockModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: 'Ana <Admin>',
        companyName: 'Comercial Norte SRL',
        managementSystem: 'Tango',
        status: DemoRequestStatus.RECIBIDO,
      }),
    );
    expect(createdRecord.update).toHaveBeenCalledWith({ emailSent: true });
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'bot@helpcopies.com.ar',
        pass: 'secret',
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    const sentPayload = sendMailMock.mock.calls[0][0];
    expect(sentPayload.to).toBe('ventas@helpcopies.com.ar');
    expect(sentPayload.replyTo).toBe('ana@norte.com.ar');
    expect(sentPayload.html).toContain('Ana &lt;Admin&gt;');
    expect(sentPayload.html).toContain('Sistema de Gestión:');
    expect(sentPayload.html).toContain('Tango');
  });

  it('forces implicit TLS when SMTP_PORT is 465 even if SMTP_SECURE is false', () => {
    process.env.SMTP_HOST = 'smtp.hostinger.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'false';

    expect(service.getMailConfig().secure).toBe(true);
  });

  it('returns status summary counts in findAll', async () => {
    mockModel.findAll.mockResolvedValue([
      { status: DemoRequestStatus.RECIBIDO },
      { status: DemoRequestStatus.VENDIDO },
      { status: DemoRequestStatus.RECIBIDO },
    ]);

    const res = await service.findAll({});
    expect(res.total).toBe(3);
    expect(res.counts.RECIBIDO).toBe(2);
    expect(res.counts.VENDIDO).toBe(1);
    expect(res.counts.ALL).toBe(3);
  });

  it('updates demo request status and logs audit trail', async () => {
    const updated = await service.updateStatus(
      42,
      { status: DemoRequestStatus.CONTACTADO, notes: 'Llamado a las 11hs' },
      1,
    );

    expect(updated.status).toBe(DemoRequestStatus.CONTACTADO);
    expect(createdRecord.update).toHaveBeenCalledWith({
      status: DemoRequestStatus.CONTACTADO,
      notes: 'Llamado a las 11hs',
    });
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'DemoRequest',
        entityId: 42,
        userId: 1,
        companyId: null,
      }),
    );
  });

  it('throws NotFoundException when updating missing demo request', async () => {
    mockModel.findByPk.mockResolvedValue(null);
    await expect(
      service.updateStatus(999, { status: DemoRequestStatus.INTERESADO }, 1),
    ).rejects.toThrow(NotFoundException);
  });
});
