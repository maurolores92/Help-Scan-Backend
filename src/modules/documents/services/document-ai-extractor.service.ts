import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { readDecryptedVaultFile } from '../../../common/utils/vault-crypto.util';
import pdfParse = require('pdf-parse');
import {
  extractUniversalHeuristicsFromText,
  UniversalDocumentExtractionResult,
} from '../helpers/local-pdf-heuristics.helper';

const MIN_NATIVE_TEXT_LENGTH = 80;

const EXTRACTION_SYSTEM_PROMPT = `Eres un motor experto de análisis documental y extracción semántica empresarial multirubro.
Cada empresa puede subir cualquier tipo de PDF (facturas, remitos, notas de pedido, contratos, órdenes de servicio, recibos de sueldo, legajos, presupuestos, oficios, órdenes de compra, etc.).
Analiza el documento y devuelve ESTRICTAMENTE un objeto JSON válido (sin bloques markdown ni texto adicional) con esta estructura exacta:
{
  "documentType": "string en snake_case minúscula (ej: factura, remito, nota_pedido, presupuesto, orden_compra, recibo, orden_servicio, contrato, legajo, etc.)",
  "summary": "resumen ejecutivo claro en español (1 a 2 oraciones) con los datos más importantes",
  "documentNumber": "string o null (número de comprobante con punto de venta ej: 00008-00041980, expediente o remito)",
  "documentDate": "YYYY-MM-DD o null (fecha principal del documento)",
  "dueDate": "YYYY-MM-DD o null (fecha de vencimiento del pago o validez de la oferta)",
  "issuerName": "string o null (nombre/razón social del proveedor, emisor o prestador)",
  "issuerTaxId": "string o null (CUIT, RUT, DNI o identificador fiscal del emisor)",
  "recipientName": "string o null (cliente, destinatario o receptor)",
  "recipientTaxId": "string o null (CUIT, DNI o identificador fiscal del cliente)",
  "recipientPhone": "string o null (teléfono o celular de contacto)",
  "recipientEmail": "string o null (correo electrónico de contacto)",
  "deliveryAddress": "string o null (domicilio de entrega, localidad o dirección)",
  "responsiblePerson": "string o null (persona responsable, contacto comercial, técnico firmante o solicitante)",
  "currency": "ARS | USD | EUR | null (solo si existen importes monetarios)",
  "netAmount": "number o null (subtotal o importe neto gravado sin impuestos)",
  "taxAmount": "number o null (monto total de IVA u otros impuestos)",
  "totalAmount": "number o null (monto final total a pagar numérico, ej: 47819.20)",
  "paymentTerms": "string o null (condición de venta, ej: CTA. CTE. 15 DIAS, contado, cheque, validez 5 días)",
  "paymentMethod": "string o null (Transferencia Bancaria, Cheque, Efectivo, etc.)",
  "referenceNumber": "string o null (número de orden de compra o remito asociado si figura)",
  "cae": "string o null (código CAE de AFIP de 14 dígitos)",
  "taxCondition": "string o null (Responsable Inscripto, Monotributo, Exento, Consumidor Final)",
  "equipmentId": "string o null (código o ID numérico/alfanumérico del equipo, ej: 7016, 1532, 3846)",
  "equipmentModel": "string o null (modelo del equipo o máquina, ej: MP 161 SPF, M320F, E52645)",
  "meterCount": "string o null (contador actual/anterior o copias, ej: ACT:8-ANT:7)",
  "tags": ["etiquetas clave en español minúscula"],
  "attributes": { "clave_dinamica_snake_case": "cualquier dato propio relevante" },
  "items": [ { "code": "string|null", "description": "string", "quantity": "number|null", "unitPrice": "number|null", "subtotal": "number|null" } ],
  "involvedParties": [ { "name": "string", "role": "string", "identifier": "string|null" } ],
  "dates": { "vencimiento": "YYYY-MM-DD" },
  "amounts": { "subtotal": 0, "impuestos": 0 },
  "aiConfidence": 0.95
}`;

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
      try {
        const target = `${ocrUrl.replace(/\/+$/, '')}/health`;
        const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
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
      }
    } else {
      this.logger.log(
        '[OCR Microservice] No se configuró OCR_SERVICE_URL. Operando en modo local nativo (pdf-parse).',
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

    // 1. Si existe microservicio Python de OCR configurado (PyMuPDF + Tesseract en español), delegarle la extracción
    const ocrUrl = process.env.OCR_SERVICE_URL?.trim();
    if (ocrUrl) {
      try {
        const pythonResult = await this.callPythonOcrService(fileBuffer, originalFileName, ocrUrl);
        if (pythonResult) {
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
  }): Promise<UniversalDocumentExtractionResult> {
    const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${params.apiKey}`;

    const parts: any[] =
      params.mode === 'gemini_text'
        ? [
            {
              text: `${EXTRACTION_SYSTEM_PROMPT}\n\nNombre del archivo: ${params.originalFileName}\nCantidad de páginas: ${params.pageCount}\n\nTexto digital nativo del PDF:\n${params.nativeText.slice(0, 50000)}`,
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
              text: `${EXTRACTION_SYSTEM_PROMPT}\n\nNombre original del archivo escaneado: ${params.originalFileName}`,
            },
          ];

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 250)}`);
    }

    const json: any = await response.json();
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

    // Fallback heurístico para complementar lo que Gemini pudiera omitir
    const fallback = extractUniversalHeuristicsFromText(
      params.nativeText,
      params.originalFileName,
      params.pageCount,
    );

    return {
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
      equipmentId: parsed.equipmentId ? String(parsed.equipmentId).slice(0, 50) : fallback.equipmentId,
      equipmentModel: parsed.equipmentModel ? String(parsed.equipmentModel).slice(0, 100) : fallback.equipmentModel,
      meterCount: parsed.meterCount ? String(parsed.meterCount).slice(0, 100) : fallback.meterCount,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 15)
        : fallback.tags,
      items: Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed.items : fallback.items || fallback.extractedData.items,
      extractedData: {
        attributes: {
          ...fallback.extractedData.attributes,
          ...(parsed.attributes && typeof parsed.attributes === 'object' ? parsed.attributes : {}),
        },
        items: Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed.items : fallback.items || fallback.extractedData.items,
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
      // Usamos directamente el texto nativo ya extraído por pdf-parse en milisegundos
      rawText: params.nativeText || String(parsed.rawText || '').trim(),
      pageCount: params.pageCount,
      aiConfidence:
        typeof parsed.aiConfidence === 'number'
          ? Math.max(0, Math.min(1, parsed.aiConfidence))
          : 0.9,
      extractionEngine: params.mode,
      tokensUsed,
    };
  }

  private safeParseJsonObject(raw: string): Record<string, any> {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }

  private async callPythonOcrService(
    fileBuffer: Buffer,
    originalFileName: string,
    ocrBaseUrl: string,
  ): Promise<UniversalDocumentExtractionResult | null> {
    const endpoint = `${ocrBaseUrl.replace(/\/+$/, '')}/extract`;
    this.logger.log(
      `[DocumentAiExtractor] Delegando OCR al microservicio Python en ${endpoint} para '${originalFileName}'...`,
    );

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
      this.logger.log(
        `[DocumentAiExtractor] ✅ OCR completado exitosamente por Python para '${originalFileName}' (motor=${data.extractionEngine || data.extraction_engine || 'python_ocr'})`,
      );
      return this.mapPythonResponseToResult(data, originalFileName);
    } catch (err: any) {
      this.logger.warn(
        `[DocumentAiExtractor] No se pudo obtener respuesta del microservicio Python: ${err?.message}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
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
        typeof it.cantidad === 'number'
          ? it.cantidad
          : typeof it.quantity === 'number'
            ? it.quantity
            : 1,
      precioSinIva:
        typeof it.precioSinIva === 'number'
          ? it.precioSinIva
          : typeof it.precio_sin_iva === 'number'
            ? it.precio_sin_iva
            : typeof it.unitPrice === 'number'
              ? it.unitPrice
              : null,
      precioFinal:
        typeof it.precioFinal === 'number'
          ? it.precioFinal
          : typeof it.precio_final === 'number'
            ? it.precio_final
            : typeof it.subtotal === 'number'
              ? it.subtotal
              : null,
      ivaPorcentaje:
        typeof it.ivaPorcentaje === 'number'
          ? it.ivaPorcentaje
          : typeof it.iva_porcentaje === 'number'
            ? it.iva_porcentaje
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
      equipmentId: data.equipmentId || data.equipment_id || null,
      equipmentModel: data.equipmentModel || data.equipment_model || null,
      meterCount: data.meterCount || data.meter_count || null,
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
