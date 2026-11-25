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

      if (normalized.includes('factura') || normalized.includes('nota_cred') || normalized.includes('nota_deb') || normalized.includes('tique') || normalized.includes('ticket')) {
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
      if (normalized.includes('recibo') || normalized.includes('orden_pago')) {
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
      const letterMatch = raw.match(/^(?:factura|nota_credito|nota_debito)_([abcme])$/);
      if (!documentLetter && letterMatch) {
        documentLetter = letterMatch[1].toUpperCase();
      }
      if (raw.includes('nota_cred')) {
        customDefaults.fiscalSubtype = 'Nota de Crédito';
      } else if (raw.includes('nota_deb')) {
        customDefaults.fiscalSubtype = 'Nota de Débito';
      } else if (raw.includes('fce')) {
        customDefaults.fiscalSubtype = 'Factura de Crédito Electrónica (FCE)';
      } else if (raw.includes('ticket') || raw.includes('tique')) {
        customDefaults.fiscalSubtype = 'Tique / Ticket Factura';
      } else {
        customDefaults.fiscalSubtype = 'Factura';
      }
    } else if (resolvedCode === 'remito') {
      if (!documentLetter) {
        if (raw.endsWith('_x')) documentLetter = 'X';
        else if (raw.endsWith('_r')) documentLetter = 'R';
      }
    } else if (resolvedCode === 'recibo') {
      if (raw.includes('orden_pago') || raw.includes('orden_de_pago')) {
        customDefaults.receiptClass = 'Orden de Pago (Tesorería)';
      } else if (raw.endsWith('_a') || raw.endsWith('_b') || raw.endsWith('_c')) {
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
    return typeof rawVal === 'string' ? rawVal.trim() : rawVal;
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
