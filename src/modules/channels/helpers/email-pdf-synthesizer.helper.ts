import pdfmake = require('pdfmake');

let fontsInitialized = false;

function ensurePdfMakeInitialized() {
  if (fontsInitialized) return;
  const instance: any = (pdfmake as any)?.default || pdfmake;
  if (typeof instance.setFonts === 'function') {
    instance.setFonts({
      Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    });
  }
  if (typeof instance.setUrlAccessPolicy === 'function') {
    instance.setUrlAccessPolicy(() => false);
  }
  if (typeof instance.setLocalAccessPolicy === 'function') {
    const allowedStandardFonts = new Set([
      'Helvetica',
      'Helvetica-Bold',
      'Helvetica-Oblique',
      'Helvetica-BoldOblique',
    ]);
    instance.setLocalAccessPolicy((resourcePath: string) =>
      allowedStandardFonts.has(resourcePath),
    );
  }
  fontsInitialized = true;
}

function getPdfMakeInstance(): any {
  ensurePdfMakeInitialized();
  return (pdfmake as any)?.default || pdfmake;
}

/**
 * Sintetiza el cuerpo de un correo transaccional (sin PDF adjunto) en un
 * documento PDF legible y estructurado para ser almacenado en la bóveda y procesado por IA.
 */
export async function synthesizeEmailBodyToPdf(params: {
  senderName?: string | null;
  senderEmail: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
}): Promise<Buffer> {
  const instance = getPdfMakeInstance();
  const formattedDate = params.receivedAt.toLocaleString('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const cleanText = (params.bodyText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 35000);

  const paragraphs = cleanText
    .split('\n')
    .map((line) => line.trimEnd())
    .map((line) => ({
      text: line || ' ',
      fontSize: 10,
      lineHeight: 1.3,
      margin: [0, 1, 0, 1] as [number, number, number, number],
    }));

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 45, 40, 45],
    defaultStyle: {
      font: 'Helvetica',
      color: '#1f2937',
    },
    content: [
      {
        text: 'COMPROBANTE DIGITAL GENERADO DESDE CORREO ELECTRÓNICO',
        fontSize: 11,
        bold: true,
        color: '#4f46e5',
        margin: [0, 0, 0, 8],
      },
      {
        table: {
          widths: ['22%', '78%'],
          body: [
            [
              { text: 'Remitente:', bold: true, fontSize: 9, color: '#4b5563' },
              {
                text: params.senderName
                  ? `${params.senderName} <${params.senderEmail}>`
                  : params.senderEmail,
                fontSize: 9,
              },
            ],
            [
              { text: 'Asunto:', bold: true, fontSize: 9, color: '#4b5563' },
              { text: params.subject || '(Sin asunto)', fontSize: 9, bold: true },
            ],
            [
              { text: 'Fecha Recepción:', bold: true, fontSize: 9, color: '#4b5563' },
              { text: formattedDate, fontSize: 9 },
            ],
          ],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 16],
      },
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: 515,
            y2: 0,
            lineWidth: 1,
            lineColor: '#e5e7eb',
          },
        ],
        margin: [0, 0, 0, 12],
      },
      ...paragraphs,
    ],
  };

  const pdfDoc = instance.createPdf(docDefinition);
  const buffer: Buffer = await pdfDoc.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

/**
 * Envuelve una imagen adjunta (JPG / PNG) enviada por correo en un archivo PDF estándar
 * para almacenarla en la bóveda y procesarla mediante OCR y Visión IA.
 */
export async function convertImageBufferToPdf(
  imageBuffer: Buffer,
  mimeType: string,
  title?: string,
): Promise<Buffer> {
  const instance = getPdfMakeInstance();
  const normalizedMime = mimeType.toLowerCase().includes('png')
    ? 'image/png'
    : 'image/jpeg';
  const dataUri = `data:${normalizedMime};base64,${imageBuffer.toString('base64')}`;

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [30, 35, 30, 35],
    defaultStyle: {
      font: 'Helvetica',
    },
    content: [
      ...(title
        ? [
            {
              text: `Imagen recibida por correo: ${title}`,
              fontSize: 9,
              color: '#6b7280',
              margin: [0, 0, 0, 10],
            },
          ]
        : []),
      {
        image: dataUri,
        fit: [535, 740],
        alignment: 'center',
      },
    ],
  };

  const pdfDoc = instance.createPdf(docDefinition);
  const buffer: Buffer = await pdfDoc.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}
