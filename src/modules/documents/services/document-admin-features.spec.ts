jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_9AM: '0 9 * * *' },
}));

import { DocumentPaymentStatus, DocumentStatus } from '../document.model';
import { DocumentDueAlertsService } from './document-due-alerts.service';
import { DocumentExportService } from './document-export.service';

describe('Funciones administrativas de Documentos (Vencimientos y Exportación)', () => {
  it('DocumentDueAlertsService notifica vencidos y próximos a vencer sin repetir si ya fue alertado', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    const documentModelMock: any = {
      findAll: jest.fn().mockResolvedValue([
        {
          id: 10,
          companyId: 2,
          userId: 5,
          originalName: 'factura_vencida.pdf',
          issuerName: 'Proveedor Uno',
          documentNumber: '0001-00000100',
          currency: 'ARS',
          totalAmount: 50000,
          dueDate: '2026-11-20',
          update: updateMock,
        },
        {
          id: 11,
          companyId: 2,
          userId: 5,
          originalName: 'factura_proxima.pdf',
          issuerName: 'Proveedor Dos',
          documentNumber: '0001-00000200',
          currency: 'ARS',
          totalAmount: 25000,
          dueDate: '2026-11-26',
          update: updateMock,
        },
      ]),
    };

    const notificationsServiceMock: any = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const service = new DocumentDueAlertsService(
      documentModelMock,
      notificationsServiceMock,
    );

    const res = await service.dispatchUpcomingAndOverdueAlerts(
      new Date('2026-11-24T12:00:00Z'),
    );

    expect(res.notifiedCount).toBe(2);
    expect(notificationsServiceMock.dispatch).toHaveBeenCalledTimes(2);
    expect(notificationsServiceMock.dispatch.mock.calls[0][0].title).toContain('vencido');
    expect(notificationsServiceMock.dispatch.mock.calls[1][0].title).toContain('próximo a vencer');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('DocumentExportService genera CSV, XLSX y PDF respetando filtros y registrando auditoría', async () => {
    const sampleDocs: any[] = [
      {
        id: 101,
        companyId: 3,
        originalName: 'factura_a.pdf',
        documentDate: '2026-11-10',
        dueDate: '2026-11-30',
        documentType: 'factura_a',
        documentLetter: 'A',
        pointOfSale: '00008',
        documentNumber: '00008-00041980',
        issuerName: 'Papelera Sur S.A.',
        issuerTaxId: '30-70841005-1',
        recipientName: 'Cliente SA',
        recipientTaxId: '30-71234567-9',
        currency: 'ARS',
        netAmount: 100000,
        taxAmount: 21000,
        exemptAmount: 0,
        otherTaxesAmount: 0,
        totalAmount: 121000,
        status: DocumentStatus.VALIDATED,
        paymentStatus: DocumentPaymentStatus.PENDING,
        paidAt: null,
        paymentReference: null,
        purchaseOrderNumber: 'OC-10',
        cae: '74123456789012',
        source: 'WHATSAPP',
        validationWarnings: [],
        createdAt: new Date('2026-11-10T10:00:00Z'),
      },
    ];

    const documentModelMock: any = {
      findAll: jest.fn().mockResolvedValue(sampleDocs),
    };
    const companyModelMock: any = {
      findByPk: jest.fn().mockResolvedValue({ id: 3, name: 'Mi Empresa SRL', slug: 'mi-empresa' }),
    };
    const auditServiceMock: any = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const exportService = new DocumentExportService(
      documentModelMock,
      companyModelMock,
      auditServiceMock,
    );

    const makeMockRes = () => {
      const headers: Record<string, string> = {};
      return {
        headers,
        body: null as any,
        set: jest.fn((h: Record<string, string>) => Object.assign(headers, h)),
        send: jest.fn(function (this: any, b: any) {
          this.body = b;
          return this;
        }),
      };
    };

    const csvRes = makeMockRes();
    await exportService.exportDocuments(3, 9, { format: 'csv', search: 'Papelera' }, csvRes as any);
    expect(csvRes.headers['Content-Type']).toContain('text/csv');
    expect(String(csvRes.body)).toContain('Papelera Sur S.A.');
    expect(String(csvRes.body)).toContain('00008-00041980');

    const xlsxRes = makeMockRes();
    await exportService.exportDocuments(3, 9, { format: 'xlsx' }, xlsxRes as any);
    expect(xlsxRes.headers['Content-Type']).toContain('spreadsheetml');
    expect(Buffer.isBuffer(xlsxRes.body)).toBe(true);
    expect((xlsxRes.body as Buffer).length).toBeGreaterThan(1000);

    const pdfRes = makeMockRes();
    await exportService.exportDocuments(3, 9, { format: 'pdf' }, pdfRes as any);
    expect(pdfRes.headers['Content-Type']).toBe('application/pdf');
    expect(Buffer.isBuffer(pdfRes.body)).toBe(true);
    expect((pdfRes.body as Buffer).subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(auditServiceMock.log).toHaveBeenCalledTimes(3);
  });
});
