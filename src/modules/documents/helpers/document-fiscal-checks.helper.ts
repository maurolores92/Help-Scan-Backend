import { DocumentValidationWarning } from '../document.model';

export interface FiscalCheckInput {
  id?: number | null;
  documentType?: string | null;
  documentLetter?: string | null;
  documentNumber?: string | null;
  pointOfSale?: string | null;
  issuerTaxId?: string | null;
  recipientTaxId?: string | null;
  netAmount?: number | string | null;
  taxAmount?: number | string | null;
  exemptAmount?: number | string | null;
  otherTaxesAmount?: number | string | null;
  discountAmount?: number | string | null;
  discountPercent?: number | string | null;
  grossSubtotal?: number | string | null;
  totalAmount?: number | string | null;
}

/**
 * Extrae valores opcionales de descuento/bonificación desde `extractedData` y `formData`
 * sin alterar documentos existentes que no posean estos campos.
 */
export function extractDiscountInputFromMetadata(
  extractedData?: Record<string, any> | null,
  formData?: Record<string, any> | null,
): {
  discountAmount: number | null;
  discountPercent: number | null;
  grossSubtotal: number | null;
} {
  const attrs = extractedData?.attributes && typeof extractedData.attributes === 'object'
    ? extractedData.attributes
    : {};
  const amounts = extractedData?.amounts && typeof extractedData.amounts === 'object'
    ? extractedData.amounts
    : {};
  const custom = formData && typeof formData === 'object' ? formData : {};

  const parseLooseNumber = (val: unknown): number | null => {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const cleaned = String(val).replace(/[%$\s]/g, '').replace(/,/g, '.').trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  };

  const discountAmount =
    parseLooseNumber(custom.discountAmount) ??
    parseLooseNumber(attrs.descuento) ??
    parseLooseNumber(attrs.bonificacion) ??
    parseLooseNumber(attrs.descuento_total) ??
    parseLooseNumber(attrs.monto_descuento) ??
    parseLooseNumber(amounts.descuento) ??
    parseLooseNumber(amounts.bonificacion) ??
    null;

  const discountPercent =
    parseLooseNumber(custom.discountPercent) ??
    parseLooseNumber(attrs.descuento_porcentaje) ??
    parseLooseNumber(attrs.bonificacion_porcentaje) ??
    null;

  const grossSubtotal =
    parseLooseNumber(custom.grossSubtotal) ??
    parseLooseNumber(attrs.subtotal_bruto) ??
    null;

  return {
    discountAmount: discountAmount !== null ? Math.abs(discountAmount) : null,
    discountPercent: discountPercent !== null && discountPercent > 0 && discountPercent < 100
      ? discountPercent
      : null,
    grossSubtotal,
  };
}

export interface DuplicateDocumentCandidate {
  id: number;
  originalName: string;
  documentNumber?: string | null;
}

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/**
 * Normaliza un CUIT/CUIL/DNI eliminando guiones, espacios y separadores.
 */
export function normalizeTaxIdDigits(taxId?: string | null): string {
  return String(taxId || '').replace(/\D+/g, '');
}

/**
 * Valida dígito verificador AFIP módulo 11 para CUIT/CUIL argentinos de 11 dígitos.
 * Si el campo está vacío o no tiene 11 dígitos (ej. DNI), no reporta error de módulo 11 aquí
 * salvo longitud inválida obvia.
 */
export function isValidArgentineCuit(taxId?: string | null): boolean {
  const raw = String(taxId || '').trim();
  if (!raw) return true;

  const digits = normalizeTaxIdDigits(raw);
  if (digits.length === 0) return true;
  if (!raw.includes('-') && !raw.includes('/') && (digits.length === 7 || digits.length === 8)) {
    return true; // DNI sin guiones
  }
  if (digits.length !== 11) return false;

  const nums = digits.split('').map(Number);
  const sum = CUIT_WEIGHTS.reduce((acc, w, idx) => acc + w * nums[idx], 0);
  const mod = 11 - (sum % 11);
  const expectedDigit = mod === 11 ? 0 : mod === 10 ? 9 : mod;

  return nums[10] === expectedDigit;
}

/**
 * Normaliza un número de comprobante fiscal removiendo ceros a la izquierda por segmento
 * para detectar duplicados aunque uno diga "0008-00041980" y otro "00008-41980".
 */
export function normalizeFiscalNumberKey(
  documentNumber?: string | null,
  pointOfSale?: string | null,
): string | null {
  const raw = String(documentNumber || '').trim();
  if (!raw) return null;

  const stripped = raw
    .replace(/^(factura|remito|nc|nd|r|fc|a|b|c|m|e)\s*[-.:#°]?\s*/i, '')
    .trim();

  const digitGroups = stripped.match(/\d+/g);
  if (!digitGroups || digitGroups.length === 0) return null;

  if (digitGroups.length === 1 && pointOfSale) {
    const pv = normalizeTaxIdDigits(pointOfSale).replace(/^0+/, '') || '0';
    const num = digitGroups[0].replace(/^0+/, '') || '0';
    return `${pv}-${num}`;
  }

  return digitGroups.map((g) => g.replace(/^0+/, '') || '0').join('-');
}

function toNullableNumber(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Evalúa consistencia matemática entre neto, IVA, exento, otros tributos, descuentos y total final.
 * Acepta tanto comprobantes donde el neto ya incluye bonificación como aquellos donde se resta
 * un descuento global. Retorna una advertencia si la diferencia supera $1.00.
 */
export function checkAmountConsistency(
  input: FiscalCheckInput,
): DocumentValidationWarning | null {
  const total = toNullableNumber(input.totalAmount);
  if (total === null || total <= 0) return null;

  const net = toNullableNumber(input.netAmount);
  const tax = toNullableNumber(input.taxAmount);
  const exempt = toNullableNumber(input.exemptAmount);
  const other = toNullableNumber(input.otherTaxesAmount);
  const rawDiscount = toNullableNumber(input.discountAmount);
  const discount = rawDiscount !== null ? Math.abs(rawDiscount) : 0;
  const rawDiscountPct = toNullableNumber(input.discountPercent);
  const discountPct =
    rawDiscountPct !== null && rawDiscountPct > 0 && rawDiscountPct < 100
      ? rawDiscountPct
      : null;
  const grossSubtotal = toNullableNumber(input.grossSubtotal);

  // Solo validar si existe al menos un subcomponente discriminado
  if (net === null && tax === null && exempt === null && other === null) {
    return null;
  }

  // Si solo vino netAmount sin IVA ni exento en un comprobante sin discriminar,
  // evitar falso positivo cuando net === total (cubierto por diff <= 1) o cuando no vino taxAmount pero net < total.
  if (tax === null && exempt === null && other === null && net !== null && net < total) {
    return null;
  }

  const baseSum = Number(
    ((net || 0) + (tax || 0) + (exempt || 0) + (other || 0)).toFixed(2),
  );
  if (Math.abs(baseSum - total) <= 1.0) {
    return null;
  }

  // Contemplar descuento global ($):
  // - Ya sea restado del total acumulado (neto/subtotal pre-descuento + IVA + otros - descuento = total)
  // - O cuando vino subtotal bruto antes de descuento y se calcula (grossSubtotal - discount + tax + exempt + other = total)
  if (discount > 0) {
    const afterGlobalDiscount = Number((baseSum - discount).toFixed(2));
    if (Math.abs(afterGlobalDiscount - total) <= 1.0) {
      return null;
    }
    if (grossSubtotal !== null) {
      const fromGross = Number(
        (grossSubtotal - discount + (tax || 0) + (exempt || 0) + (other || 0)).toFixed(2),
      );
      if (Math.abs(fromGross - total) <= 1.0) {
        return null;
      }
    }
  }

  // Contemplar porcentaje de descuento global si el descuento en $ no vino impreso aparte
  if (discountPct !== null) {
    const netAfterPct = (net || 0) * (1 - discountPct / 100);
    const totalWithNetPct = Number(
      (netAfterPct + (tax || 0) + (exempt || 0) + (other || 0)).toFixed(2),
    );
    const totalWithGlobalPct = Number((baseSum * (1 - discountPct / 100)).toFixed(2));
    if (
      Math.abs(totalWithNetPct - total) <= 1.0 ||
      Math.abs(totalWithGlobalPct - total) <= 1.0
    ) {
      return null;
    }
  }

  const effectiveComputed = discount > 0 ? Number((baseSum - discount).toFixed(2)) : baseSum;

  return {
    code: 'AMOUNT_MISMATCH',
    severity: 'warning',
    message: discount > 0
      ? `Descuadre en totales: componentes menos descuento (${effectiveComputed.toLocaleString('es-AR', { minimumFractionDigits: 2 })}) difiere del total (${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}).`
      : `Descuadre en totales: la suma de componentes (${baseSum.toLocaleString('es-AR', { minimumFractionDigits: 2 })}) difiere del total (${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}).`,
  };
}

/**
 * Construye todas las advertencias fiscales y administrativas para un comprobante.
 */
export function buildDocumentValidationWarnings(
  input: FiscalCheckInput,
  duplicateMatch?: DuplicateDocumentCandidate | null,
): DocumentValidationWarning[] {
  const warnings: DocumentValidationWarning[] = [];

  if (duplicateMatch) {
    warnings.push({
      code: 'DUPLICATE_FISCAL',
      severity: 'error',
      relatedDocumentId: duplicateMatch.id,
      message: `Posible comprobante fiscal duplicado del documento #${duplicateMatch.id} ('${duplicateMatch.originalName}').`,
    });
  }

  if (input.issuerTaxId && !isValidArgentineCuit(input.issuerTaxId)) {
    warnings.push({
      code: 'INVALID_CUIT',
      severity: 'warning',
      message: `El CUIT del emisor ('${input.issuerTaxId}') no supera la validación de dígito verificador.`,
    });
  }

  if (input.recipientTaxId && !isValidArgentineCuit(input.recipientTaxId)) {
    warnings.push({
      code: 'INVALID_CUIT',
      severity: 'warning',
      message: `El CUIT del receptor ('${input.recipientTaxId}') no supera la validación de dígito verificador.`,
    });
  }

  const mismatch = checkAmountConsistency(input);
  if (mismatch) {
    warnings.push(mismatch);
  }

  return warnings;
}

/**
 * Determina si un tipo de documento corresponde normalmente a un comprobante no pagable
 * directamente (ej. remito de entrega o legajo RRHH).
 */
export function resolveDefaultPaymentStatus(documentType?: string | null): 'PENDING' | 'NOT_APPLICABLE' {
  const normalized = String(documentType || '').toLowerCase().trim();
  if (
    normalized === 'remito' ||
    normalized === 'legajo' ||
    normalized === 'nota_credito' ||
    normalized === 'certificado_retencion' ||
    normalized === 'transferencia_pago' ||
    normalized === 'presupuesto'
  ) {
    return 'NOT_APPLICABLE';
  }
  return 'PENDING';
}
