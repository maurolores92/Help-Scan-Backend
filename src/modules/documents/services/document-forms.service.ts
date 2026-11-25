import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  DocumentFormFieldSchema,
  DocumentTypeForm,
} from '../models/document-type-form.model';
import { DocumentFormRecord } from '../models/document-form-record.model';
import { DEFAULT_DOCUMENT_FORMS_SEED } from '../data/default-document-forms.data';

@Injectable()
export class DocumentFormsService {
  private readonly logger = new Logger(DocumentFormsService.name);
  private seededInProcess = false;

  constructor(
    @InjectModel(DocumentTypeForm)
    private readonly formModel: typeof DocumentTypeForm,
    @InjectModel(DocumentFormRecord)
    private readonly recordModel: typeof DocumentFormRecord,
  ) {}

  /**
   * Inserta o actualiza de forma idempotente el catálogo global predefinido (company_id = NULL)
   * de formularios por tipo de documento, sin pisar personalizaciones propias de compañías.
   */
  async seedDefaultForms(): Promise<void> {
    for (const def of DEFAULT_DOCUMENT_FORMS_SEED) {
      const existing = await this.formModel.findOne({
        where: { companyId: null, code: def.code },
      });

      if (!existing) {
        await this.formModel.create({
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
        } as any);
      } else if ((existing.version ?? 0) < def.version) {
        await existing.update({
          label: def.label,
          description: def.description,
          icon: def.icon,
          matchAliases: def.matchAliases,
          sectionsSchema: def.sectionsSchema,
          aiExtractionGuide: def.aiExtractionGuide,
          displayOrder: def.displayOrder,
          version: def.version,
        });
      }
    }
    this.seededInProcess = true;
    this.logger.log(
      `[DocumentFormsService] ${DEFAULT_DOCUMENT_FORMS_SEED.length} formularios predefinidos listos.`,
    );
  }

  /**
   * Lista los esquemas activos aplicables a la compañía (priorizando overrides propios de la empresa
   * sobre los globales predefinidos).
   */
  async listAvailableForms(companyId?: number | null): Promise<DocumentTypeForm[]> {
    const globalCount = await this.formModel.count({
      where: { companyId: null },
    });
    if (globalCount === 0 && !this.seededInProcess) {
      await this.seedDefaultForms().catch(() => null);
    }

    const whereClause: any =
      companyId && companyId > 0
        ? {
            isActive: true,
            [Op.or]: [{ companyId: null }, { companyId }],
          }
        : {
            isActive: true,
            companyId: null,
          };

    const rows = await this.formModel.findAll({
      where: whereClause,
      order: [
        ['displayOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    const byCode = new Map<string, DocumentTypeForm>();
    for (const row of rows) {
      const prev = byCode.get(row.code);
      if (!prev || row.companyId !== null) {
        byCode.set(row.code, row);
      }
    }

    return Array.from(byCode.values()).sort(
      (a, b) => (a.displayOrder ?? 100) - (b.displayOrder ?? 100),
    );
  }

  /**
   * Resuelve el esquema de formulario más adecuado a partir del tipo crudo detectado por OCR/IA o elegido en UI.
   */
  async resolveFormByDocumentType(
    companyId?: number | null,
    rawDocumentType?: string | null,
  ): Promise<DocumentTypeForm | null> {
    const forms = await this.listAvailableForms(companyId);
    if (forms.length === 0) return null;

    const normalized = String(rawDocumentType || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    if (normalized) {
      const exactCode = forms.find((f) => f.code.toLowerCase() === normalized);
      if (exactCode) return exactCode;

      const aliasHit = forms.find((f) =>
        Array.isArray(f.matchAliases) &&
        f.matchAliases.some((a) => String(a).trim().toLowerCase() === normalized),
      );
      if (aliasHit) return aliasHit;

      if (normalized.includes('nota_cred') || normalized === 'nc' || normalized === 'nce') {
        const ncForm = forms.find((f) => f.code === 'nota_credito');
        if (ncForm) return ncForm;
      }
      if (normalized.includes('nota_deb') || normalized === 'nd' || normalized === 'nde') {
        const ndForm = forms.find((f) => f.code === 'nota_debito');
        if (ndForm) return ndForm;
      }
      if (normalized.includes('retencion') || normalized === 'sire' || normalized === 'sicore') {
        const retForm = forms.find((f) => f.code === 'certificado_retencion');
        if (retForm) return retForm;
      }
      if (normalized.includes('orden_pago') || normalized === 'op') {
        const opForm = forms.find((f) => f.code === 'orden_pago');
        if (opForm) return opForm;
      }
      if (normalized.includes('transferencia') || normalized.includes('deposito') || normalized.includes('mercado_pago')) {
        const trForm = forms.find((f) => f.code === 'transferencia_pago');
        if (trForm) return trForm;
      }
      if (normalized.includes('ticket') || normalized.includes('tique')) {
        const tkForm = forms.find((f) => f.code === 'ticket_fiscal');
        if (tkForm) return tkForm;
      }
      if (normalized.includes('factura') || normalized === 'fce' || normalized === 'invoice') {
        const facturaForm = forms.find((f) => f.code === 'factura');
        if (facturaForm) return facturaForm;
      }
      if (normalized.includes('remito')) {
        const remitoForm = forms.find((f) => f.code === 'remito');
        if (remitoForm) return remitoForm;
      }
      if (normalized.includes('presupuesto') || normalized.includes('cotiz')) {
        const presForm = forms.find((f) => f.code === 'presupuesto');
        if (presForm) return presForm;
      }
      if (normalized.includes('orden_compra') || normalized.includes('compra')) {
        const ocForm = forms.find((f) => f.code === 'orden_compra');
        if (ocForm) return ocForm;
      }
      if (normalized.includes('nota_pedido') || normalized.includes('pedido')) {
        const npForm = forms.find((f) => f.code === 'nota_pedido');
        if (npForm) return npForm;
      }
      if (normalized.includes('recibo')) {
        const recForm = forms.find((f) => f.code === 'recibo');
        if (recForm) return recForm;
      }
      if (normalized.includes('servicio') || normalized.includes('tecnic') || normalized.includes('mantenimiento')) {
        const osForm = forms.find((f) => f.code === 'orden_servicio');
        if (osForm) return osForm;
      }
      if (normalized.includes('contrato') || normalized.includes('acuerdo')) {
        const contForm = forms.find((f) => f.code === 'contrato');
        if (contForm) return contForm;
      }
      if (normalized.includes('legajo') || normalized.includes('haberes') || normalized.includes('sueldo')) {
        const legForm = forms.find((f) => f.code === 'legajo');
        if (legForm) return legForm;
      }
    }

    return forms.find((f) => f.code === 'documento_general') || forms[0];
  }

  /**
   * Preserva letra fiscal / subtipo cuando tipos detallados (ej: `factura_a`, `nota_credito`, `remito_x`)
   * se normalizan hacia su formulario unificado (`factura` o `remito`).
   */
  inferCoreAndCustomHintsFromRawType(
    rawType?: string | null,
    resolvedCode?: string | null,
    currentLetter?: string | null,
  ): {
    documentLetter?: string;
    customDefaults: Record<string, any>;
  } {
    const raw = String(rawType || '')
      .trim()
      .toLowerCase();
    const customDefaults: Record<string, any> = {};
    let documentLetter: string | undefined = currentLetter || undefined;

    if (resolvedCode === 'factura') {
      const letterMatch = raw.match(/^factura_([abcme])$/);
      if (!documentLetter && letterMatch) {
        documentLetter = letterMatch[1].toUpperCase();
      }
      customDefaults.fiscalSubtype = raw.includes('fce')
        ? 'Factura de Crédito Electrónica (FCE)'
        : 'Factura';
    } else if (resolvedCode === 'nota_credito') {
      const letterMatch = raw.match(/^(?:nota_credito|nota_de_credito|nc)_([abcme])$/);
      if (!documentLetter && letterMatch) {
        documentLetter = letterMatch[1].toUpperCase();
      }
      customDefaults.fiscalSubtype = raw.includes('nce')
        ? 'Nota de Crédito Electrónica MiPyME (NCE)'
        : 'Nota de Crédito';
    } else if (resolvedCode === 'nota_debito') {
      const letterMatch = raw.match(/^(?:nota_debito|nota_de_debito|nd)_([abcme])$/);
      if (!documentLetter && letterMatch) {
        documentLetter = letterMatch[1].toUpperCase();
      }
      customDefaults.fiscalSubtype = raw.includes('nde')
        ? 'Nota de Débito Electrónica MiPyME (NDE)'
        : 'Nota de Débito';
    } else if (resolvedCode === 'ticket_fiscal') {
      const letterMatch = raw.match(/^(?:ticket|tique)_([abct])$/);
      if (!documentLetter && letterMatch) {
        documentLetter = letterMatch[1].toUpperCase();
      }
    } else if (resolvedCode === 'remito') {
      if (!documentLetter) {
        if (raw.endsWith('_x')) documentLetter = 'X';
        else if (raw.endsWith('_r')) documentLetter = 'R';
      }
    } else if (resolvedCode === 'recibo') {
      if (raw.endsWith('_a') || raw.endsWith('_b') || raw.endsWith('_c')) {
        customDefaults.receiptClass = 'Recibo Fiscal ARCA (Letra A/B/C)';
        if (!documentLetter) {
          documentLetter = raw.slice(-1).toUpperCase();
        }
      }
    }

    return { documentLetter, customDefaults };
  }

  /**
   * Extrae desde la salida de OCR/IA todos los valores pertenecientes a campos `custom`
   * declarados en el esquema resuelto.
   */
  buildFormDataFromExtraction(
    schema: DocumentTypeForm | null,
    extractedData: Record<string, any> | null | undefined,
    rawType?: string | null,
    existingFormData?: Record<string, any> | null,
  ): Record<string, any> {
    if (!schema) return existingFormData ? { ...existingFormData } : {};

    const attrs =
      extractedData?.attributes && typeof extractedData.attributes === 'object'
        ? extractedData.attributes
        : {};
    const { customDefaults } = this.inferCoreAndCustomHintsFromRawType(rawType, schema.code);
    const result: Record<string, any> = {
      ...(existingFormData || {}),
      ...customDefaults,
    };

    const customFields: DocumentFormFieldSchema[] = [];
    for (const section of schema.sectionsSchema || []) {
      for (const field of section.fields || []) {
        if (field.target === 'custom') {
          customFields.push(field);
        }
      }
    }

    for (const field of customFields) {
      if (result[field.key] !== undefined && result[field.key] !== null && result[field.key] !== '') {
        continue;
      }

      const candidateKeys = [field.key, ...(field.aiAttrKeys || [])];
      let matchedValue: any = undefined;

      for (const k of candidateKeys) {
        const direct = attrs[k];
        if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
          matchedValue = direct;
          break;
        }
      }

      if (matchedValue !== undefined) {
        result[field.key] = this.coerceFieldValue(field, matchedValue);
      } else if (field.defaultValue !== undefined && result[field.key] === undefined) {
        result[field.key] = field.defaultValue;
      }
    }

    return result;
  }

  private coerceFieldValue(field: DocumentFormFieldSchema, rawVal: any): any {
    if (field.fieldType === 'vouchers_table') {
      return this.normalizeAppliedVouchers(rawVal);
    }
    if (field.fieldType === 'switch') {
      if (typeof rawVal === 'boolean') return rawVal;
      const s = String(rawVal).trim().toLowerCase();
      return ['true', '1', 'si', 'sí', 'yes'].includes(s);
    }
    if (field.fieldType === 'number' || field.fieldType === 'currency') {
      if (typeof rawVal === 'number' && Number.isFinite(rawVal)) return rawVal;
      const cleaned = String(rawVal).replace(/[^\d.,-]/g, '').replace(',', '.');
      const num = Number(cleaned);
      return Number.isFinite(num) ? num : rawVal;
    }
    if (Array.isArray(rawVal) || (typeof rawVal === 'object' && rawVal !== null)) {
      return this.formatStructuredValueAsText(rawVal);
    }
    return typeof rawVal === 'string' ? rawVal.trim() : rawVal;
  }

  private formatStructuredValueAsText(rawVal: any): string {
    if (Array.isArray(rawVal)) {
      return rawVal
        .map((item) => {
          if (item && typeof item === 'object') {
            const label = [
              item.voucherType || item.tipo_comprobante || item.tipo || '',
              item.voucherNumber || item.numero_comprobante || item.numero || item.comprobante || '',
            ]
              .filter(Boolean)
              .join(' ');
            const amt = item.appliedAmount ?? item.importe_imputado ?? item.importe ?? item.montoAplicado;
            if (label || amt !== undefined) {
              return `${label || 'Comprobante'}${amt !== undefined && amt !== null ? ` ($${amt})` : ''}`;
            }
            return JSON.stringify(item);
          }
          return String(item ?? '').trim();
        })
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(rawVal);
  }

  private normalizeAppliedVouchers(rawVal: any): Array<Record<string, any>> {
    let source = rawVal;
    if (typeof source === 'string') {
      const trimmed = source.trim();
      if (!trimmed) return [];
      try {
        source = JSON.parse(trimmed);
      } catch {
        return trimmed
          .split(/[\n,;]+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => ({
            voucherType: 'Factura',
            voucherNumber: line,
            voucherDate: null,
            originalAmount: null,
            appliedAmount: null,
          }));
      }
    }
    if (!Array.isArray(source)) return [];

    return source
      .filter((row) => row && typeof row === 'object')
      .map((row) => {
        const rawOrig =
          row.originalAmount ??
          row.importe_original ??
          row.montoOriginal ??
          row.importeTotal ??
          row.total;
        const rawApplied =
          row.appliedAmount ??
          row.importe_imputado ??
          row.montoAplicado ??
          row.importe;

        return {
          voucherType: String(
            row.voucherType || row.tipo_comprobante || row.tipo || row.type || 'Factura',
          ).trim(),
          voucherNumber: String(
            row.voucherNumber ||
              row.numero_comprobante ||
              row.numero ||
              row.number ||
              row.comprobante ||
              '',
          ).trim(),
          voucherDate: row.voucherDate || row.fecha || row.date || null,
          originalAmount:
            rawOrig !== undefined && rawOrig !== null && rawOrig !== '' && Number.isFinite(Number(rawOrig))
              ? Number(rawOrig)
              : null,
          appliedAmount:
            rawApplied !== undefined &&
            rawApplied !== null &&
            rawApplied !== '' &&
            Number.isFinite(Number(rawApplied))
              ? Number(rawApplied)
              : null,
        };
      })
      .filter((row) => row.voucherNumber.length > 0 || row.appliedAmount !== null);
  }

  async upsertFormRecord(params: {
    companyId: number;
    documentId: number;
    schema: DocumentTypeForm | null;
    documentType: string;
    formData: Record<string, any>;
    actorUserId?: number | null;
    markValidated?: boolean;
  }): Promise<DocumentFormRecord> {
    const cleanData: Record<string, any> = {};
    for (const [key, val] of Object.entries(params.formData || {})) {
      if (val !== undefined && val !== '') {
        cleanData[key] = val;
      }
    }

    const existing = await this.recordModel.findOne({
      where: { documentId: params.documentId },
    });

    const payload = {
      companyId: params.companyId,
      documentId: params.documentId,
      formSchemaId: params.schema?.id ?? existing?.formSchemaId ?? null,
      documentType: params.schema?.code || params.documentType || 'documento_general',
      formData: cleanData,
      schemaVersion: params.schema?.version ?? existing?.schemaVersion ?? 1,
      validatedByUserId: params.markValidated
        ? (params.actorUserId ?? existing?.validatedByUserId ?? null)
        : existing?.validatedByUserId ?? null,
      validatedAt: params.markValidated
        ? new Date()
        : existing?.validatedAt ?? null,
    };

    if (existing) {
      await existing.update(payload);
      return existing;
    }

    return this.recordModel.create(payload as any);
  }
}
