import { DocumentFormsService } from './document-forms.service';
import { DEFAULT_DOCUMENT_FORMS_SEED } from '../data/default-document-forms.data';

describe('DocumentFormsService', () => {
  const buildMockForms = () =>
    DEFAULT_DOCUMENT_FORMS_SEED.map((def, idx) => ({
      id: idx + 1,
      companyId: null,
      code: def.code,
      label: def.label,
      description: def.description,
      icon: def.icon,
      matchAliases: def.matchAliases,
      sectionsSchema: def.sectionsSchema,
      aiExtractionGuide: def.aiExtractionGuide,
      displayOrder: def.displayOrder,
      version: def.version,
      isActive: true,
    }));

  const buildService = () => {
    const mockForms = buildMockForms();
    const formModel: any = {
      count: jest.fn().mockResolvedValue(mockForms.length),
      findAll: jest.fn().mockResolvedValue(mockForms),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((payload) => Promise.resolve({ id: 99, ...payload })),
    };
    const recordModel: any = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((payload) => Promise.resolve({ id: 500, ...payload })),
    };

    const service = new DocumentFormsService(formModel, recordModel);
    return { service, formModel, recordModel, mockForms };
  };

  it('separa Nota de Crédito, Nota de Débito, Orden de Pago, Retenciones, Ticket y Transferencia de Factura/Recibo', async () => {
    const { service } = buildService();

    const schemaNc = await service.resolveFormByDocumentType(1, 'nota_credito_a');
    expect(schemaNc?.code).toBe('nota_credito');

    const schemaNd = await service.resolveFormByDocumentType(1, 'nota_debito_b');
    expect(schemaNd?.code).toBe('nota_debito');

    const schemaOp = await service.resolveFormByDocumentType(1, 'orden_pago');
    expect(schemaOp?.code).toBe('orden_pago');

    const schemaRet = await service.resolveFormByDocumentType(1, 'certificado_retencion');
    expect(schemaRet?.code).toBe('certificado_retencion');

    const schemaTk = await service.resolveFormByDocumentType(1, 'ticket_fiscal');
    expect(schemaTk?.code).toBe('ticket_fiscal');

    const schemaTr = await service.resolveFormByDocumentType(1, 'transferencia_pago');
    expect(schemaTr?.code).toBe('transferencia_pago');

    const schemaFa = await service.resolveFormByDocumentType(1, 'factura_a');
    expect(schemaFa?.code).toBe('factura');

    const hintsNc = service.inferCoreAndCustomHintsFromRawType('nota_credito_a', 'nota_credito', null);
    expect(hintsNc.documentLetter).toBe('A');
    expect(hintsNc.customDefaults.fiscalSubtype).toBe('Nota de Crédito');
  });

  it('mapea múltiples facturas imputadas (vouchers_table) dentro de Recibos y Órdenes de Pago', async () => {
    const { service } = buildService();
    const reciboSchema = await service.resolveFormByDocumentType(1, 'recibo_x');

    const formData = service.buildFormDataFromExtraction(
      reciboSchema,
      {
        attributes: {
          banco: 'Banco Galicia',
          retenciones: '4500',
          comprobantes_imputados: [
            { voucherType: 'Factura A', voucherNumber: '00004-00001200', originalAmount: 100000, appliedAmount: 100000 },
            { voucherType: 'Factura A', voucherNumber: '00004-00001205', originalAmount: 50000, appliedAmount: 25000 },
          ],
        },
      },
      'recibo_x',
    );

    expect(formData.bankOrPlatform).toBe('Banco Galicia');
    expect(formData.retentionsAmount).toBe(4500);
    expect(Array.isArray(formData.appliedVouchers)).toBe(true);
    expect(formData.appliedVouchers).toHaveLength(2);
    expect(formData.appliedVouchers[1].appliedAmount).toBe(25000);
  });

  it('mapea atributos ARCA extraídos hacia formData del esquema correspondiente', async () => {
    const { service } = buildService();
    const facturaSchema = await service.resolveFormByDocumentType(1, 'factura_b');

    const formData = service.buildFormDataFromExtraction(
      facturaSchema,
      {
        attributes: {
          ingresos_brutos_emisor: '901-555444-3',
          inicio_actividades: '01/05/2018',
          condicion_iva_emisor: 'Responsable Inscripto',
          concepto_arca: 'Servicios',
          codigo_arca: '006',
          tipo_cambio: '1050.50',
        },
      },
      'factura_b',
    );

    expect(formData.fiscalSubtype).toBe('Factura');
    expect(formData.issuerIibb).toBe('901-555444-3');
    expect(formData.issuerActivityStartDate).toBe('01/05/2018');
    expect(formData.issuerTaxCondition).toBe('Responsable Inscripto');
    expect(formData.concept).toBe('Servicios');
    expect(formData.afipVoucherCode).toBe('006');
    expect(formData.exchangeRate).toBe(1050.5);
  });

  it('resuelve orden_servicio general y mapea campos de activo/falla/trabajo', async () => {
    const { service } = buildService();
    const osSchema = await service.resolveFormByDocumentType(2, 'servicio_tecnico');
    expect(osSchema?.code).toBe('orden_servicio');

    const formData = service.buildFormDataFromExtraction(osSchema, {
      attributes: {
        tipo_activo: 'Equipamiento Oficina',
        modelo: 'MP 402 SPF',
        numero_serie: 'SN-2971',
        falla_reportada: 'Error en fusor',
        trabajo_realizado: 'Cambio de unidad fotoconductora y calibración',
      },
    });

    expect(formData.assetType).toBe('Equipamiento Oficina');
    expect(formData.assetModel).toBe('MP 402 SPF');
    expect(formData.assetIdentifier).toBe('SN-2971');
    expect(formData.reportedIssue).toBe('Error en fusor');
    expect(formData.workPerformed).toBe('Cambio de unidad fotoconductora y calibración');
  });

  it('persiste y actualiza form_data en document_form_records respetando companyId', async () => {
    const { service, recordModel } = buildService();
    const remitoSchema = await service.resolveFormByDocumentType(4, 'remito');

    await service.upsertFormRecord({
      companyId: 4,
      documentId: 77,
      schema: remitoSchema,
      documentType: 'remito',
      formData: {
        cotCode: 'COT-8899',
        packagesCount: 5,
        vehiclePlate: 'AB123CD',
        emptyField: '',
      },
      actorUserId: 12,
      markValidated: true,
    });

    expect(recordModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 4,
        documentId: 77,
        formSchemaId: remitoSchema?.id,
        documentType: 'remito',
        validatedByUserId: 12,
        formData: {
          cotCode: 'COT-8899',
          packagesCount: 5,
          vehiclePlate: 'AB123CD',
        },
      }),
    );
  });
});
