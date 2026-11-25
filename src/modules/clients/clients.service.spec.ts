import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClientsService, formatTaxIdDisplay } from './clients.service';

describe('ClientsService', () => {
  const buildService = (overrides?: {
    clientModel?: any;
    documentModel?: any;
    auditService?: any;
    notificationsService?: any;
  }) => {
    const clientModel = overrides?.clientModel || {
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      create: jest.fn(),
    };
    const documentModel = overrides?.documentModel || {
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue([0]),
    };
    const sequelize: any = {
      transaction: jest.fn().mockResolvedValue({
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const auditService = overrides?.auditService || {
      log: jest.fn().mockResolvedValue(undefined),
    };
    const notificationsService = overrides?.notificationsService || {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ClientsService(
      clientModel,
      documentModel,
      sequelize,
      auditService,
      notificationsService,
    );

    return { service, clientModel, documentModel, auditService, notificationsService };
  };

  it('crea un cliente normalizando CUIL, registra auditoría/notificación y vincula documentos previos sin cliente', async () => {
    const createdClient = {
      id: 14,
      companyId: 2,
      name: 'Aguerre María Mercedes',
      taxId: '27-30405060-7',
      normalizedTaxId: '27304050607',
      isActive: true,
      toJSON() {
        return {
          id: this.id,
          companyId: this.companyId,
          name: this.name,
          taxId: this.taxId,
          normalizedTaxId: this.normalizedTaxId,
          isActive: this.isActive,
        };
      },
    };

    const clientModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdClient),
    };
    const documentModel = {
      findAll: jest.fn().mockResolvedValue([
        { id: 101, recipientTaxId: '27-30405060-7', issuerTaxId: null, rawText: '' },
        { id: 102, recipientTaxId: null, issuerTaxId: null, rawText: 'Cliente CUIL 27304050607' },
        { id: 103, recipientTaxId: '30-71234567-9', issuerTaxId: null, rawText: '' },
      ]),
      update: jest.fn().mockResolvedValue([2]),
    };

    const { service, auditService, notificationsService } = buildService({
      clientModel,
      documentModel,
    });

    const res = await service.create(
      { name: 'Aguerre María Mercedes', taxId: '27304050607' },
      2,
      9,
    );

    expect(formatTaxIdDisplay('27304050607')).toBe('27-30405060-7');
    expect(res.linkedDocumentsCount).toBe(2);
    expect(documentModel.update).toHaveBeenCalledWith(
      { clientId: 14 },
      expect.objectContaining({
        where: expect.objectContaining({ companyId: 2 }),
      }),
    );
    expect(auditService.log).toHaveBeenCalled();
    expect(notificationsService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'client.created', companyId: 2 }),
    );
  });

  it('impide duplicar el mismo CUIT/CUIL dentro de la misma compañía', async () => {
    const clientModel = {
      findOne: jest.fn().mockResolvedValue({ id: 5, name: 'Cliente Existente' }),
    };
    const { service } = buildService({ clientModel });

    await expect(
      service.create({ name: 'Otro', taxId: '20-12345678-9' }, 2, 1),
    ).rejects.toThrow(ConflictException);
  });

  it('asocia documento al cliente correspondiente comparando CUIL sin importar guiones', async () => {
    const matchingClient = {
      id: 22,
      companyId: 3,
      name: 'Ferretería Norte S.A.',
      taxId: '30-71234567-9',
      normalizedTaxId: '30712345679',
      isActive: true,
    };
    const clientModel = {
      findAll: jest.fn().mockResolvedValue([matchingClient]),
    };
    const { service } = buildService({ clientModel });

    const matched = await service.resolveMatchingClientForDocument(3, {
      recipientTaxId: '30 71234567 9',
      issuerTaxId: '30-70841005-1',
    });

    expect(matched?.id).toBe(22);
    expect(clientModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: 3, isActive: true }),
      }),
    );
  });

  it('rechaza operar sin compañía válida o acceso cross-tenant', async () => {
    const clientModel = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const { service } = buildService({ clientModel });

    await expect(service.findAll(0, {})).rejects.toThrow(ForbiddenException);
    await expect(service.findById(99, 2)).rejects.toThrow(NotFoundException);
  });

  it('auto-crea un cliente con datos administrativos argentinos por CUIL cuando no existe (solo nombre y CUIL obligatorios)', async () => {
    const createdClient = {
      id: 41,
      companyId: 5,
      name: 'METALURGICA DEL SUR S.A.',
      taxId: '30-71122334-9',
      normalizedTaxId: '30711223349',
      taxIdType: 'CUIT',
      taxCondition: 'Responsable Inscripto',
      isActive: true,
    };
    const clientModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdClient),
    };
    const { service, auditService, notificationsService } = buildService({ clientModel });

    const client = await service.resolveOrCreateClientForDocument(5, {
      recipientName: 'METALURGICA DEL SUR S.A.',
      recipientTaxId: '30711223349',
      taxCondition: 'Responsable Inscripto',
      deliveryAddress: 'Av. Independencia 2200',
      recipientEmail: 'admin@metalurgicasur.com.ar',
      recipientPhone: '0223-4910000',
      extractedData: {
        attributes: {
          localidad_cliente: 'Mar del Plata',
          provincia_cliente: 'Buenos Aires',
          codigo_postal_cliente: '7600',
        },
      },
      sourceDocumentName: 'factura_a_001.pdf',
      actorUserId: 8,
    });

    expect(client?.id).toBe(41);
    expect(clientModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 5,
        name: 'METALURGICA DEL SUR S.A.',
        taxId: '30-71122334-9',
        normalizedTaxId: '30711223349',
        taxIdType: 'CUIT',
        taxCondition: 'Responsable Inscripto',
        city: 'Mar del Plata',
        province: 'Buenos Aires',
        postalCode: '7600',
        iibbNumber: null,
      }),
      expect.any(Object),
    );
    expect(auditService.log).toHaveBeenCalled();
    expect(notificationsService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'client.created', companyId: 5 }),
    );
  });

  it('auto-crea el cliente desde un presupuesto sin CUIT/CUIL y luego lo enriquece si llega una factura con CUIL', async () => {
    const createdClient = {
      id: 52,
      companyId: 2,
      name: 'BERASUETA VERONICA ANAHI',
      taxId: null,
      normalizedTaxId: null,
      email: 'alquileres@inmobiliariaberasueta.com',
      phone: '0223 155961421',
      isActive: true,
      update: jest.fn().mockResolvedValue(undefined),
    };
    const clientModel = {
      findAll: jest.fn().mockImplementation((opts: any) => {
        if (opts?.where?.normalizedTaxId) return Promise.resolve([]);
        if (opts?.where?.companyId === 2) {
          return Promise.resolve(created ? [createdClient] : []);
        }
        return Promise.resolve([]);
      }),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => {
        created = true;
        return Promise.resolve(createdClient);
      }),
    };
    let created = false;
    const { service } = buildService({ clientModel });

    // 1. Presupuesto sin CUIT/CUIL -> lo crea con taxId = null
    const fromBudget = await service.resolveOrCreateClientForDocument(2, {
      recipientName: 'BERASUETA VERONICA ANAHI',
      recipientTaxId: null,
      recipientEmail: 'alquileres@inmobiliariaberasueta.com',
      recipientPhone: '0223 155961421',
      sourceDocumentName: 'BERASUETA VERONICA ANAHI.pdf',
    });

    expect(fromBudget?.id).toBe(52);
    expect(clientModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 2,
        name: 'BERASUETA VERONICA ANAHI',
        taxId: null,
        normalizedTaxId: null,
        email: 'alquileres@inmobiliariaberasueta.com',
      }),
      expect.any(Object),
    );

    // 2. Factura posterior con el mismo email/nombre y CUIL -> no duplica y enriquece el cliente
    const fromInvoice = await service.resolveOrCreateClientForDocument(2, {
      recipientName: 'BERASUETA VERONICA ANAHI',
      recipientTaxId: '27-28111222-3',
      recipientEmail: 'alquileres@inmobiliariaberasueta.com',
    });

    expect(fromInvoice?.id).toBe(52);
    expect(clientModel.create).toHaveBeenCalledTimes(1);
    expect(createdClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        taxId: '27-28111222-3',
        normalizedTaxId: '27281112223',
        taxIdType: 'CUIL',
      }),
    );

    // 3. Si falta el nombre del destinatario, no crea registros vacíos
    const missingName = await service.resolveOrCreateClientForDocument(2, {
      recipientName: null,
      recipientTaxId: '20-30405060-7',
    });
    expect(missingName).toBeNull();
  });

  it('findClientDocuments agrupa y filtra documentos por rol (emisor vs destinatario) y por tipo de documento', async () => {
    const mockClient = {
      id: 7,
      companyId: 2,
      name: 'ALPINE SKATE S.R.L.',
      tradeName: 'Alpine Skate',
      normalizedTaxId: '30711223349',
      taxId: '30-71122334-9',
      email: 'admlocales@alpineskate.com',
      toJSON() {
        return {
          id: this.id,
          companyId: this.companyId,
          name: this.name,
          tradeName: this.tradeName,
          taxId: this.taxId,
          normalizedTaxId: this.normalizedTaxId,
          email: this.email,
        };
      },
    };

    const docs = [
      {
        id: 1,
        clientId: 7,
        originalName: 'presupuesto_1.pdf',
        documentType: 'presupuesto',
        issuerName: 'Help Copies SRL',
        issuerTaxId: '30-70841005-1',
        recipientName: 'Alpine Skate',
        recipientTaxId: null,
        recipientEmail: 'admlocales@alpineskate.com',
        status: 'PENDING_APPROVAL',
      },
      {
        id: 2,
        clientId: null,
        originalName: 'factura_emitida_por_alpine.pdf',
        documentType: 'factura_a',
        issuerName: 'ALPINE SKATE S.R.L.',
        issuerTaxId: '30-71122334-9',
        recipientName: 'Help Copies SRL',
        recipientTaxId: '30-70841005-1',
        recipientEmail: null,
        status: 'VALIDATED',
      },
      {
        id: 3,
        clientId: null,
        originalName: 'recibo_otro_cliente.pdf',
        documentType: 'recibo',
        issuerName: 'Otro Emisor',
        issuerTaxId: '30-99999999-9',
        recipientName: 'Otro Receptor',
        recipientTaxId: '20-11111111-1',
        recipientEmail: 'otro@test.com',
        status: 'VALIDATED',
      },
    ];

    const clientModel = {
      findOne: jest.fn().mockResolvedValue(mockClient),
    };
    const documentModel = {
      findAll: jest.fn().mockResolvedValue(docs),
    };
    const { service } = buildService({ clientModel, documentModel });

    const allRes = await service.findClientDocuments(7, 2, {});
    expect(allRes.summary.total).toBe(2);
    expect(allRes.summary.byRole).toEqual({ all: 2, issuer: 1, recipient: 1, linked: 0 });
    expect(allRes.summary.byType).toEqual({ presupuesto: 1, factura: 1 });
    expect(allRes.data.map((d: any) => d.clientRole)).toEqual(['recipient', 'issuer']);

    const issuerOnly = await service.findClientDocuments(7, 2, {
      role: 'issuer',
      documentType: 'factura',
    });
    expect(issuerOnly.data).toHaveLength(1);
    expect(issuerOnly.data[0].id).toBe(2);
    expect(issuerOnly.data[0].clientRole).toBe('issuer');
  });
});
