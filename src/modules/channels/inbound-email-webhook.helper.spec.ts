import { normalizeInboundEmailWebhookPayload } from './helpers/inbound-email-webhook.helper';

describe('inbound-email-webhook.helper', () => {
  it('normaliza payload JSON directo con adjunto Base64 y destinatario', () => {
    const samplePdfB64 = Buffer.from('%PDF-1.7\nFactura webhook').toString('base64');

    const parsed = normalizeInboundEmailWebhookPayload(
      {
        from: 'Proveedor Norte <facturacion@norte.com.ar>',
        subject: 'Factura A 0001-00001234',
        text: 'Adjuntamos factura.',
        html: '<p>Adjuntamos factura.<script>alert(1)</script></p>',
        attachments: [
          {
            filename: 'factura_1234.pdf',
            contentType: 'application/pdf',
            contentBase64: `data:application/pdf;base64,${samplePdfB64}`,
          },
        ],
      },
      (html) => (html ? html.replace(/<script>.*?<\/script>/g, '') : null),
    );

    expect(parsed.senderName).toBe('Proveedor Norte');
    expect(parsed.senderEmail).toBe('facturacion@norte.com.ar');
    expect(parsed.subject).toBe('Factura A 0001-00001234');
    expect(parsed.bodyHtmlSanitized).toBe('<p>Adjuntamos factura.</p>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('factura_1234.pdf');
    expect(parsed.attachments[0].content.toString('utf8')).toContain('%PDF-1.7');
  });
});
