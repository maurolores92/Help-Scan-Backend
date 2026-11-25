import { detectReceiptInEmailBody } from './helpers/email-receipt-detector.helper';
import { synthesizeEmailBodyToPdf } from './helpers/email-pdf-synthesizer.helper';
import {
  isEmailSenderAuthorized,
  normalizeAllowedEmailSenders,
  normalizeEmailSenderRule,
} from './helpers/email-sender-policy.helper';
import { EmailSenderPolicy } from './models/company-email-channel.model';

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

  it('normaliza correos exactos y dominios completos en la lista blanca', () => {
    expect(normalizeEmailSenderRule(' Facturas@Proveedor.COM ')).toBe('facturas@proveedor.com');
    expect(normalizeEmailSenderRule('Nombre <pagos@miempresa.com>')).toBe('pagos@miempresa.com');
    expect(normalizeEmailSenderRule('@Proveedor.COM')).toBe('@proveedor.com');
    expect(normalizeEmailSenderRule('proveedor.com.ar')).toBe('@proveedor.com.ar');
    expect(normalizeEmailSenderRule('*.banco.com')).toBe('@banco.com');
    expect(normalizeEmailSenderRule('texto invalido')).toBeNull();

    expect(
      normalizeAllowedEmailSenders([
        'Facturas@Uno.com',
        'facturas@uno.com',
        'dos.com',
        '@dos.com',
        'invalido',
      ]),
    ).toEqual(['facturas@uno.com', '@dos.com']);
  });

  it('valida autorización por correo exacto, dominio/subdominio y bloquea suplantaciones', () => {
    const allowed = ['facturas@puntual.com', '@proveedor.com'];

    expect(
      isEmailSenderAuthorized('cualquiera@ajeno.com', EmailSenderPolicy.ALL, []),
    ).toBe(true);

    expect(
      isEmailSenderAuthorized('FACTURAS@PUNTUAL.COM', EmailSenderPolicy.WHITELIST, allowed),
    ).toBe(true);
    expect(
      isEmailSenderAuthorized('otro@puntual.com', EmailSenderPolicy.WHITELIST, allowed),
    ).toBe(false);

    expect(
      isEmailSenderAuthorized('cobranzas@proveedor.com', EmailSenderPolicy.WHITELIST, allowed),
    ).toBe(true);
    expect(
      isEmailSenderAuthorized('no-reply@mail.proveedor.com', EmailSenderPolicy.WHITELIST, allowed),
    ).toBe(true);
    expect(
      isEmailSenderAuthorized('ataque@fakeproveedor.com', EmailSenderPolicy.WHITELIST, allowed),
    ).toBe(false);
    expect(
      isEmailSenderAuthorized('nadie@proveedor.com', EmailSenderPolicy.WHITELIST, []),
    ).toBe(false);
  });
});
