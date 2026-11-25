import { Client } from '../client.model';
import { Document } from '../../documents/document.model';
import { normalizeTaxIdDigits } from '../../documents/helpers/document-fiscal-checks.helper';

export type ClientDocumentRole = 'issuer' | 'recipient' | 'both' | 'linked';

export function cleanClientString(value?: string | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeClientNameKey(value?: string | null): string {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,\-/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDocumentTypeBucket(rawType?: string | null): string {
  const norm = String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!norm) return 'documento_general';
  if (norm.includes('nota_cred') || norm === 'nc' || norm === 'nce') return 'nota_credito';
  if (norm.includes('nota_deb') || norm === 'nd' || norm === 'nde') return 'nota_debito';
  if (norm.includes('retencion') || norm === 'sire' || norm === 'sicore') return 'certificado_retencion';
  if (norm.includes('orden_pago') || norm === 'op') return 'orden_pago';
  if (norm.includes('transferencia') || norm.includes('deposito') || norm.includes('mercado_pago')) {
    return 'transferencia_pago';
  }
  if (norm.includes('tique') || norm.includes('ticket')) return 'ticket_fiscal';
  if (norm.includes('factura') || norm === 'fce' || norm === 'invoice' || norm === 'comprobante_fiscal') {
    return 'factura';
  }
  if (norm.includes('remito') || norm.includes('guia_despacho')) return 'remito';
  if (norm.includes('presupuesto') || norm.includes('cotiz') || norm === 'proforma') {
    return 'presupuesto';
  }
  if (norm.includes('orden_compra') || norm === 'purchase_order' || norm === 'oc') {
    return 'orden_compra';
  }
  if (norm.includes('nota_pedido') || norm.includes('solicitud_pedido')) return 'nota_pedido';
  if (norm.includes('recibo') || norm === 'comprobante_cobro') {
    return 'recibo';
  }
  if (norm.includes('servicio') || norm.includes('tecnic') || norm.includes('mantenimiento')) {
    return 'orden_servicio';
  }
  if (norm.includes('contrato') || norm.includes('acuerdo') || norm.includes('convenio')) {
    return 'contrato';
  }
  if (norm.includes('legajo') || norm.includes('haberes') || norm.includes('sueldo') || norm === 'rrhh') {
    return 'legajo';
  }
  return norm;
}

/**
 * Evalúa si un documento pertenece al cliente y con qué rol (emisor, destinatario, ambos o vinculado directo).
 */
export function evaluateClientRoleInDocument(
  client: Pick<Client, 'id' | 'name' | 'tradeName' | 'normalizedTaxId' | 'email'>,
  doc: Pick<
    Document,
    | 'clientId'
    | 'issuerTaxId'
    | 'issuerName'
    | 'recipientTaxId'
    | 'recipientName'
    | 'recipientEmail'
  >,
): { matches: boolean; clientRole: ClientDocumentRole } {
  const clientTaxDigits = client.normalizedTaxId || null;
  const clientNameKey = normalizeClientNameKey(client.name);
  const clientTradeKey = client.tradeName ? normalizeClientNameKey(client.tradeName) : '';
  const clientEmail = cleanClientString(client.email)?.toLowerCase() || null;

  const issuerTaxDigits = normalizeTaxIdDigits(doc.issuerTaxId);
  const issuerNameKey = normalizeClientNameKey(doc.issuerName);
  const matchesIssuer = Boolean(
    (clientTaxDigits && issuerTaxDigits && issuerTaxDigits === clientTaxDigits) ||
      (issuerNameKey &&
        ((clientNameKey && issuerNameKey === clientNameKey) ||
          (clientTradeKey && issuerNameKey === clientTradeKey))),
  );

  const recipientTaxDigits = normalizeTaxIdDigits(doc.recipientTaxId);
  const recipientNameKey = normalizeClientNameKey(doc.recipientName);
  const docRecipientEmail = cleanClientString(doc.recipientEmail)?.toLowerCase() || null;
  const matchesRecipient = Boolean(
    (clientTaxDigits && recipientTaxDigits && recipientTaxDigits === clientTaxDigits) ||
      (clientEmail && docRecipientEmail && clientEmail === docRecipientEmail) ||
      (recipientNameKey &&
        ((clientNameKey && recipientNameKey === clientNameKey) ||
          (clientTradeKey && recipientNameKey === clientTradeKey))),
  );

  const linkedDirect = doc.clientId === client.id;
  const matches = matchesIssuer || matchesRecipient || linkedDirect;

  let clientRole: ClientDocumentRole = 'linked';
  if (matchesIssuer && matchesRecipient) clientRole = 'both';
  else if (matchesIssuer) clientRole = 'issuer';
  else if (matchesRecipient) clientRole = 'recipient';
  else if (linkedDirect) clientRole = 'linked';

  return { matches, clientRole };
}
