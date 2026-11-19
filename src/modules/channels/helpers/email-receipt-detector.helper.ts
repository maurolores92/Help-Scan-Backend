/**
 * Evalúa si el cuerpo de un correo electrónico sin archivos PDF adjuntos
 * corresponde a un comprobante transaccional, factura en línea, ticket o
 * notificación de transferencia bancaria / billetera virtual.
 */
const RECEIPT_KEYWORDS = [
  'comprobante',
  'factura',
  'recibo',
  'transferencia',
  'mercado pago',
  'mercadopago',
  'pago acreditado',
  'pago aprobado',
  'pago recibido',
  'orden de compra',
  'remito',
  'presupuesto',
  'cbu',
  'cvu',
  'cuit',
  'cae',
  'nro. de operación',
  'número de operación',
  'importe total',
  'monto abonado',
  'resumen de cuenta',
  'billing statement',
  'invoice',
  'receipt',
];

const IGNORE_PATTERNS = [
  'out of office',
  'fuera de la oficina',
  'respuesta automática',
  'automatic reply',
  'auto-reply',
  'delivery status notification',
  'undelivered mail',
];

export interface ReceiptDetectionResult {
  isReceipt: boolean;
  reason: string;
  matchedSignals: string[];
}

export function detectReceiptInEmailBody(
  subject: string,
  bodyText: string,
): ReceiptDetectionResult {
  const normalizedSubject = (subject || '').toLowerCase();
  const normalizedBody = (bodyText || '').toLowerCase();
  const combined = `${normalizedSubject}\n${normalizedBody}`.trim();

  if (combined.length < 25) {
    return {
      isReceipt: false,
      reason: 'Contenido de texto demasiado breve para constituir un comprobante.',
      matchedSignals: [],
    };
  }

  for (const ignored of IGNORE_PATTERNS) {
    if (combined.includes(ignored)) {
      return {
        isReceipt: false,
        reason: `Correo descartado por patrón de respuesta automática (${ignored}).`,
        matchedSignals: [],
      };
    }
  }

  const matchedSignals: string[] = [];
  for (const kw of RECEIPT_KEYWORDS) {
    if (combined.includes(kw)) {
      matchedSignals.push(kw);
    }
  }

  // Detectar monto monetario ($ 1.250,00 | ARS 5000 | USD 20.00)
  const hasMoneyAmount = /(?:ars|usd|u\$s|\$)\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?/i.test(
    combined,
  );
  if (hasMoneyAmount) {
    matchedSignals.push('importe_monetario');
  }

  // Detectar CUIT argentino (XX-XXXXXXXX-X)
  const hasCuit = /\b\d{2}-\d{7,8}-\d{1}\b/.test(combined);
  if (hasCuit) {
    matchedSignals.push('cuit_argentino');
  }

  const hasUnsubscribe =
    normalizedBody.includes('unsubscribe') ||
    normalizedBody.includes('darse de baja') ||
    normalizedBody.includes('desuscribir');

  // Si parece newsletter marketing y no tiene señales fiscales fuertes (CUIT / CAE / Comprobante), ignorar
  if (hasUnsubscribe && !hasCuit && !combined.includes('cae') && matchedSignals.length < 3) {
    return {
      isReceipt: false,
      reason: 'Detectado como boletín promocional o newsletter sin comprobante fiscal.',
      matchedSignals,
    };
  }

  if (matchedSignals.length >= 2) {
    return {
      isReceipt: true,
      reason: `Comprobante detectado en texto (${matchedSignals.slice(0, 4).join(', ')}).`,
      matchedSignals,
    };
  }

  return {
    isReceipt: false,
    reason: 'No se identificaron suficientes indicadores de factura, recibo o transferencia.',
    matchedSignals,
  };
}
