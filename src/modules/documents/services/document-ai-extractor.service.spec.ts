import pdfParse = require('pdf-parse');
import { DocumentAiExtractorService } from './document-ai-extractor.service';

jest.mock('pdf-parse', () => jest.fn());

describe('DocumentAiExtractorService', () => {
  let service: DocumentAiExtractorService;
  const mockedPdfParse = pdfParse as unknown as jest.Mock;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalOcrUrl = process.env.OCR_SERVICE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    service = new DocumentAiExtractorService();
    delete process.env.GEMINI_API_KEY;
    delete process.env.OCR_SERVICE_URL;
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalApiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalApiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (originalOcrUrl !== undefined) {
      process.env.OCR_SERVICE_URL = originalOcrUrl;
    } else {
      delete process.env.OCR_SERVICE_URL;
    }
    global.fetch = originalFetch;
  });

  it('debe extraer metadatos universales con el motor heurístico local cuando no hay GEMINI_API_KEY', async () => {
    // Arrange
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 2,
      text: `
        FACTURA A N° 0004-00018923
        Razón Social: Papelera Industrial del Sur S.A.
        CUIT: 30-71234567-9
        Fecha: 15/10/2026
        Responsable: Martín Gómez
        Total: $ 145.200,50
      `,
    });

    // Act
    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 fake'),
      'factura_octubre.pdf',
    );

    // Assert
    expect(result.extractionEngine).toBe('local_parser');
    expect(result.documentType).toBe('factura');
    expect(result.issuerTaxId).toBe('30-71234567-9');
    expect(result.documentDate).toBe('2026-10-15');
    expect(result.responsiblePerson).toBe('Martín Gómez');
    expect(result.totalAmount).toBe(145200.5);
    expect(result.pageCount).toBe(2);
  });

  it('debe invocar Gemini en modo gemini_text cuando el PDF tiene capa de texto digital suficiente', async () => {
    // Arrange
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    const richNativeText =
      'CONTRATO DE LOCACIÓN DE SERVICIOS TÉCNICOS celebrado entre HelpCopies S.R.L. y Clínica Central S.A. por mantenimiento mensual de equipos multifunción.';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 4,
      text: richNativeText,
    });

    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        usageMetadata: { totalTokenCount: 620 },
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    documentType: 'contrato_servicios',
                    summary: 'Contrato anual de mantenimiento de impresoras multifunción.',
                    documentNumber: 'CONT-2026-88',
                    documentDate: '2026-10-01',
                    issuerName: 'HelpCopies S.R.L.',
                    recipientName: 'Clínica Central S.A.',
                    responsiblePerson: 'Dra. Laura Méndez',
                    currency: 'ARS',
                    totalAmount: 380000,
                    tags: ['contrato', 'mantenimiento'],
                    attributes: { vigencia_meses: 12, cantidad_equipos: 6 },
                    items: [],
                    involvedParties: [{ name: 'Dra. Laura Méndez', role: 'firmante', identifier: null }],
                    rawText: richNativeText,
                    aiConfidence: 0.96,
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as any;

    // Act
    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 digital'),
      'contrato_clinica.pdf',
    );

    // Assert
    expect(result.extractionEngine).toBe('gemini_text');
    expect(result.documentType).toBe('contrato_servicios');
    expect(result.responsiblePerson).toBe('Dra. Laura Méndez');
    expect(result.extractedData.attributes.vigencia_meses).toBe(12);
    expect(result.tokensUsed).toBe(620);
  });

  it('debe usar gemini_vision multimodal cuando el PDF proviene de un escáner HP sin texto embebido', async () => {
    // Arrange
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: '   ',
    });

    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        usageMetadata: { totalTokenCount: 1120 },
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    documentType: 'remito',
                    summary: 'Remito escaneado de entrega de insumos firmado en recepción.',
                    documentNumber: 'R-0001-00004412',
                    documentDate: '2026-10-29',
                    issuerName: 'Insumos Gráficos Norte',
                    responsiblePerson: 'Carlos Pereyra',
                    tags: ['remito', 'escaneo'],
                    attributes: { bultos: 3, estado_firma: 'firmado_manuscrito' },
                    rawText: 'REMITO R-0001-00004412 Recibió conforme: Carlos Pereyra',
                    aiConfidence: 0.93,
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as any;

    // Act
    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 scanned image'),
      'HP_Scan_004412.pdf',
    );

    // Assert
    expect(result.extractionEngine).toBe('gemini_vision');
    expect(result.documentType).toBe('remito');
    expect(result.responsiblePerson).toBe('Carlos Pereyra');
    const requestPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestPayload.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
  });

  it('debe enlistar artículos de factura ERP compacta (código, nombre, cantidad, precio sin IVA, precio final)', async () => {
    delete process.env.GEMINI_API_KEY;
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: `
        FACTURA 06/10/2026
        Señores: CHAYEH NOS S.R.L.
        Domicilio: RUTA 226 KM 60
        30-70841005-1
        800000001ALQUILEREQUIPO1.0039520.00039520.00
        ACT:8-ANT:7
        ID:7016
        890000001EXCEDENTEPORCOPIA1.000.0000.00
        Total: $ 47819.20
      `,
    });

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 test'),
      'factura_chayeh.pdf',
    );

    expect(result.extractedData.items).toHaveLength(2);
    expect(result.extractedData.items[0]).toEqual({
      codigo: '800000001',
      nombre: 'ALQUILER EQUIPO',
      cantidad: 1,
      precioSinIva: 39520,
      precioFinal: 39520,
    });
    expect(result.extractedData.items[1]).toEqual({
      codigo: '890000001',
      nombre: 'EXCEDENTE POR COPIA',
      cantidad: 1,
      precioSinIva: 0,
      precioFinal: 0,
    });
  });

  it('debe enlistar artículos de presupuesto técnico con viñetas y cantidades (sin precios individuales)', async () => {
    delete process.env.GEMINI_API_KEY;
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: `
        SERVICIO TÉCNICO
        Mar del Plata 20 de abril de 2022
        Razón social: ACOSTA ALICIA
         UNI FOTOCONDUCTORA MP 201-1515 (1)
         ROD. FUS. SUPERIOR MP 171/201 (1)
         UÑAS FUSOR MP 171/201 (3)
         THERMISTOR MP 171/201/301 (1)
         MANO DE OBRA (1)
        Total: $ 36500 + IVA
      `,
    });

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 test'),
      'presupuesto_acosta.pdf',
    );

    expect(result.extractedData.items).toHaveLength(5);
    expect(result.extractedData.items[0].nombre).toBe('UNI FOTOCONDUCTORA MP 201-1515');
    expect(result.extractedData.items[0].cantidad).toBe(1);
    expect(result.extractedData.items[0].codigo).toBeNull();
    expect(result.extractedData.items[2].nombre).toBe('UÑAS FUSOR MP 171/201');
    expect(result.extractedData.items[2].cantidad).toBe(3);
    expect(result.extractedData.items[4].nombre).toBe('MANO DE OBRA');
  });

  it('debe enlistar artículos de nota de pedido con códigos prefijados e IVA', async () => {
    delete process.env.GEMINI_API_KEY;
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: `
        NOTA DE PEDIDO
        15 de junio de 2023
        Razón social: Abete y CIA SA
        HC 1 - M320F $ 235000 21 % $ 49350 $ 284350
        BK 1 - TONER TIPO SP 3710X $ 17000
        Total: $ 301350
      `,
    });

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 test'),
      'nota_pedido_abete.pdf',
    );

    expect(result.extractedData.items).toHaveLength(2);
    expect(result.extractedData.items[0]).toEqual({
      codigo: 'HC 1',
      nombre: 'M320F',
      cantidad: 1,
      precioSinIva: 235000,
      precioFinal: 284350,
      ivaPorcentaje: 21,
    });
    expect(result.extractedData.items[1]).toEqual({
      codigo: 'BK 1',
      nombre: 'TONER TIPO SP 3710X',
      cantidad: 1,
      precioSinIva: 17000,
      precioFinal: 17000,
      ivaPorcentaje: null,
    });
  });

  it('debe usar gemini_text sin visión cuando OCR Python reporta PDF digital nativo (python_pymupdf_native)', async () => {
    process.env.OCR_SERVICE_URL = 'http://localhost:8000';
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    const nativeDigitalText =
      'FACTURA ELECTRONICA A 00008-00041980 RAZON SOCIAL: PROVEEDOR DIGITAL SRL CUIT: 30-70999888-1 TOTAL $ 125000';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: nativeDigitalText,
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentType: 'factura',
          summary: 'Factura digital nativa',
          rawText: nativeDigitalText,
          pageCount: 1,
          extractionEngine: 'python_pymupdf_native',
          items: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usageMetadata: { totalTokenCount: 950 },
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documentType: 'factura_a',
                      summary: 'Factura electrónica emitida por Proveedor Digital SRL.',
                      documentNumber: '00008-00041980',
                      issuerName: 'PROVEEDOR DIGITAL SRL',
                      totalAmount: 125000,
                      items: [],
                      aiConfidence: 0.98,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    global.fetch = fetchMock as any;

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 digital'),
      'factura_digital.pdf',
    );

    expect(result.extractionEngine).toBe('gemini_text');
    expect(result.documentNumber).toBe('00008-00041980');
    expect(result.tokensUsed).toBe(950);
    const geminiBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(geminiBody.contents[0].parts).toHaveLength(1);
    expect(geminiBody.contents[0].parts[0].inlineData).toBeUndefined();
  });

  it('debe combinar OCR Python (python_tesseract_ocr) con gemini_vision en remitos/facturas escaneados o manuscritos', async () => {
    process.env.OCR_SERVICE_URL = 'http://localhost:8000';
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: '',
    });

    const tesseractHeaderOnly =
      'IMPRENTA SUR - REMITO R Nro 0001-00001234 - CUIT 30-71112223-4 - Senores:';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentType: 'remito',
          summary: 'Remito escaneado parcial',
          issuerTaxId: '30-71112223-4',
          rawText: tesseractHeaderOnly,
          pageCount: 1,
          extractionEngine: 'python_tesseract_ocr',
          items: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usageMetadata: { totalTokenCount: 2150 },
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documentType: 'remito',
                      summary: 'Remito manual entregado a Ferretería Norte con 2 ítems manuscritos.',
                      documentNumber: '00001-00001234',
                      issuerTaxId: '30-71112223-4',
                      recipientName: 'Ferretería Norte',
                      responsiblePerson: 'Juan Pérez',
                      items: [
                        { description: 'Resma A4 75g', quantity: 10 },
                        { description: 'Tóner HP 85A', quantity: 2 },
                      ],
                      rawText:
                        'REMITO R 0001-00001234 Señores: Ferretería Norte | 10 Resma A4 75g | 2 Tóner HP 85A | Recibió: Juan Pérez',
                      aiConfidence: 0.89,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    global.fetch = fetchMock as any;

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 scanned handwritten'),
      'remito_manuscrito.pdf',
    );

    expect(result.extractionEngine).toBe('gemini_vision');
    expect(result.recipientName).toBe('Ferretería Norte');
    expect(result.responsiblePerson).toBe('Juan Pérez');
    expect(result.items).toHaveLength(2);
    expect(result.rawText).toContain('Ferretería Norte');
    expect(result.tokensUsed).toBe(2150);

    const geminiBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(geminiBody.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
    expect(geminiBody.contents[0].parts[1].text).toContain('Texto OCR auxiliar obtenido por Tesseract');
    expect(geminiBody.contents[0].parts[1].text).toContain('30-71112223-4');
  });

  it('debe devolver la extracción base de Python si Gemini Vision falla en un escaneo', async () => {
    process.env.OCR_SERVICE_URL = 'http://localhost:8000';
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: '',
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentType: 'remito',
          summary: 'Extracción base OCR',
          issuerTaxId: '30-71112223-4',
          rawText: 'REMITO R 0001-00009999 CUIT 30-71112223-4',
          pageCount: 1,
          extractionEngine: 'python_tesseract_ocr',
          items: [],
        }),
      })
      .mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Gemini internal error',
      });
    global.fetch = fetchMock as any;

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 scanned fallback'),
      'remito_fallback.pdf',
    );

    expect(result.extractionEngine).toBe('python_tesseract_ocr');
    expect(result.issuerTaxId).toBe('30-71112223-4');
  });

  it('debe distinguir Emisor (cabecera AFIP Razón Social) de Receptor (bloque cliente) en heurística local', async () => {
    delete process.env.GEMINI_API_KEY;
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: `
        FACTURA A ORIGINAL
        Razón Social: DISTRIBUIDORA DEL SUR S.R.L.
        CUIT: 30-70841005-1
        Domicilio Comercial: Av. Colón 1234
        Apellido y Nombre / Razón Social: FERRETERIA NORTE S.A.
        CUIT: 30-71234567-9
        Total: $ 85000.00
      `,
    });

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 afip header'),
      'factura_afip.pdf',
    );

    expect(result.issuerName).toBe('DISTRIBUIDORA DEL SUR S.R.L.');
    expect(result.issuerTaxId).toBe('30-70841005-1');
    expect(result.recipientName).toBe('FERRETERIA NORTE S.A.');
    expect(result.recipientTaxId).toBe('30-71234567-9');
  });

  it('debe rescatar con gemini_vision cuando gemini_text devuelve issuerName vacío por venir en un logo', async () => {
    process.env.GEMINI_API_KEY = 'fake-gemini-key';
    const nativeWithoutLogoText =
      'FACTURA A Nro 00004-00009911 Fecha 24/11/2026 Señores: SUPERMERCADO CENTRO S.A. CUIT 30-71234567-9 Importe Total $ 250000';
    mockedPdfParse.mockResolvedValueOnce({
      numpages: 1,
      text: nativeWithoutLogoText,
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usageMetadata: { totalTokenCount: 700 },
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documentType: 'factura_a',
                      summary: 'Factura A hacia Supermercado Centro',
                      documentNumber: '00004-00009911',
                      issuerName: null,
                      recipientName: 'SUPERMERCADO CENTRO S.A.',
                      recipientTaxId: '30-71234567-9',
                      totalAmount: 250000,
                      items: [],
                      aiConfidence: 0.91,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usageMetadata: { totalTokenCount: 1300 },
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documentType: 'factura_a',
                      summary: 'Factura A emitida por Acme Equipos S.A. (detectado en logo)',
                      documentNumber: '00004-00009911',
                      issuerName: 'ACME EQUIPOS S.A.',
                      issuerTaxId: '30-70841005-1',
                      recipientName: 'SUPERMERCADO CENTRO S.A.',
                      recipientTaxId: '30-71234567-9',
                      totalAmount: 250000,
                      items: [],
                      aiConfidence: 0.96,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    global.fetch = fetchMock as any;

    const result = await service.extractFromBuffer(
      Buffer.from('%PDF-1.4 native with graphic logo'),
      'factura_con_logo.pdf',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.extractionEngine).toBe('gemini_vision');
    expect(result.issuerName).toBe('ACME EQUIPOS S.A.');
    expect(result.recipientName).toBe('SUPERMERCADO CENTRO S.A.');
    expect(result.tokensUsed).toBe(2000);
    const secondPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondPayload.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
  });
});

