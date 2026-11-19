import { detectReceiptInEmailBody } from './helpers/email-receipt-detector.helper';
import { synthesizeEmailBodyToPdf } from './helpers/email-pdf-synthesizer.helper';

describe('Email Channel Helpers', () => {
  it('debe detectar comprobantes bancarios o Mercado Pago en el texto sin adjuntos', () => {
    const res = detectReceiptInEmailBody(
      'Comprobante de transferencia recibida',
      'Transferencia acreditada por $ 145.500,00. CUIT 30-71589234-9. Nro. de operación: 994812.',
    );

    expect(res.isReceipt).toBe(true);
    expect(res.matchedSignals.length).toBeGreaterThanOrEqual(2);
  });

  it('debe omitir respuestas automáticas y correos sin indicadores fiscales', () => {
    const res = detectReceiptInEmailBody(
      'Automatic reply: Fuera de la oficina',
      'Estaré de vacaciones hasta el lunes. Gracias por escribir.',
    );

    expect(res.isReceipt).toBe(false);
  });

  it('debe sintetizar el cuerpo de un correo a un buffer PDF válido (%PDF-)', async () => {
    const buf = await synthesizeEmailBodyToPdf({
      senderName: 'Mercado Pago',
      senderEmail: 'avisos@mercadopago.com',
      subject: 'Comprobante de pago #84910',
      receivedAt: new Date('2026-11-18T15:30:00Z'),
      bodyText: 'Pagaste $ 48.000,00 a Proveedora Sur SRL\nCUIT: 30-71112223-4\nCAE: 74481920193812',
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
