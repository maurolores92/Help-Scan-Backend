import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/sequelize';
import { Document, DocumentPaymentStatus, DocumentStatus } from '../document.model';
import {
  DocumentLink,
  DocumentLinkMatchSource,
  DocumentLinkType,
} from '../models/document-link.model';
import { DocumentLinksService } from './document-links.service';
import { AuditService } from '../../audit/audit.service';

describe('DocumentLinksService', () => {
  let service: DocumentLinksService;

  const mockDocumentLinkModel = {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  };

  const mockDocumentModel = {
    findOne: jest.fn(),
    findAll: jest.fn(),
  };

  const mockAuditService = {
    log: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentLinksService,
        { provide: getModelToken(DocumentLink), useValue: mockDocumentLinkModel },
        { provide: getModelToken(Document), useValue: mockDocumentModel },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<DocumentLinksService>(DocumentLinksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rechaza vincular un documento consigo mismo', async () => {
    await expect(
      service.createLink(10, 1, 5, { targetDocumentId: 10 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('crea vínculo manual de pago parcial y actualiza estado a PARTIALLY_PAID', async () => {
    const receiptDoc: any = {
      id: 20,
      companyId: 1,
      clientId: 7,
      documentType: 'recibo',
      totalAmount: 40000,
      currency: 'ARS',
      toJSON() {
        return this;
      },
    };
    const invoiceDoc: any = {
      id: 10,
      companyId: 1,
      clientId: 7,
      documentType: 'factura',
      totalAmount: 100000,
      currency: 'ARS',
      paymentStatus: DocumentPaymentStatus.PENDING,
      paidAt: null,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() {
        return this;
      },
    };
    const createdLink: any = {
      id: 99,
      companyId: 1,
      sourceDocumentId: 20,
      targetDocumentId: 10,
      linkType: DocumentLinkType.PAYMENT_IMPUTATION,
      appliedAmount: 40000,
      matchSource: DocumentLinkMatchSource.MANUAL,
      update: jest.fn(),
    };

    mockDocumentModel.findOne
      .mockResolvedValueOnce(receiptDoc)
      .mockResolvedValueOnce(invoiceDoc)
      .mockResolvedValueOnce(invoiceDoc)
      .mockResolvedValueOnce(invoiceDoc);

    mockDocumentLinkModel.findOne.mockResolvedValueOnce(null);
    mockDocumentLinkModel.findAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdLink]);
    mockDocumentLinkModel.create.mockResolvedValueOnce(createdLink);

    const res = await service.createLink(20, 1, 5, {
      targetDocumentId: 10,
      appliedAmount: 40000,
    });

    expect(res.warnings).toEqual([]);
    expect(invoiceDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentStatus: DocumentPaymentStatus.PARTIALLY_PAID,
        paidAt: null,
      }),
    );
    expect(res.targetBalanceSummary.remainingBalance).toBe(60000);
  });

  it('no auto-vincula cuando hay dos facturas candidatas ambiguas con el mismo número', async () => {
    const receiptDoc: any = {
      id: 50,
      companyId: 1,
      clientId: 7,
      documentType: 'recibo',
      totalAmount: 10000,
      currency: 'ARS',
      status: DocumentStatus.VALIDATED,
      formRecord: {
        formData: {
          appliedVouchers: [{ voucherType: 'Factura', voucherNumber: '0001-00000010', appliedAmount: 10000 }],
        },
      },
      toJSON() {
        return this;
      },
    };
    const invoiceA: any = {
      id: 1,
      companyId: 1,
      clientId: 7,
      documentType: 'factura',
      documentNumber: '0001-00000010',
      totalAmount: 10000,
      currency: 'ARS',
      paymentStatus: DocumentPaymentStatus.PENDING,
      toJSON() {
        return this;
      },
    };
    const invoiceB: any = {
      id: 2,
      companyId: 1,
      clientId: 7,
      documentType: 'factura',
      documentNumber: '0001-00000010',
      totalAmount: 10000,
      currency: 'ARS',
      paymentStatus: DocumentPaymentStatus.PENDING,
      toJSON() {
        return this;
      },
    };

    mockDocumentModel.findOne.mockResolvedValue(receiptDoc);
    mockDocumentLinkModel.findAll.mockResolvedValue([]);
    mockDocumentModel.findAll.mockResolvedValue([invoiceA, invoiceB]);

    const autoRes = await service.runAutoExactMatchingForDocument(50, 1, 5);

    expect(autoRes.autoMatchedCount).toBe(0);
    expect(mockDocumentLinkModel.create).not.toHaveBeenCalled();
  });
});
