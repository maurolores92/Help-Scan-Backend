import { FetchedEmailItem, ParsedEmailAttachment } from '../services/imap-client.service';

/**
 * Extrae email y nombre desde strings tipo `"Juan Perez <juan@empresa.com>"` o `"juan@empresa.com"`.
 */
export function parseSenderAddress(rawFrom?: string | null): {
  senderName: string | null;
  senderEmail: string;
} {
  const raw = String(rawFrom || '').trim();
  const angleMatch = raw.match(/^(.*?)<([^<>]+@[^<>]+)>$/);
  if (angleMatch) {
    const cleanName = angleMatch[1].replace(/^["'\s]+|["'\s]+$/g, '').trim();
    const email = angleMatch[2].trim().toLowerCase();
    return {
      senderName: cleanName || null,
      senderEmail: email || 'webhook@correo.local',
    };
  }

  if (raw.includes('@')) {
    return {
      senderName: null,
      senderEmail: raw.toLowerCase(),
    };
  }

  return {
    senderName: raw || null,
    senderEmail: 'webhook@correo.local',
  };
}

/**
 * Normaliza múltiples formatos JSON de webhooks de correo entrante
 * (payload directo, Resend, Postmark, Mailgun JSON, Cloudflare Worker, n8n / Make)
 * hacia el contrato unificado `FetchedEmailItem`.
 */
export function normalizeInboundEmailWebhookPayload(
  rawBody: any,
  sanitizeHtmlFn: (html?: string | null) => string | null,
): FetchedEmailItem {
  const payload =
    rawBody?.data && typeof rawBody.data === 'object' && !Array.isArray(rawBody.data)
      ? { ...rawBody, ...rawBody.data }
      : rawBody || {};

  const parsedFrom = parseSenderAddress(
    payload.senderEmail ||
      payload.from ||
      payload.From ||
      payload.sender ||
      payload.envelope?.from,
  );

  const senderEmail = (
    payload.senderEmail ||
    parsedFrom.senderEmail ||
    'webhook@correo.local'
  )
    .toString()
    .trim()
    .toLowerCase()
    .slice(0, 250);

  const senderNameRaw =
    payload.senderName ||
    payload.fromName ||
    payload.FromName ||
    parsedFrom.senderName;
  const senderName = senderNameRaw
    ? String(senderNameRaw).trim().slice(0, 250)
    : null;

  const subject = String(
    payload.subject || payload.Subject || '(Sin asunto - Webhook)',
  )
    .trim()
    .slice(0, 490);

  const bodyText = String(
    payload.bodyText ||
      payload.text ||
      payload.TextBody ||
      payload['body-plain'] ||
      '',
  ).trim();

  const rawHtml =
    payload.bodyHtml || payload.html || payload.HtmlBody || payload['body-html'] || null;
  const bodyHtmlSanitized = sanitizeHtmlFn(typeof rawHtml === 'string' ? rawHtml : null);

  const rawReceivedAt = payload.receivedAt || payload.date || payload.Date;
  const parsedDate = rawReceivedAt ? new Date(rawReceivedAt) : new Date();
  const receivedAt = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

  const rawMessageId =
    payload.messageId ||
    payload.MessageID ||
    payload['Message-Id'] ||
    payload.email_id ||
    payload.id;
  const messageId = (
    rawMessageId
      ? String(rawMessageId).trim()
      : `wh-${receivedAt.getTime()}-${Math.random().toString(36).slice(2, 10)}`
  ).slice(0, 250);

  const rawAttachments = Array.isArray(payload.attachments)
    ? payload.attachments
    : Array.isArray(payload.Attachments)
      ? payload.Attachments
      : [];

  const attachments: ParsedEmailAttachment[] = [];
  for (let i = 0; i < rawAttachments.length; i++) {
    const att = rawAttachments[i];
    if (!att || typeof att !== 'object') continue;

    const rawBase64 =
      att.contentBase64 || att.base64 || att.content || att.Content || '';
    if (!rawBase64 || typeof rawBase64 !== 'string') continue;

    const cleanedB64 = rawBase64.replace(/^data:[^;]+;base64,/i, '').trim();
    const content = Buffer.from(cleanedB64, 'base64');
    if (content.length === 0) continue;

    const filename = String(
      att.filename || att.name || att.Name || `adjunto_${i + 1}.pdf`,
    ).trim();
    const contentType = String(
      att.contentType ||
        att.content_type ||
        att.ContentType ||
        (filename.toLowerCase().endsWith('.pdf')
          ? 'application/pdf'
          : 'application/octet-stream'),
    )
      .toLowerCase()
      .trim();

    attachments.push({
      filename,
      contentType,
      size: Number(att.size) || content.length,
      content,
    });
  }

  return {
    uid: 0,
    messageId,
    senderName,
    senderEmail,
    subject,
    receivedAt,
    bodyText,
    bodyHtmlSanitized,
    attachments,
  };
}
