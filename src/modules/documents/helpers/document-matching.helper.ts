import { normalizeDocumentTypeBucket } from '../../clients/helpers/client-document-matching.helper';
import { DocumentLinkType } from '../models/document-link.model';
import { normalizeTaxIdDigits } from './document-fiscal-checks.helper';

export interface MatchableDocumentCandidate {
  id: number;
  documentType?: string | null;
  documentLetter?: string | null;
  pointOfSale?: string | null;
  documentNumber?: string | null;
  referenceNumber?: string | null;
  purchaseOrderNumber?: string | null;
  documentDate?: string | null;
  issuerTaxId?: string | null;
  issuerName?: string | null;
  recipientTaxId?: string | null;
  recipientName?: string | null;
  clientId?: number | null;
  currency?: string | null;
  totalAmount?: number | string | null;
  paymentStatus?: string | null;
  status?: string | null;
  formData?: Record<string, any> | null;
  extractedAttributes?: Record<string, any> | null;
}

export interface ExtractedVoucherReference {
  voucherNumber: string;
  normalizedCode: string;
  voucherType?: string | null;
  appliedAmount?: number | null;
}

export interface ScoredMatchCandidate {
  targetDocumentId: number;
  linkType: DocumentLinkType;
  score: number;
  isExactNumberMatch: boolean;
  reasons: string[];
  suggestedAppliedAmount: number | null;
}

const PAYMENT_SOURCE_BUCKETS = new Set([
  'recibo',
  'orden_pago',
  'transferencia_pago',
  'certificado_retencion',
]);

const PAYABLE_TARGET_BUCKETS = new Set(['factura', 'ticket_fiscal', 'nota_debito']);

/**
 * Normaliza un número de comprobante (opcionalmente con punto de venta) a formato
 * comparable sin ceros a la izquierda por segmento (ej. "0001-00001234" -> "1-1234").
 */
export function normalizeVoucherCode(
  documentNumber?: string | null,
  pointOfSale?: string | null,
): string | null {
  const raw = String(documentNumber || '').trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(
      /^(factura|fact\.?|fc|nc|nd|remito|rem\.?|recibo|rec\.?|op|oc|ticket|tique|a|b|c|m|e|r)\s*[-.:#°]?\s*/gi,
      '',
    )
    .trim();

  const groups = cleaned.match(/\d+/g);
  if (!groups || groups.length === 0) return null;

  if (groups.length === 1 && pointOfSale) {
    const pv = normalizeTaxIdDigits(pointOfSale).replace(/^0+/, '') || '0';
    const num = groups[0].replace(/^0+/, '') || '0';
    if (pv !== '0') return `${pv}-${num}`;
    return num;
  }

  return groups.map((g) => g.replace(/^0+/, '') || '0').join('-');
}

/**
 * Compara dos códigos normalizados permitiendo coincidencia completa ("1-1234" === "1-1234")
 * o coincidencia cuando uno omitió punto de venta ("1234" contra "1-1234" únicamente en último segmento).
 */
export function voucherCodesMatch(
  leftCode?: string | null,
  rightCode?: string | null,
): 'exact' | 'suffix' | null {
  if (!leftCode || !rightCode) return null;
  if (leftCode === rightCode) return 'exact';

  const leftParts = leftCode.split('-');
  const rightParts = rightCode.split('-');
  if (leftParts.length === 1 && rightParts.length === 2 && leftParts[0] === rightParts[1]) {
    return 'suffix';
  }
  if (rightParts.length === 1 && leftParts.length === 2 && rightParts[0] === leftParts[1]) {
    return 'suffix';
  }
  return null;
}

/**
 * Determina el LinkType y la dirección recomendada (source -> target) entre dos documentos.
 */
export function resolveLinkDirectionAndType(
  firstDocType?: string | null,
  secondDocType?: string | null,
): { linkType: DocumentLinkType; swapDirection: boolean } {
  const a = normalizeDocumentTypeBucket(firstDocType);
  const b = normalizeDocumentTypeBucket(secondDocType);

  if (a === 'nota_credito' && PAYABLE_TARGET_BUCKETS.has(b)) {
    return { linkType: DocumentLinkType.CREDIT_NOTE_ADJUSTMENT, swapDirection: false };
  }
  if (b === 'nota_credito' && PAYABLE_TARGET_BUCKETS.has(a)) {
    return { linkType: DocumentLinkType.CREDIT_NOTE_ADJUSTMENT, swapDirection: true };
  }

  if (a === 'nota_debito' && (b === 'factura' || b === 'ticket_fiscal')) {
    return { linkType: DocumentLinkType.DEBIT_NOTE_ADJUSTMENT, swapDirection: false };
  }
  if (b === 'nota_debito' && (a === 'factura' || a === 'ticket_fiscal')) {
    return { linkType: DocumentLinkType.DEBIT_NOTE_ADJUSTMENT, swapDirection: true };
  }

  if (
    (a === 'transferencia_pago' || a === 'certificado_retencion') &&
    (b === 'orden_pago' || b === 'recibo')
  ) {
    return { linkType: DocumentLinkType.PAYMENT_EXECUTION, swapDirection: false };
  }
  if (
    (b === 'transferencia_pago' || b === 'certificado_retencion') &&
    (a === 'orden_pago' || a === 'recibo')
  ) {
    return { linkType: DocumentLinkType.PAYMENT_EXECUTION, swapDirection: true };
  }

  if (PAYMENT_SOURCE_BUCKETS.has(a) && PAYABLE_TARGET_BUCKETS.has(b)) {
    return { linkType: DocumentLinkType.PAYMENT_IMPUTATION, swapDirection: false };
  }
  if (PAYMENT_SOURCE_BUCKETS.has(b) && PAYABLE_TARGET_BUCKETS.has(a)) {
    return { linkType: DocumentLinkType.PAYMENT_IMPUTATION, swapDirection: true };
  }

  if ((a === 'factura' || a === 'ticket_fiscal') && b === 'remito') {
    return { linkType: DocumentLinkType.BILLING_FROM_DELIVERY, swapDirection: false };
  }
  if (a === 'remito' && (b === 'factura' || b === 'ticket_fiscal')) {
    return { linkType: DocumentLinkType.BILLING_FROM_DELIVERY, swapDirection: true };
  }

  const orderDocs = new Set(['orden_compra', 'nota_pedido', 'presupuesto']);
  if ((a === 'remito' || a === 'factura' || a === 'ticket_fiscal') && orderDocs.has(b)) {
    return { linkType: DocumentLinkType.ORDER_FULFILLMENT, swapDirection: false };
  }
  if (orderDocs.has(a) && (b === 'remito' || b === 'factura' || b === 'ticket_fiscal')) {
    return { linkType: DocumentLinkType.ORDER_FULFILLMENT, swapDirection: true };
  }

  return { linkType: DocumentLinkType.GENERAL_RELATED, swapDirection: false };
}

/**
 * Verifica compatibilidad de contraparte/circuito entre dos documentos.
 */
export function evaluateCounterpartyCompatibility(
  a: MatchableDocumentCandidate,
  b: MatchableDocumentCandidate,
): { compatible: boolean; sameClientId: boolean; sameTaxPair: boolean; reason?: string } {
  const sameClientId = Boolean(a.clientId && b.clientId && Number(a.clientId) === Number(b.clientId));

  const aIssuer = normalizeTaxIdDigits(a.issuerTaxId);
  const aRecipient = normalizeTaxIdDigits(a.recipientTaxId);
  const bIssuer = normalizeTaxIdDigits(b.issuerTaxId);
  const bRecipient = normalizeTaxIdDigits(b.recipientTaxId);

  const sameDirectionTax = Boolean(
    (aIssuer && bIssuer && aIssuer === bIssuer) ||
      (aRecipient && bRecipient && aRecipient === bRecipient),
  );
  const crossedTax = Boolean(
    (aIssuer && bRecipient && aIssuer === bRecipient) ||
      (aRecipient && bIssuer && aRecipient === bIssuer),
  );
  const sameTaxPair = sameDirectionTax || crossedTax;

  // En compras/ventas puede cruzarse emisor<->receptor (ej. Orden de Pago emitida por nosotros hacia el proveedor que emitió la Factura)
  if (sameClientId || sameTaxPair) {
    return {
      compatible: true,
      sameClientId,
      sameTaxPair,
      reason: sameClientId ? 'Mismo cliente/proveedor vinculado' : 'Coincidencia de CUIT entre partes',
    };
  }

  const aNames = [a.issuerName, a.recipientName]
    .filter(Boolean)
    .map((n) => String(n).trim().toLowerCase());
  const bNames = [b.issuerName, b.recipientName]
    .filter(Boolean)
    .map((n) => String(n).trim().toLowerCase());
  const sameName = aNames.some((name) => name.length > 3 && bNames.includes(name));

  return {
    compatible: sameName,
    sameClientId: false,
    sameTaxPair: false,
    reason: sameName ? 'Coincidencia de razón social' : undefined,
  };
}

/**
 * Extrae referencias a otros comprobantes declaradas en un documento (appliedVouchers,
 * associatedVoucher, referenceNumber, purchaseOrderNumber).
 */
export function extractVoucherReferencesFromDocument(
  doc: MatchableDocumentCandidate,
): ExtractedVoucherReference[] {
  const refs: ExtractedVoucherReference[] = [];
  const seen = new Set<string>();

  const pushRef = (voucherNumber?: string | null, voucherType?: string | null, amount?: number | null) => {
    const raw = String(voucherNumber || '').trim();
    if (!raw) return;
    const normalizedCode = normalizeVoucherCode(raw);
    if (!normalizedCode) return;
    const key = `${normalizedCode}::${voucherType || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      voucherNumber: raw,
      normalizedCode,
      voucherType: voucherType || null,
      appliedAmount:
        amount !== null && amount !== undefined && Number.isFinite(Number(amount))
          ? Number(amount)
          : null,
    });
  };

  const formData = doc.formData || {};
  const attrs = doc.extractedAttributes || {};

  const voucherArrays = [
    formData.appliedVouchers,
    attrs.comprobantes_imputados,
    attrs.appliedVouchers,
  ];
  for (const list of voucherArrays) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const num = row.voucherNumber || row.numero_comprobante || row.numero || row.comprobante;
      const type = row.voucherType || row.tipo_comprobante || row.tipo;
      const amt = row.appliedAmount ?? row.importe_imputado ?? row.importe;
      pushRef(num, type, amt !== undefined ? Number(amt) : null);
    }
  }

  pushRef(formData.associatedVoucher || attrs.comprobante_asociado, null, null);
  pushRef(doc.referenceNumber, null, null);
  pushRef(doc.purchaseOrderNumber, 'orden_compra', null);

  return refs;
}

/**
 * Evalúa qué tan probable es que `candidate` sea un comprobante vinculado a `sourceDoc`.
 */
export function scoreMatchCandidate(
  sourceDoc: MatchableDocumentCandidate,
  candidate: MatchableDocumentCandidate,
  candidateRemainingBalance?: number | null,
): ScoredMatchCandidate | null {
  if (Number(sourceDoc.id) === Number(candidate.id)) return null;

  const counter = evaluateCounterpartyCompatibility(sourceDoc, candidate);
  if (!counter.compatible) return null;

  const { linkType, swapDirection } = resolveLinkDirectionAndType(
    sourceDoc.documentType,
    candidate.documentType,
  );
  // Evitar sugerir pares entre dos facturas comunes o dos recibos sin motivo
  if (linkType === DocumentLinkType.GENERAL_RELATED) {
    const aBucket = normalizeDocumentTypeBucket(sourceDoc.documentType);
    const bBucket = normalizeDocumentTypeBucket(candidate.documentType);
    if (aBucket === bBucket) return null;
  }

  const reasons: string[] = [];
  if (counter.reason) reasons.push(counter.reason);

  let score = counter.sameClientId ? 25 : 15;
  let isExactNumberMatch = false;
  let suggestedAppliedAmount: number | null = null;

  const sourceRefs = extractVoucherReferencesFromDocument(sourceDoc);
  const candidateRefs = extractVoucherReferencesFromDocument(candidate);
  const candidateNumCode = normalizeVoucherCode(candidate.documentNumber, candidate.pointOfSale);
  const sourceNumCode = normalizeVoucherCode(sourceDoc.documentNumber, sourceDoc.pointOfSale);

  for (const ref of sourceRefs) {
    const m = voucherCodesMatch(ref.normalizedCode, candidateNumCode);
    if (m === 'exact') {
      score += 65;
      isExactNumberMatch = true;
      reasons.push(`Referencia exacta a comprobante ${candidate.documentNumber || ref.voucherNumber}`);
      if (ref.appliedAmount && ref.appliedAmount > 0) {
        suggestedAppliedAmount = ref.appliedAmount;
      }
      break;
    }
    if (m === 'suffix') {
      score += 40;
      reasons.push(`Coincidencia parcial de número (${ref.voucherNumber})`);
      if (ref.appliedAmount && ref.appliedAmount > 0) {
        suggestedAppliedAmount = ref.appliedAmount;
      }
    }
  }

  if (!isExactNumberMatch && sourceNumCode) {
    for (const ref of candidateRefs) {
      const m = voucherCodesMatch(ref.normalizedCode, sourceNumCode);
      if (m === 'exact') {
        score += 60;
        isExactNumberMatch = true;
        reasons.push(`El comprobante cita el N° ${sourceDoc.documentNumber || ref.voucherNumber}`);
        if (ref.appliedAmount && ref.appliedAmount > 0) {
          suggestedAppliedAmount = ref.appliedAmount;
        }
        break;
      }
    }
  }

  const srcAmount = Number(sourceDoc.totalAmount || 0);
  const targetRemaining =
    candidateRemainingBalance !== null && candidateRemainingBalance !== undefined
      ? Number(candidateRemainingBalance)
      : Number(candidate.totalAmount || 0);

  if (srcAmount > 0 && targetRemaining > 0) {
    const diff = Math.abs(srcAmount - targetRemaining);
    if (diff <= 1) {
      score += 30;
      reasons.push('Importe coincidente con el saldo del comprobante');
      if (suggestedAppliedAmount === null && !swapDirection) {
        suggestedAppliedAmount = targetRemaining;
      }
    } else if (diff / Math.max(srcAmount, targetRemaining) <= 0.05) {
      score += 15;
      reasons.push('Importe cercano (±5%)');
    }
  }

  if (sourceDoc.documentDate && candidate.documentDate) {
    const t1 = Date.parse(sourceDoc.documentDate);
    const t2 = Date.parse(candidate.documentDate);
    if (Number.isFinite(t1) && Number.isFinite(t2)) {
      const daysDiff = Math.abs(t1 - t2) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 45) {
        score += 10;
      }
    }
  }

  if (
    suggestedAppliedAmount === null &&
    (linkType === DocumentLinkType.PAYMENT_IMPUTATION ||
      linkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT ||
      linkType === DocumentLinkType.DEBIT_NOTE_ADJUSTMENT)
  ) {
    if (srcAmount > 0 && targetRemaining > 0) {
      suggestedAppliedAmount = Math.min(srcAmount, targetRemaining);
    } else if (srcAmount > 0) {
      suggestedAppliedAmount = srcAmount;
    }
  }

  if (score < 45) return null;

  return {
    targetDocumentId: candidate.id,
    linkType,
    score: Math.min(100, score),
    isExactNumberMatch,
    reasons,
    suggestedAppliedAmount,
  };
}
