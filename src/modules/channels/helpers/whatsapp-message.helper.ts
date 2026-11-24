/**
 * Desenvuelve wrappers estándar de Baileys (ephemeral, viewOnce, documentWithCaption).
 */
export function unwrapWhatsappMessageContent(rawMessage: any): any {
  let current = rawMessage;
  for (let i = 0; i < 4 && current; i++) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Extrae si el mensaje contiene un documento o imagen adjunta real.
 */
export function extractWhatsappAttachmentInfo(rawMessage: any): {
  content: any;
  docMsg: any;
  imgMsg: any;
  hasAttachment: boolean;
} {
  const content = unwrapWhatsappMessageContent(rawMessage);
  const docMsg = content?.documentMessage || null;
  const imgMsg = content?.imageMessage || null;

  return {
    content,
    docMsg,
    imgMsg,
    hasAttachment: Boolean(docMsg || imgMsg),
  };
}
