import { Document } from '../../documents/document.model';

export function buildReceiptAckMessage(params: {
  fileName: string;
  documentId: number;
  channelName: 'WhatsApp' | 'Telegram';
}): string {
  return [
    `📥 *Documento recibido exitosamente — HC-SCAN*`,
    ``,
    `El archivo *${params.fileName}* (#DOC-${params.documentId}) fue recibido por ${params.channelName}, resguardado de forma segura en su bóveda digital y se encuentra *en proceso de análisis OCR e IA esperando validación*.`,
    ``,
    `Le notificaremos automáticamente por este medio cuando finalice la extracción de datos.`,
  ].join('\n');
}

export function buildDuplicateNoticeMessage(params: {
  fileName: string;
  documentId: number;
}): string {
  return [
    `ℹ️ *Documento ya registrado — HC-SCAN*`,
    ``,
    `El archivo *${params.fileName}* ya se encontraba almacenado en su bóveda digital (#DOC-${params.documentId}), por lo que no fue necesario volver a procesarlo.`,
  ].join('\n');
}

export function buildOcrCompletedMessage(doc: Document): string {
  const docType = (doc.documentType || 'comprobante').replace(/_/g, ' ');
  const lines = [
    `✅ *Análisis completado — Esperando validación*`,
    ``,
    `El documento *${doc.originalName}* (#DOC-${doc.id}) fue procesado exitosamente y quedó *pendiente de validación y aprobación* en el portal.`,
    `• Tipo detectado: ${docType}`,
  ];

  if (doc.documentNumber) {
    lines.push(`• N° Comprobante: ${doc.documentNumber}`);
  }
  if (doc.issuerName) {
    lines.push(`• Emisor: ${doc.issuerName}`);
  }
  if (doc.totalAmount !== null && doc.totalAmount !== undefined) {
    const currency = doc.currency || 'ARS';
    lines.push(
      `• Importe Total: ${currency} ${Number(doc.totalAmount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`,
    );
  }

  return lines.join('\n');
}

export function buildIngestErrorMessage(params: {
  fileName: string;
  reason: string;
}): string {
  return [
    `⚠️ *No se pudo procesar el documento — HC-SCAN*`,
    ``,
    `• Archivo: *${params.fileName}*`,
    `• Motivo: ${params.reason}`,
  ].join('\n');
}

export function buildWhatsappReceivedNotification(): string {
  return '📥 Documento recibido en HelpScan';
}

export function buildWhatsappDuplicateNotification(): string {
  return 'ℹ️ Documento ya registrado en HelpScan';
}

export function buildWhatsappIndexedNotification(): string {
  return '✅ Documento indexado en HelpScan';
}
