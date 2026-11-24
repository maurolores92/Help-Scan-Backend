import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { readDecryptedVaultFile } from '../../../common/utils/vault-crypto.util';
import pdfParse = require('pdf-parse');
import {
  extractUniversalHeuristicsFromText,
  UniversalDocumentExtractionResult,
} from '../helpers/local-pdf-heuristics.helper';

const MIN_NATIVE_TEXT_LENGTH = 80;
const MAX_GEMINI_VISION_PDF_BYTES = 15 * 1024 * 1024;

const EXTRACTION_SYSTEM_PROMPT = `Eres un motor experto de análisis documental y extracción semántica empresarial multirubro, especializado en comprobantes fiscales, comerciales, técnicos y administrativos de Argentina y Latinoamérica.

INSTRUCCIONES CLAVE DE EXTRACCIÓN Y NORMALIZACIÓN:
1. Comprobantes fiscales y comerciales:
   - Identifica el tipo exacto: "factura_a", "factura_b", "factura_c", "remito", "presupuesto", "nota_pedido", "orden_compra", "recibo", "orden_servicio", "contrato", "legajo", "otro".
   - Número de documento: Si tiene punto de venta o sucursal, normaliza a formato de 5 y 8 dígitos ej: "00008-00041980" o el identificador visible.
   - Emisor vs Receptor: Distingue con precisión quién emite la factura (proveedor/prestador) y quién la recibe (cliente/señores/domicilio de entrega).
   - CUITs: Formato XX-XXXXXXXX-X (11 dígitos). Corrige automáticamente errores ópticos comunes de OCR (como letra 'O' por número '0', o barras '/' por guiones '-').
   - CAE: Si figura CAE de AFIP (código de 14 dígitos numéricos), extráelo limpio en "cae".
   - Condición fiscal de IVA: Clasifica estrictamente en una de: "Responsable Inscripto", "Monotributo", "Exento", "Consumidor Final", "No Responsable".
   - Fechas: Normaliza siempre a formato ISO "YYYY-MM-DD".
   - Montos numéricos: Extrae valores numéricos flotantes limpios (ej: 154200.50), sin símbolos de moneda ni separadores de miles.
     * "netAmount": subtotal o base imponible neta sin impuestos.
     * "taxAmount": total de IVA u otros tributos.
     * "totalAmount": importe total final a pagar.
   - Ítems / Artículos: Extrae cada renglón de producto o servicio con { "code": string|null, "description": string, "quantity": number|null, "unitPrice": number|null, "subtotal": number|null }.
   - Equipos y Servicios Técnicos: Si el comprobante menciona impresoras, fotocopiadoras o máquinas (ej. HP LaserJet, Ricoh MP), extrae "equipmentId" (ej: "7016"), "equipmentModel" (ej: "HP LaserJet Managed E52645") y "meterCount" (contadores ej: "ACT:8 - ANT:7").
   - Documentos escaneados, fotos o manuscritos (remitos / facturas manuales):
     * Si recibes la imagen/PDF junto con texto OCR auxiliar, prioriza siempre lo que observas visualmente en la imagen del documento (el OCR puede omitir o deformar texto escrito a mano).
     * Transcribe con cuidado renglones, cantidades, cliente, fecha, importes y persona firmante/receptora aunque estén en letra manuscrita.
     * Si algún dato escrito a mano tiene tachaduras, papel carbónico borroso o trazos dudosos, reduce "aiConfidence" (por debajo de 0.75) e indícalo brevemente en "summary" para facilitar la validación manual.
     * Cuando analices un documento visualmente (imagen/escaneo), incluye en "rawText" una transcripción legible completa (datos preimpresos + manuscritos) para indexación y búsqueda interna.

Analiza el texto o documento y devuelve ESTRICTAMENTE un objeto JSON válido (sin bloques markdown ni explicaciones adicionales) con esta estructura exacta:
{
  "documentType": "string en snake_case minúscula (ej: factura, remito, nota_pedido, presupuesto, orden_compra, recibo, orden_servicio, contrato, legajo, etc.)",
  "summary": "resumen ejecutivo claro en español (1 a 2 oraciones) con los datos más importantes",
  "documentNumber": "string o null (número de comprobante con punto de venta ej: 00008-00041980, expediente o remito)",
  "documentDate": "YYYY-MM-DD o null (fecha principal del documento)",
  "dueDate": "YYYY-MM-DD o null (fecha de vencimiento del pago o validez de la oferta)",
  "issuerName": "string o null (nombre/razón social del proveedor, emisor o prestador)",
  "issuerTaxId": "string o null (CUIT, RUT, DNI o identificador fiscal del emisor en formato XX-XXXXXXXX-X)",
  "recipientName": "string o null (cliente, destinatario o receptor)",
  "recipientTaxId": "string o null (CUIT, DNI o identificador fiscal del cliente en formato XX-XXXXXXXX-X)",
  "recipientPhone": "string o null (teléfono o celular de contacto)",
  "recipientEmail": "string o null (correo electrónico de contacto)",
  "deliveryAddress": "string o null (domicilio de entrega, localidad o dirección)",
  "responsiblePerson": "string o null (persona responsable, contacto comercial, técnico firmante o solicitante)",
  "currency": "ARS | USD | EUR | null",
  "netAmount": "number o null (subtotal o importe neto gravado sin impuestos)",
  "taxAmount": "number o null (monto total de IVA u otros impuestos)",
  "totalAmount": "number o null (monto final total a pagar numérico, ej: 47819.20)",
  "paymentTerms": "string o null (condición de venta, ej: CTA. CTE. 15 DIAS, contado, cheque, validez 5 días)",
  "paymentMethod": "string o null (Transferencia Bancaria, Cheque, Efectivo, etc.)",
  "referenceNumber": "string o null (número de orden de compra o remito asociado si figura)",
  "cae": "string o null (código CAE de AFIP de 14 dígitos continuos)",
  "taxCondition": "Responsable Inscripto | Monotributo | Exento | Consumidor Final | No Responsable | null",
  "documentLetter": "A | B | C | M | E | R | X | null",
  "pointOfSale": "string o null (4 o 5 dígitos ej: 0001, 00014)",
  "caeDueDate": "YYYY-MM-DD o null",
  "purchaseOrderNumber": "string o null (número de Orden de Compra)",
  "exemptAmount": "number o null (monto exento o no gravado)",
  "otherTaxesAmount": "number o null (percepciones IIBB u otros tributos)",
  "carrierName": "string o null (empresa de transporte o transportista)",
  "department": "string o null (sector o centro de costos)",
  "branch": "string o null (sucursal o depósito)",
  "period": "string o null (período facturado)",
  "tags": ["etiquetas clave en español minúscula"],
  "attributes": { "clave_dinamica_snake_case": "cualquier dato propio relevante" },
  "items": [ { "code": "string|null", "description": "string", "quantity": "number|null", "unitPrice": "number|null", "subtotal": "number|null" } ],
  "involvedParties": [ { "name": "string", "role": "string", "identifier": "string|null" } ],
  "dates": { "vencimiento": "YYYY-MM-DD" },
  "amounts": { "subtotal": 0, "impuestos": 0 },
  "rawText": "string o null (solo cuando analizas el PDF/imagen visualmente: transcripción completa legible de impreso + manuscrito)",
  "aiConfidence": 0.95
}`;

const ANSI_GREEN = '\x1b[92m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

/**
 * Servicio de extracción documental de alto rendimiento:
 * 1) Inspecciona y extrae capa de texto nativo con `pdf-parse` en milisegundos.
 * 2) Si EXTRACTION_MODE='local' o sin GEMINI_API_KEY: usa extracción 100% local instantánea (~50ms).
 * 3) Si EXTRACTION_MODE='hybrid' con GEMINI_API_KEY: usa Gemini solo para clasificar metadatos clave en un JSON liviano
 *    sin re-transcribir todo el texto nativo (reduce el tiempo de 45s a ~1.5s).
 */
@Injectable()
export class DocumentAiExtractorService implements OnModuleInit {
  private readonly logger = new Logger(DocumentAiExtractorService.name);

  async onModuleInit() {
    const ocrUrl = process.env.OCR_SERVICE_URL?.trim();
    if (ocrUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const target = `${ocrUrl.replace(/\/+$/, '')}/health`;
        const res = await fetch(target, { signal: controller.signal });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          console.log(
            `\n${ANSI_GREEN}${ANSI_BOLD}✔ [CONEXIÓN OCR PYTHON EXITOSA] Microservicio OCR activo en ${ocrUrl} (Estado: ${body.status || 'OK'}, Motor: ${body.service || 'HC-Scan OCR'})${ANSI_RESET}`
          );
          this.logger.log(
            `🚀 [OCR Microservice] Conexión exitosa con Python en ${ocrUrl} (Status: ${body.status || 'OK'}, Motor: ${body.service || 'HC-Scan OCR'})`,
          );
        } else {
          this.logger.warn(
            `⚠️ [OCR Microservice] Respondió con código HTTP ${res.status} al verificar salud en ${target}`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `⚠️ [OCR Microservice] No se pudo verificar conexión al iniciar en ${ocrUrl} (${err?.message}). Verifique que el servicio OCR esté en ejecución en la misma red de Coolify.`,
        );
      } finally {
        clearTimeout(timeout);
      }
    } else {
      this.logger.log(
        '[OCR Microservice] No se configuró OCR_SERVICE_URL. Operando en modo local nativo (pdf-parse).',
      );
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
    const effectiveModel = model === 'gemini-2.5-flash' ? 'gemini-3.5-flash' : model;
    const mode = (process.env.EXTRACTION_MODE || (apiKey ? 'hybrid' : 'local')).toUpperCase();

    if (apiKey) {
      console.log(
        `${ANSI_GREEN}${ANSI_BOLD}✔ [IA GEMINI CONECTADA] API Key detectada | Modelo primario: ${effectiveModel} (con cascada automática de fallback) | Modo: ${mode}${ANSI_RESET}\n`
      );
    } else {
      console.log(
        `\x1b[93m⚠️ [IA GEMINI] No se detectó GEMINI_API_KEY en variables de entorno. Extracción operará en modo local.\x1b[0m\n`
      );
    }
  }

  async extractFromFile(
    fullFilePath: string,
    originalFileName: string,
    companyId?: number,
  ): Promise<UniversalDocumentExtractionResult> {
    const fileBuffer =
      typeof companyId === 'number'
        ? readDecryptedVaultFile(fullFilePath, companyId)
        : readFileSync(fullFilePath);
    return this.extractFromBuffer(fileBuffer, originalFileName);
  }

  async extractFromBuffer(
    fileBuffer: Buffer,
    originalFileName: string,
  ): Promise<UniversalDocumentExtractionResult> {
    const { nativeText, pageCount } = await this.parseNativePdf(fileBuffer);
    const printableChars = nativeText.replace(/\s+/g, '').length;
    const hasCleanNativeText = printableChars >= MIN_NATIVE_TEXT_LENGTH;

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    const extractionMode = (process.env.EXTRACTION_MODE || (apiKey ? 'hybrid' : 'local')).toLowerCase().trim();

    // 1. Si existe microservicio Python de OCR configurado (PyMuPDF + Tesseract en español), delegarle la extracción óptica
    const ocrUrl = process.env.OCR_SERVICE_URL?.trim();
    if (ocrUrl) {
      try {
        const pythonResult = await this.callPythonOcrService(fileBuffer, originalFileName, ocrUrl);
        if (pythonResult) {
          // Si disponemos de GEMINI_API_KEY y no estamos en modo forzado 'local', complementamos OCR + Gemini:
          // - PDFs digitales nativos ('python_pymupdf_native') -> gemini_text (rápido y económico)
          // - Escaneos, fotos o manuscritos ('python_tesseract_ocr' o sin texto nativo) -> gemini_vision + texto OCR auxiliar
          if (apiKey && extractionMode !== 'local') {
            const rawTextToAnalyze = (pythonResult.rawText || nativeText || '').trim();
            const isRasterOrLowText =
              pythonResult.extractionEngine === 'python_tesseract_ocr' ||
              pythonResult.extractionEngine === 'python_ocr' ||
              (!hasCleanNativeText && rawTextToAnalyze.length < MIN_NATIVE_TEXT_LENGTH);
            const useVisionForPython =
              isRasterOrLowText && fileBuffer.length <= MAX_GEMINI_VISION_PDF_BYTES;

            if (useVisionForPython || rawTextToAnalyze.length >= 15) {
              const targetMode: 'gemini_vision' | 'gemini_text' = useVisionForPython
                ? 'gemini_vision'
                : 'gemini_text';
              const modeLog = useVisionForPython
                ? `👁️ Documento escaneado/manuscrito (${pythonResult.extractionEngine}) para '${originalFileName}'. Complementando OCR (${rawTextToAnalyze.length} chars) con Gemini Vision...`
                : `🧠 Enriqueciendo texto nativo OCR de Python con Gemini (${process.env.GEMINI_MODEL || 'gemini-3.5-flash'}) para '${originalFileName}' (${rawTextToAnalyze.length} caracteres)...`;

              try {
                this.logger.log(`[DocumentAiExtractor] ${modeLog}`);
                return await this.callGeminiExtractor({
                  apiKey,
                  mode: targetMode,
                  nativeText: rawTextToAnalyze,
                  fileBuffer,
                  originalFileName,
                  pageCount: pythonResult.pageCount || pageCount || 1,
                  fallbackResult: pythonResult,
                });
              } catch (geminiErr: any) {
                this.logger.warn(
                  `[DocumentAiExtractor] ⚠️ Falló ${targetMode} (${geminiErr?.message}). Retornando extracción base de Python como fallback.`,
                );
                return pythonResult;
              }
            }
          }

          return pythonResult;
        }
      } catch (err: any) {
        this.logger.warn(
          `[DocumentAiExtractor] Microservicio Python no pudo procesar '${originalFileName}': ${err?.message}. Pasando a fallback local.`,
        );
      }
    }

    // 2. 100% Local / Biblioteca pdf-parse (Ultra rápido: ~50ms, 0 costo de IA)
    if (extractionMode === 'local' || !apiKey) {
      this.logger.log(
        `[DocumentAiExtractor] Extracción rápida 100% local (pdf-parse) para '${originalFileName}' (modo=${extractionMode})`,
      );
      return extractUniversalHeuristicsFromText(nativeText, originalFileName, pageCount);
    }

    try {
      if (hasCleanNativeText) {
        return await this.callGeminiExtractor({
          apiKey,
          mode: 'gemini_text',
          nativeText,
          fileBuffer,
          originalFileName,
          pageCount,
        });
      }

      return await this.callGeminiExtractor({
        apiKey,
        mode: 'gemini_vision',
        nativeText,
        fileBuffer,
        originalFileName,
        pageCount,
      });
    } catch (error: any) {
      this.logger.warn(
        `[DocumentAiExtractor] Falló extracción Gemini para '${originalFileName}' (${error?.message}). Aplicando fallback local inmediato.`,
      );
      return extractUniversalHeuristicsFromText(nativeText, originalFileName, pageCount);
    }
  }

  private async parseNativePdf(
    buffer: Buffer,
  ): Promise<{ nativeText: string; pageCount: number }> {
    try {
      const parsed = await pdfParse(buffer);
      return {
        nativeText: (parsed?.text || '').trim(),
        pageCount: Number(parsed?.numpages || 1),
      };
    } catch (err: any) {
      this.logger.warn(`No se pudo extraer capa nativa con pdf-parse: ${err?.message}`);
      return { nativeText: '', pageCount: 1 };
    }
  }

  private async callGeminiExtractor(params: {
    apiKey: string;
    mode: 'gemini_text' | 'gemini_vision';
    nativeText: string;
    fileBuffer: Buffer;
    originalFileName: string;
    pageCount: number;
    fallbackResult?: UniversalDocumentExtractionResult;
  }): Promise<UniversalDocumentExtractionResult> {
    const userModel = process.env.GEMINI_MODEL?.trim();
    const primaryModel =
      !userModel || userModel === 'gemini-2.5-flash' ? 'gemini-3.5-flash' : userModel;

    // Cascada de modelos en orden de resiliencia
    const candidateModels = Array.from(
      new Set([
        primaryModel,
        'gemini-3.5-flash',
        'gemini-flash-lite-latest',
        'gemini-3.8-flash',
        'gemini-flash-latest',
      ]),
    );

    const auxiliaryOcrText = params.nativeText?.trim() || '';
    const ocrSupportPrompt = auxiliaryOcrText
      ? `\n\nTexto OCR auxiliar obtenido por Tesseract (útil para corroborar membretes o códigos impresos; puede omitir o confundir letra manuscrita, priorizá siempre lo que ves en la imagen del PDF):\n${auxiliaryOcrText.slice(0, 15000)}`
      : '';

    const parts: any[] =
      params.mode === 'gemini_text'
        ? [
          {
            text: `${EXTRACTION_SYSTEM_PROMPT}\n\nNombre del archivo: ${params.originalFileName}\nCantidad de páginas: ${params.pageCount}\n\nTexto extraído (OCR / Capa Nativa):\n${params.nativeText.slice(0, 50000)}`,
          },
        ]
        : [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: params.fileBuffer.toString('base64'),
            },
          },
          {
            text: `${EXTRACTION_SYSTEM_PROMPT}\n\nNombre original del archivo escaneado: ${params.originalFileName}\nCantidad de páginas: ${params.pageCount}${ocrSupportPrompt}`,
          },
        ];

    let json: any = null;
    let successfulModel = '';
    let lastError: Error | null = null;

    for (const model of candidateModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${params.apiKey}`;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
              maxOutputTokens: 4096,
            },
          }),
        });

        if (!response.ok) {
          const errBody = await response.text();
          // 404 = modelo discontinuado o no disponible para la cuenta
          // 503 = sobrecarga momentánea en Google
          // 429 = límite de tasa momentáneo
          if ([404, 503, 429].includes(response.status)) {
            this.logger.warn(
              `[DocumentAiExtractor] Modelo '${model}' devolvió HTTP ${response.status}. Activando siguiente modelo en cascada...`,
            );
            lastError = new Error(`HTTP ${response.status} en '${model}': ${errBody.slice(0, 150)}`);
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 250)}`);
        }

        json = await response.json();
        successfulModel = model;
        break;
      } catch (reqErr: any) {
        lastError = reqErr;
        const isLast = candidateModels.indexOf(model) === candidateModels.length - 1;
        if (!isLast) {
          this.logger.warn(
            `[DocumentAiExtractor] Reintentando tras error con modelo '${model}' (${reqErr?.message})...`,
          );
        }
      }
    }

    if (!json || !successfulModel) {
      throw lastError || new Error('Ningún modelo Gemini respondió exitosamente');
    }

    const rawCandidate = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const tokensUsed = Number(json?.usageMetadata?.totalTokenCount || 0);
    const parsed = this.safeParseJsonObject(rawCandidate);

    const normalizedType = String(parsed.documentType || 'documento_general')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 80);

    const parsedTotal =
      parsed.totalAmount !== null && parsed.totalAmount !== undefined && parsed.totalAmount !== ''
        ? Number(parsed.totalAmount)
        : null;

    const parsedNet =
      parsed.netAmount !== null && parsed.netAmount !== undefined && parsed.netAmount !== ''
        ? Number(parsed.netAmount)
        : null;

    const parsedTax =
      parsed.taxAmount !== null && parsed.taxAmount !== undefined && parsed.taxAmount !== ''
        ? Number(parsed.taxAmount)
        : null;

    // Fallback prioritario: resultado base de Python o heurísticas locales
    const fallback =
      params.fallbackResult ||
      extractUniversalHeuristicsFromText(
        params.nativeText,
        params.originalFileName,
        params.pageCount,
      );

    // Normalización de ítems / artículos de la tabla para coincidencia con el modal
    const rawItems =
      Array.isArray(parsed.items) && parsed.items.length > 0
        ? parsed.items
        : Array.isArray(fallback.items) && fallback.items.length > 0
          ? fallback.items
          : Array.isArray(fallback.extractedData?.items) && fallback.extractedData.items.length > 0
            ? fallback.extractedData.items
            : [];

    const normalizedItems = rawItems.map((it: any, idx: number) => ({
      id: `item-${idx + 1}`,
      codigo: it.codigo || it.code || null,
      nombre: it.nombre || it.description || it.descripcion || `Artículo #${idx + 1}`,
      cantidad:
        it.cantidad !== null && it.cantidad !== undefined && !isNaN(Number(it.cantidad))
          ? Number(it.cantidad)
          : it.quantity !== null && it.quantity !== undefined && !isNaN(Number(it.quantity))
            ? Number(it.quantity)
            : 1,
      precioSinIva:
        it.precioSinIva !== null && it.precioSinIva !== undefined && !isNaN(Number(it.precioSinIva))
          ? Number(it.precioSinIva)
          : it.precio_sin_iva !== null && it.precio_sin_iva !== undefined && !isNaN(Number(it.precio_sin_iva))
            ? Number(it.precio_sin_iva)
            : it.unitPrice !== null && it.unitPrice !== undefined && !isNaN(Number(it.unitPrice))
              ? Number(it.unitPrice)
              : null,
      precioFinal:
        it.precioFinal !== null && it.precioFinal !== undefined && !isNaN(Number(it.precioFinal))
          ? Number(it.precioFinal)
          : it.precio_final !== null && it.precio_final !== undefined && !isNaN(Number(it.precio_final))
            ? Number(it.precio_final)
            : it.subtotal !== null && it.subtotal !== undefined && !isNaN(Number(it.subtotal))
              ? Number(it.subtotal)
              : null,
      ivaPorcentaje:
        it.ivaPorcentaje !== null && it.ivaPorcentaje !== undefined && !isNaN(Number(it.ivaPorcentaje))
          ? Number(it.ivaPorcentaje)
          : it.iva_porcentaje !== null && it.iva_porcentaje !== undefined && !isNaN(Number(it.iva_porcentaje))
            ? Number(it.iva_porcentaje)
            : null,
    }));

    const result: UniversalDocumentExtractionResult = {
      documentType: normalizedType || fallback.documentType,
      summary: String(parsed.summary || fallback.summary),
      documentNumber: parsed.documentNumber ? String(parsed.documentNumber).slice(0, 100) : fallback.documentNumber,
      documentDate:
        typeof parsed.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.documentDate)
          ? parsed.documentDate
          : fallback.documentDate,
      dueDate:
        typeof parsed.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate)
          ? parsed.dueDate
          : fallback.dueDate,
      issuerName: parsed.issuerName ? String(parsed.issuerName).slice(0, 200) : fallback.issuerName,
      issuerTaxId: parsed.issuerTaxId ? String(parsed.issuerTaxId).slice(0, 50) : fallback.issuerTaxId,
      recipientName: parsed.recipientName ? String(parsed.recipientName).slice(0, 200) : fallback.recipientName,
      recipientTaxId: parsed.recipientTaxId ? String(parsed.recipientTaxId).slice(0, 50) : fallback.recipientTaxId,
      recipientPhone: parsed.recipientPhone ? String(parsed.recipientPhone).slice(0, 50) : fallback.recipientPhone,
      recipientEmail: parsed.recipientEmail ? String(parsed.recipientEmail).slice(0, 100) : fallback.recipientEmail,
      deliveryAddress: parsed.deliveryAddress ? String(parsed.deliveryAddress).slice(0, 255) : fallback.deliveryAddress,
      responsiblePerson: parsed.responsiblePerson
        ? String(parsed.responsiblePerson).slice(0, 200)
        : fallback.responsiblePerson,
      currency: parsed.currency ? String(parsed.currency).slice(0, 10) : fallback.currency,
      netAmount: parsedNet !== null && Number.isFinite(parsedNet) ? parsedNet : fallback.netAmount,
      taxAmount: parsedTax !== null && Number.isFinite(parsedTax) ? parsedTax : fallback.taxAmount,
      totalAmount: parsedTotal !== null && Number.isFinite(parsedTotal) ? parsedTotal : fallback.totalAmount,
      paymentTerms: parsed.paymentTerms ? String(parsed.paymentTerms).slice(0, 150) : fallback.paymentTerms,
      paymentMethod: parsed.paymentMethod ? String(parsed.paymentMethod).slice(0, 60) : fallback.paymentMethod,
      referenceNumber: parsed.referenceNumber ? String(parsed.referenceNumber).slice(0, 100) : fallback.referenceNumber,
      cae: parsed.cae ? String(parsed.cae).slice(0, 30) : fallback.cae,
      taxCondition: parsed.taxCondition ? String(parsed.taxCondition).slice(0, 60) : fallback.taxCondition,
      documentLetter: parsed.documentLetter ? String(parsed.documentLetter).slice(0, 5).toUpperCase() : fallback.documentLetter,
      pointOfSale: parsed.pointOfSale ? String(parsed.pointOfSale).slice(0, 10) : fallback.pointOfSale,
      caeDueDate: parsed.caeDueDate ? String(parsed.caeDueDate).slice(0, 10) : fallback.caeDueDate,
      purchaseOrderNumber: parsed.purchaseOrderNumber ? String(parsed.purchaseOrderNumber).slice(0, 100) : fallback.purchaseOrderNumber,
      exemptAmount: typeof parsed.exemptAmount === 'number' ? parsed.exemptAmount : fallback.exemptAmount,
      otherTaxesAmount: typeof parsed.otherTaxesAmount === 'number' ? parsed.otherTaxesAmount : fallback.otherTaxesAmount,
      carrierName: parsed.carrierName ? String(parsed.carrierName).slice(0, 150) : fallback.carrierName,
      department: parsed.department ? String(parsed.department).slice(0, 100) : fallback.department,
      branch: parsed.branch ? String(parsed.branch).slice(0, 100) : fallback.branch,
      period: parsed.period ? String(parsed.period).slice(0, 50) : fallback.period,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 15)
        : fallback.tags,
      items: normalizedItems,
      extractedData: {
        attributes: {
          ...fallback.extractedData.attributes,
          ...(parsed.attributes && typeof parsed.attributes === 'object' ? parsed.attributes : {}),
          ...(parsed.cae ? { cae: parsed.cae } : {}),
          ...(parsed.documentLetter ? { letra: parsed.documentLetter } : {}),
          ...(parsed.purchaseOrderNumber ? { orden_compra: parsed.purchaseOrderNumber } : {}),
          ...(parsed.department ? { sector: parsed.department } : {}),
        },
        items: normalizedItems,
        involvedParties: Array.isArray(parsed.involvedParties) ? parsed.involvedParties : [],
        dates: {
          ...fallback.extractedData.dates,
          ...(parsed.dates && typeof parsed.dates === 'object' ? parsed.dates : {}),
        },
        amounts: {
          ...fallback.extractedData.amounts,
          ...(parsed.amounts && typeof parsed.amounts === 'object' ? parsed.amounts : {}),
        },
      },
      rawText:
        params.mode === 'gemini_vision'
          ? String(parsed.rawText || '').trim() || params.nativeText
          : params.nativeText || String(parsed.rawText || '').trim(),
      pageCount: params.pageCount,
      aiConfidence:
        typeof parsed.aiConfidence === 'number'
          ? Math.max(0, Math.min(1, parsed.aiConfidence))
          : 0.95,
      extractionEngine: params.mode,
      tokensUsed,
    };

    const docTypeLabel = (result.documentType || 'general').toUpperCase();
    const confPercent = ((result.aiConfidence || 0.95) * 100).toFixed(0);
    const totalDisplay = result.totalAmount !== null && result.totalAmount !== undefined ? `$ ${result.totalAmount.toLocaleString('es-AR')}` : 'No detectado';
    const issuerDisplay = result.issuerName || 'No detectado';
    const numberDisplay = result.documentNumber || 'S/N';

    console.log(
      `\n${ANSI_GREEN}${ANSI_BOLD}========================================================================${ANSI_RESET}` +
      `\n${ANSI_GREEN}${ANSI_BOLD}✔ [GEMINI IA EXITOSO]${ANSI_RESET} ${ANSI_GREEN}Estructuración y análisis inteligente completado para '${params.originalFileName}'${ANSI_RESET}` +
      `\n${ANSI_GREEN}  • Modelo IA: ${successfulModel} (${params.mode === 'gemini_text' ? 'Texto Semántico' : 'Visión Multimodal'})` +
      `\n${ANSI_GREEN}  • Tipo Clasificado: '${docTypeLabel}' | Emisor: '${issuerDisplay}'` +
      `\n${ANSI_GREEN}  • Importe Total: ${totalDisplay} | CUIT: ${result.issuerTaxId || 'S/D'}` +
      `\n${ANSI_GREEN}  • N° Comprobante: ${numberDisplay}${result.cae ? ` | CAE: ${result.cae}` : ''}` +
      `\n${ANSI_GREEN}  • Nivel de Confianza IA: ${confPercent}% | Tokens consumidos: ${tokensUsed}${ANSI_RESET}` +
      `\n${ANSI_GREEN}${ANSI_BOLD}========================================================================${ANSI_RESET}\n`
    );

    this.logger.log(
      `[DocumentAiExtractor] 🧠 Gemini IA estructuró exitosamente '${params.originalFileName}' como '${docTypeLabel}' (${confPercent}% confianza, ${tokensUsed} tokens)`,
    );

    return result;
  }

  private safeParseJsonObject(raw: string): Record<string, any> {
    if (!raw || typeof raw !== 'string') return {};

    // 1. Limpiar bloques markdown con posibles espacios o saltos de línea al final
    let cleaned = raw.trim();
    const markdownMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (markdownMatch && markdownMatch[1]) {
      cleaned = markdownMatch[1].trim();
    }

    // 2. Si todavía hay texto adicional antes o después, aislar entre '{' y '}'
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1).trim();
    }

    try {
      return JSON.parse(cleaned);
    } catch (err: any) {
      this.logger.warn(
        `[DocumentAiExtractor] Error al parsear JSON retornado por Gemini: ${err?.message}. Raw: ${raw.slice(0, 300)}`,
      );
      return {};
    }
  }

  private async callPythonOcrService(
    fileBuffer: Buffer,
    originalFileName: string,
    ocrBaseUrl: string,
  ): Promise<UniversalDocumentExtractionResult | null> {
    const candidateUrls = [ocrBaseUrl];
    if (ocrBaseUrl.includes('ocr:8000') && !candidateUrls.includes('http://localhost:8000')) {
      candidateUrls.push('http://localhost:8000');
    }

    for (const currentBase of candidateUrls) {
      const endpoint = `${currentBase.replace(/\/+$/, '')}/extract`;
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' });
      formData.append('file', blob, originalFileName);
      formData.append('original_name', originalFileName);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Microservicio Python retornó status ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const rawTextLength = (data.rawText || data.raw_text || '').length;
        const engineName = data.extractionEngine || data.extraction_engine || 'PyMuPDF + Tesseract OCR';
        const pages = data.pageCount || data.page_count || 1;

        console.log(
          `\n${ANSI_GREEN}${ANSI_BOLD}========================================================================${ANSI_RESET}` +
          `\n${ANSI_GREEN}${ANSI_BOLD}✔ [OCR PYTHON EXITOSO]${ANSI_RESET} ${ANSI_GREEN}Texto extraído correctamente de '${originalFileName}'${ANSI_RESET}` +
          `\n${ANSI_GREEN}  • Motor OCR: ${engineName}` +
          `\n${ANSI_GREEN}  • Páginas: ${pages} | Caracteres de texto obtenidos: ${rawTextLength.toLocaleString('es-AR')}${ANSI_RESET}` +
          `\n${ANSI_GREEN}${ANSI_BOLD}========================================================================${ANSI_RESET}\n`
        );

        this.logger.log(
          `[DocumentAiExtractor] ✅ OCR completado exitosamente por Python para '${originalFileName}' (${rawTextLength} chars, ${pages} págs)`,
        );
        return this.mapPythonResponseToResult(data, originalFileName);
      } catch (err: any) {
        const isLast = candidateUrls.indexOf(currentBase) === candidateUrls.length - 1;
        if (isLast) {
          this.logger.warn(
            `[DocumentAiExtractor] Microservicio Python no disponible en ${endpoint} (${err?.message}). Continuando automáticamente con extracción nativa local (pdf-parse) y estructuración Gemini.`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    return null;
  }

  private mapPythonResponseToResult(
    data: any,
    originalFileName: string,
  ): UniversalDocumentExtractionResult {
    const rawItems = Array.isArray(data.items) && data.items.length > 0
      ? data.items
      : Array.isArray(data.extractedData?.items) && data.extractedData.items.length > 0
        ? data.extractedData.items
        : Array.isArray(data.extracted_data?.items) && data.extracted_data.items.length > 0
          ? data.extracted_data.items
          : [];

    const items = rawItems.map((it: any, idx: number) => ({
      codigo: it.codigo || it.code || null,
      nombre: it.nombre || it.descripcion || it.description || `Ítem #${idx + 1}`,
      cantidad:
        it.cantidad !== null && it.cantidad !== undefined && !isNaN(Number(it.cantidad))
          ? Number(it.cantidad)
          : it.quantity !== null && it.quantity !== undefined && !isNaN(Number(it.quantity))
            ? Number(it.quantity)
            : 1,
      precioSinIva:
        it.precioSinIva !== null && it.precioSinIva !== undefined && !isNaN(Number(it.precioSinIva))
          ? Number(it.precioSinIva)
          : it.precio_sin_iva !== null && it.precio_sin_iva !== undefined && !isNaN(Number(it.precio_sin_iva))
            ? Number(it.precio_sin_iva)
            : it.unitPrice !== null && it.unitPrice !== undefined && !isNaN(Number(it.unitPrice))
              ? Number(it.unitPrice)
              : null,
      precioFinal:
        it.precioFinal !== null && it.precioFinal !== undefined && !isNaN(Number(it.precioFinal))
          ? Number(it.precioFinal)
          : it.precio_final !== null && it.precio_final !== undefined && !isNaN(Number(it.precio_final))
            ? Number(it.precio_final)
            : it.subtotal !== null && it.subtotal !== undefined && !isNaN(Number(it.subtotal))
              ? Number(it.subtotal)
              : null,
      ivaPorcentaje:
        it.ivaPorcentaje !== null && it.ivaPorcentaje !== undefined && !isNaN(Number(it.ivaPorcentaje))
          ? Number(it.ivaPorcentaje)
          : it.iva_porcentaje !== null && it.iva_porcentaje !== undefined && !isNaN(Number(it.iva_porcentaje))
            ? Number(it.iva_porcentaje)
            : null,
    }));

    return {
      documentType: data.documentType || data.document_type || 'otro',
      summary: data.summary || `Documento procesado con OCR (${originalFileName})`,
      documentNumber: data.documentNumber || data.document_number || null,
      documentDate: data.documentDate || data.document_date || null,
      dueDate: data.dueDate || data.due_date || null,
      issuerName: data.issuerName || data.issuer_name || null,
      issuerTaxId: data.issuerTaxId || data.issuer_tax_id || null,
      recipientName: data.recipientName || data.recipient_name || null,
      recipientTaxId: data.recipientTaxId || data.recipient_tax_id || null,
      recipientPhone: data.recipientPhone || data.recipient_phone || null,
      recipientEmail: data.recipientEmail || data.recipient_email || null,
      deliveryAddress: data.deliveryAddress || data.delivery_address || null,
      responsiblePerson: data.responsiblePerson || data.responsible_person || null,
      currency: data.currency || null,
      netAmount:
        typeof data.netAmount === 'number'
          ? data.netAmount
          : typeof data.net_amount === 'number'
            ? data.net_amount
            : null,
      taxAmount:
        typeof data.taxAmount === 'number'
          ? data.taxAmount
          : typeof data.tax_amount === 'number'
            ? data.tax_amount
            : null,
      totalAmount:
        typeof data.totalAmount === 'number'
          ? data.totalAmount
          : typeof data.total_amount === 'number'
            ? data.total_amount
            : null,
      paymentTerms: data.paymentTerms || data.payment_terms || null,
      paymentMethod: data.paymentMethod || data.payment_method || null,
      referenceNumber: data.referenceNumber || data.reference_number || null,
      cae: data.cae || null,
      taxCondition: data.taxCondition || data.tax_condition || null,
      documentLetter: data.documentLetter || data.document_letter || null,
      pointOfSale: data.pointOfSale || data.point_of_sale || null,
      caeDueDate: data.caeDueDate || data.cae_due_date || null,
      purchaseOrderNumber: data.purchaseOrderNumber || data.purchase_order_number || null,
      exemptAmount: typeof data.exemptAmount === 'number' ? data.exemptAmount : null,
      otherTaxesAmount: typeof data.otherTaxesAmount === 'number' ? data.otherTaxesAmount : null,
      carrierName: data.carrierName || data.carrier_name || null,
      department: data.department || null,
      branch: data.branch || null,
      period: data.period || null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      items,
      extractedData: {
        attributes: data.extractedData?.attributes || data.extracted_data?.attributes || data.attributes || {},
        items,
        involvedParties: data.extractedData?.involvedParties || data.extracted_data?.involved_parties || data.involved_parties || [],
        dates: data.extractedData?.dates || data.extracted_data?.dates || data.dates || {},
        amounts: data.extractedData?.amounts || data.extracted_data?.amounts || data.amounts || {},
      },
      rawText: data.rawText || data.raw_text || '',
      pageCount: Number(data.pageCount || data.page_count || 1),
      aiConfidence: Number(data.aiConfidence || data.ai_confidence || 0.95),
      extractionEngine: (data.extractionEngine || data.extraction_engine || 'python_ocr') as any,
      tokensUsed: 0,
    };
  }
}
