export interface DocumentArticleItem {
  codigo?: string | null;
  nombre: string;
  cantidad?: number | null;
  precioSinIva?: number | null;
  precioFinal?: number | null;
  ivaPorcentaje?: number | null;
}

export interface UniversalDocumentExtractionResult {
  documentType: string;
  summary: string;
  documentNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  issuerName: string | null;
  issuerTaxId: string | null;
  recipientName: string | null;
  recipientTaxId: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  deliveryAddress: string | null;
  responsiblePerson: string | null;
  currency: string | null;
  netAmount: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  paymentTerms: string | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  cae: string | null;
  taxCondition: string | null;
  equipmentId: string | null;
  equipmentModel: string | null;
  meterCount: string | null;
  tags: string[];
  items: Array<DocumentArticleItem>;
  extractedData: {
    attributes: Record<string, string | number | boolean | null>;
    items: Array<DocumentArticleItem>;
    involvedParties: Array<{ name: string; role?: string; identifier?: string }>;
    dates: Record<string, string>;
    amounts: Record<string, number>;
  };
  rawText: string;
  pageCount: number;
  aiConfidence: number;
  extractionEngine: 'gemini_vision' | 'gemini_text' | 'local_parser';
  tokensUsed: number;
}

const KNOWN_TYPE_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: 'factura', regex: /\b(factura|invoice|comprobante\s+electr[oó]nico|cae\b)/i },
  { type: 'presupuesto', regex: /\b(presupuesto|cotizaci[oó]n|quotation)/i },
  { type: 'nota_pedido', regex: /\b(nota\s+de\s+pedido|solicitud\s+de\s+compra)/i },
  { type: 'orden_compra', regex: /\b(orden\s+de\s+compra|purchase\s+order|\bo[\.\s]?c[\.\s]?\b)/i },
  { type: 'remito', regex: /\b(remito|gu[ií]a\s+de\s+despacho|entrega\s+de\s+mercader[ií]a)/i },
  { type: 'recibo', regex: /\b(recibo|comprobante\s+de\s+pago|orden\s+de\s+pago)/i },
  { type: 'orden_servicio', regex: /\b(servicio\s+t[eé]cnico|orden\s+de\s+servicio|parte\s+t[eé]cnico|informe\s+t[eé]cnico)/i },
  { type: 'contrato', regex: /\b(contrato|acuerdo|convenio|cl[aá]usula)/i },
  { type: 'legajo', regex: /\b(legajo|curr[ií]culum|recibo\s+de\s+haberes|alta\s+temprana)/i },
];

const SPANISH_MONTHS: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

const parseSpanishOrIsoDate = (text: string): string | null => {
  // 1. Textual: "20 de abril de 2022", "15 de junio de 2023", "Mar del Plata 20 de abril de 2022"
  const textualMatch = text.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(20\d{2})\b/i,
  );
  if (textualMatch) {
    const day = textualMatch[1].padStart(2, '0');
    const monthKey = textualMatch[2].toLowerCase();
    const month = SPANISH_MONTHS[monthKey] || '01';
    const year = textualMatch[3];
    return `${year}-${month}-${day}`;
  }

  // 2. ISO YYYY-MM-DD
  const isoMatch = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) return isoMatch[0];

  // 3. DD/MM/YYYY o DD-MM-YYYY (incluso pegado a palabras como FACTURA06/10/2026)
  const latamMatch = text.match(/(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[\/\-](0?[1-9]|1[0-2])[\/\-](20\d{2})\b/);
  if (latamMatch) {
    const day = latamMatch[1].padStart(2, '0');
    const month = latamMatch[2].padStart(2, '0');
    const year = latamMatch[3];
    return `${year}-${month}-${day}`;
  }

  return null;
};

const parseAmountValue = (raw: string): number | null => {
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;

  // Formato 1.234.567,89 vs 1,234,567.89 vs 47819.20
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  }

  const num = Number(normalized);
  return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : null;
};

const cleanItemName = (raw: string): string => {
  let s = (raw || '').trim();
  s = s
    .replace(/(ALQUILER)(EQUIPO)/i, '$1 $2')
    .replace(/(EXCEDENTE)(POR)(COPIA)/i, '$1 $2 $3')
    .replace(/(SERVICIO)(TECNICO)/i, '$1 $2')
    .replace(/(MANO)(DE)(OBRA)/i, '$1 $2 $3')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
};

const IGNORED_ITEM_PATTERNS = [
  /^(factura|presupuesto|nota\s+de\s+pedido|remito|recibo|orden\s+de\s+compra|servicio\s+t[eé]cnico)/i,
  /^(se[ñn]ores|domicilio|localidad|responsable|precio\s*publico|cta\.?\s*cte|condici[oó]n)/i,
  /^(transferencia|cbu|alias|banco|transporte|user:|original|duplicado|c\.a\.e|fechavto|vto)/i,
  /^(total|subtotal|iva\s*\d+|neto|impuestos|garant[ií]a|validez|saluda|de\s+nuestra|contacto|e-?mail|direcci[oó]n|tel|cel)/i,
  /^(forma\s+de\s+pago|observaciones|retira|compra\s+un|pagara)/i,
  /^act:\d+-ant:\d+/i,
  /^id:\s*\d+/i,
  /^\b(20|23|24|27|30|33|34)[-\s]?\d{8}[-\s]?\d\b/,
  /^\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/i,
  /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

/**
 * Enlista artículos / ítems presentes en el documento analizando patrones
 * estándar en comprobantes de cualquier empresa o rubro comercial/técnico.
 */
export const extractUniversalItemsFromText = (rawText: string): DocumentArticleItem[] => {
  if (!rawText) return [];
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const items: DocumentArticleItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IGNORED_ITEM_PATTERNS.some((pat) => pat.test(line))) {
      continue;
    }

    // A) Multi-línea ERP: código numérico en su propia línea
    if (/^\d{6,14}$/.test(line)) {
      const nextLine = lines[i + 1];
      if (
        nextLine &&
        /^[A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s.-]{3,60}$/.test(nextLine) &&
        !IGNORED_ITEM_PATTERNS.some((pat) => pat.test(nextLine))
      ) {
        const code = line;
        const name = cleanItemName(nextLine);
        let qty = 1;
        let pSinIva: number | null = null;
        let pFinal: number | null = null;
        let consumed = 2;

        if (i + 2 < lines.length && /^\d+(?:\.\d+)?$/.test(lines[i + 2])) {
          qty = parseFloat(lines[i + 2]);
          consumed = 3;
        }
        if (i + 3 < lines.length && /^\d+(?:\.\d+)?$/.test(lines[i + 3])) {
          pSinIva = parseAmountValue(lines[i + 3]);
          consumed = 4;
        }
        if (i + 4 < lines.length && /^\d+(?:\.\d+)?$/.test(lines[i + 4])) {
          pFinal = parseAmountValue(lines[i + 4]);
          consumed = 5;
        }

        if (name && name.length >= 3) {
          items.push({
            codigo: code,
            nombre: name,
            cantidad: Number.isFinite(qty) ? qty : 1,
            precioSinIva: pSinIva,
            precioFinal: pFinal ?? pSinIva,
          });
          i += consumed - 1;
          continue;
        }
      }
    }

    // Patrón 1: ERP compacto o Factura (ej: 800000001ALQUILEREQUIPO1.0039520.00039520.00 o con espacios)
    const erpMatch =
      line.match(
        /^(\d{5,14})\s*([A-Za-zÁÉÍÓÚáéíóúÑñ\s.-]{3,45}?)\s*(\d+(?:\.\d{2})?)\s*(\d+(?:\.\d{2})?)\s*(\d+(?:\.\d{2})?)$/,
      ) ||
      line.match(
        /^(\d{5,14})\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s.-]{3,45})\s+(\d+(?:\.\d+)?)\s+([\d.,]+)\s+([\d.,]+)$/,
      );
    if (erpMatch) {
      const code = erpMatch[1].trim();
      const name = cleanItemName(erpMatch[2]);
      const qty = parseFloat(erpMatch[3]);
      const pSinIva = parseAmountValue(erpMatch[4]);
      const pFinal = parseAmountValue(erpMatch[5]);
      if (name && name.length >= 3) {
        items.push({
          codigo: code,
          nombre: name,
          cantidad: Number.isFinite(qty) ? qty : 1,
          precioSinIva: pSinIva,
          precioFinal: pFinal ?? pSinIva,
        });
        continue;
      }
    }

    // Patrón 2: Prefijo de código - Descripción $ Precio [% IVA $ MontoIVA] [$ Total]
    // Ej: HC 1 - M320F $ 235000 21 % $ 49350 $ 284350
    // Ej: BK 1 - TONER TIPO SP 3710X $ 17000
    const prefixMatch = line.match(
      /^([A-Z0-9-]{2,8}(?:\s+\d+)?)\s*[-–]\s*([^\$\n]{3,60}?)\s*\$?\s*([\d.,]+)(?:\s*(\d{1,2})\s*%\s*\$?\s*([\d.,]+))?(?:\s*\$?\s*([\d.,]+))?$/i,
    );
    if (prefixMatch) {
      const code = prefixMatch[1].trim();
      const name = cleanItemName(prefixMatch[2]);
      const pSinIva = parseAmountValue(prefixMatch[3]);
      const ivaPct = prefixMatch[4] ? Number(prefixMatch[4]) : null;
      const pFinal = prefixMatch[6] ? parseAmountValue(prefixMatch[6]) : pSinIva;
      if (name && name.length >= 3) {
        items.push({
          codigo: code,
          nombre: name,
          cantidad: 1,
          precioSinIva: pSinIva,
          precioFinal: pFinal,
          ivaPorcentaje: ivaPct,
        });
        continue;
      }
    }

    // Patrón 3: Viñeta con cantidad opcional entre paréntesis y precio opcional
    // Ej:  UNI FOTOCONDUCTORA MP 201-1515 (1)
    // Ej: UNI FOTOCONDUCTORA MP 201-1515 (1)
    // Ej: • Rodillo Fusor (3) $ 4500
    // Ej: - Mano de Obra (1)
    const bulletMatch =
      line.match(/^(?:[•\-*]\s*)?([^$\n\r()]{3,60}?)\s*\((\d+)\)(?:\s*\$?\s*([\d.,]+))?$/) ||
      line.match(/^[•\-*]\s*([^$\n\r()]{3,60}?)(?:\s*\((\d+)\))?(?:\s*\$?\s*([\d.,]+))?$/);
    if (bulletMatch) {
      const name = cleanItemName(bulletMatch[1]);
      const qty = bulletMatch[2] ? parseInt(bulletMatch[2], 10) : 1;
      const price = bulletMatch[3] ? parseAmountValue(bulletMatch[3]) : null;
      if (
        name &&
        name.length >= 3 &&
        !/^(pagara|retira|compra\s+un|de\s+nuestra|validez)/i.test(name)
      ) {
        items.push({
          codigo: null,
          nombre: name,
          cantidad: Number.isFinite(qty) ? qty : 1,
          precioSinIva: price,
          precioFinal: price,
        });
        continue;
      }
    }

    // Patrón 4: Tabular estándar con Código al inicio
    // Ej: ART01 Toner Negro HP 2 $ 5500.00 $ 11000.00
    const tabularMatch = line.match(
      /^([A-Z0-9-]{3,12})\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s./()\-]{3,45})\s+(\d+(?:\.\d+)?)\s+\$?\s*([\d.,]{2,14})\s+\$?\s*([\d.,]{2,14})$/,
    );
    if (tabularMatch) {
      const code = tabularMatch[1].trim();
      const name = cleanItemName(tabularMatch[2]);
      const qty = parseFloat(tabularMatch[3]);
      const pSinIva = parseAmountValue(tabularMatch[4]);
      const pFinal = parseAmountValue(tabularMatch[5]);
      if (name && name.length >= 3) {
        items.push({
          codigo: code,
          nombre: name,
          cantidad: Number.isFinite(qty) ? qty : 1,
          precioSinIva: pSinIva,
          precioFinal: pFinal ?? pSinIva,
        });
        continue;
      }
    }

    // Patrón 5: Cantidad al inicio (ej: 3 x Cable HDMI $ 1200 o 2 Unidades Resma A4 $ 4500)
    const qtyFirstMatch = line.match(
      /^(\d{1,4})\s*(?:x|u|unid|unidades|un\b)?\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s./()\-]{3,50})\s+\$?\s*([\d.,]{2,14})(?:\s+\$?\s*([\d.,]{2,14}))?$/i,
    );
    if (qtyFirstMatch) {
      const qty = parseInt(qtyFirstMatch[1], 10);
      const name = cleanItemName(qtyFirstMatch[2]);
      const pSinIva = parseAmountValue(qtyFirstMatch[3]);
      const pFinal = qtyFirstMatch[4]
        ? parseAmountValue(qtyFirstMatch[4])
        : pSinIva
          ? pSinIva * qty
          : null;
      if (name && name.length >= 3 && !/^(telefono|celular|fecha|comprobante)/i.test(name)) {
        items.push({
          codigo: null,
          nombre: name,
          cantidad: qty,
          precioSinIva: pSinIva,
          precioFinal: pFinal,
        });
        continue;
      }
    }
  }

  return items;
};

/**
 * Extractor heurístico universal para operación offline / entorno local sin API Key.
 * Analiza cualquier PDF con texto embebido y extrae atributos clave-valor dinámicos.
 */
export const extractUniversalHeuristicsFromText = (
  rawText: string,
  originalFileName: string,
  pageCount: number,
): UniversalDocumentExtractionResult => {
  const cleanText = (rawText || '').replace(/\r/g, '').trim();
  const combinedSource = `${originalFileName}\n${cleanText}`;

  let detectedType = 'documento_general';
  for (const candidate of KNOWN_TYPE_PATTERNS) {
    if (candidate.regex.test(combinedSource)) {
      detectedType = candidate.type;
      break;
    }
  }

  // CUIT / Tax IDs
  const allCuits = cleanText.match(/\b(?:20|23|24|27|30|33|34)[-\s]?\d{8}[-\s]?\d\b/g) || [];
  const primaryTaxId = allCuits[0] ? allCuits[0].replace(/\s+/g, '') : null;

  // Número de comprobante: Codigo01Nro.00008-00041980 o Nro: 0001-00001234
  const docNumMatch =
    cleanText.match(/(?:n[°ºro.\s]*|comprobante\s*[:#]?\s*|nro\.?)(\d{4,5}\s*-\s*\d{6,8})/i) ||
    cleanText.match(/(?:factura|remito|pedido|orden|contrato|nro\.?)\s*[#n°º:]*\s*([A-Z0-9-]{4,20})/i);

  // Fechas: principal y vencimiento
  const documentDate = parseSpanishOrIsoDate(cleanText);
  let dueDate: string | null = null;
  const vtoMatch = cleanText.match(/(?:fechavto\.?|vto\.?|vencimiento|fecha\s+de\s+vencimiento)[:\s]*([^\n\r]+)/i);
  if (vtoMatch) {
    dueDate = parseSpanishOrIsoDate(vtoMatch[1]);
  }

  // Moneda
  const currency = /\b(USD|U\$S|D[OÓ]LARES)\b/i.test(cleanText)
    ? 'USD'
    : /(\$|ARS|PESOS)/i.test(cleanText)
      ? 'ARS'
      : null;

  // Importe Total
  const totalMatch =
    cleanText.match(/(?:total(?:\s+general|\s+a\s+pagar|\s+hc)?|importe\s+total)\s*[:$]?\s*(?:ARS|USD|U\$S|\$)?\s*([\d.,]{2,18})/i) ||
    cleanText.match(/\$\s*([\d.]+,\d{2})/) ||
    cleanText.match(/\$\s*(\d{4,9})/);
  const totalAmount = totalMatch ? parseAmountValue(totalMatch[1]) : null;

  // IVA e Importe Neto
  let taxAmount: number | null = null;
  let netAmount: number | null = null;
  const ivaMatch = cleanText.match(/(?:iva|21%|10\.5%)\s*[:$]?\s*([\d.,]{2,18})/i);
  if (ivaMatch) {
    taxAmount = parseAmountValue(ivaMatch[1]);
  }
  const subtotalMatch = cleanText.match(/(?:subtotal|neto|sub-total)\s*[:$]?\s*([\d.,]{2,18})/i);
  if (subtotalMatch) {
    netAmount = parseAmountValue(subtotalMatch[1]);
  } else if (totalAmount !== null && taxAmount !== null && totalAmount >= taxAmount) {
    netAmount = Math.round((totalAmount - taxAmount) * 100) / 100;
  }

  // CAE de AFIP (14 dígitos consecutivos)
  const caeMatch = cleanText.match(/C\.?A\.?E\.?[:\s]*(\d{14})/i);
  const cae = caeMatch ? caeMatch[1] : null;

  // Condición fiscal (Responsable inscripto, Monotributo, Exento)
  const taxCondMatch = cleanText.match(/\b(responsable\s*inscripto|monotributo|exento|consumidor\s*final)\b/i);
  const taxCondition = taxCondMatch ? taxCondMatch[1] : null;

  // ID de equipo o impresora (ej. "ID: 1532", "ID: 7016", "ID: 3846")
  const equipIdMatch = cleanText.match(/\bID[:\s]*(\d{2,10})\b/i);
  const equipmentId = equipIdMatch ? equipIdMatch[1] : null;

  // Modelo de equipo (ej. "MP 161 SPF", "M320F", "E52645")
  const equipModelMatch =
    cleanText.match(/Equipo[:\s]*([^,\n\r\t]+?)(?:\s+ID[:\s]|\n|$)/i) ||
    cleanText.match(/\b(MP\s*\d+\s*[A-Z]*|M320F|E52645|LaserJet[A-Za-z0-9\s-]+)\b/i);
  const equipmentModel = equipModelMatch ? equipModelMatch[1].trim() : null;

  // Contador de copias (ej. "ACT:8-ANT:7")
  const meterMatch = cleanText.match(/ACT[:\s]*(\d+)\s*-\s*ANT[:\s]*(\d+)/i);
  const meterCount = meterMatch ? `ACT:${meterMatch[1]} - ANT:${meterMatch[2]}` : null;

  // Emisor / Proveedor
  const issuerMatch = cleanText.match(/(?:proveedor|emisor|empresa)\s*:\s*([^\n]{3,90})/i);
  let issuerName = issuerMatch ? issuerMatch[1].trim() : null;
  if (!issuerName && /HELP\s*COPIES/i.test(cleanText)) {
    issuerName = 'HELP COPIES S.R.L.';
  }

  // Cliente / Destinatario / Razón Social
  const recipientMatch =
    cleanText.match(/(?:se[ñn]or(?:es)?|raz[oó]n\s+social|cliente|destinatario)[:\s]*([^\n\r0-9]{3,90})/i) ||
    cleanText.match(/(?:se[ñn]or(?:es)?|raz[oó]n\s+social|cliente)[:\s]*([^\n\r]{3,90})/i);
  let recipientName = recipientMatch ? recipientMatch[1].trim().replace(/\d{5,}.*$/, '').trim() : null;

  // Domicilio y Localidad
  const addrMatch = cleanText.match(/(?:domicilio|direcci[oó]n|entrega\s+en)[:\s]*([^\n\r]{4,100})/i);
  const locMatch = cleanText.match(/Localidad[:\s]*([^\n\r]{3,60})/i);
  let deliveryAddress = addrMatch ? addrMatch[1].trim() : null;
  if (deliveryAddress && locMatch) {
    deliveryAddress = `${deliveryAddress}, ${locMatch[1].trim()}`;
  } else if (!deliveryAddress && locMatch) {
    deliveryAddress = locMatch[1].trim();
  }

  // Teléfono / Celular
  const phoneMatch = cleanText.match(/(?:tel[eé]fono|celular|tel|cel)[:\s]*([0-9\s\(\)\-\+]{6,25})/i);
  const recipientPhone = phoneMatch ? phoneMatch[1].trim() : null;

  // Email
  const emailMatch = cleanText.match(/(?:e-?mail|correo)[:\s]*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  const recipientEmail = emailMatch ? emailMatch[1].trim() : null;

  // Identificar CUIT de cliente y emisor con precisión
  let recipientTaxId = primaryTaxId;
  let issuerTaxId: string | null = null;

  const clientBlockMatch = cleanText.match(
    /(?:se[ñn]or(?:es)?|raz[oó]n\s+social|cliente)[:\s]*([\s\S]{1,250}?)(?:\b(?:transferencia|c\.?a\.?e\.?|precio|total|subtotal|act:)\b|$)/i,
  );
  if (clientBlockMatch) {
    const clientCuits = clientBlockMatch[0].match(/\b(?:20|23|24|27|30|33|34)[-\s]?\d{8}[-\s]?\d\b/g);
    if (clientCuits && clientCuits.length > 0) {
      recipientTaxId = clientCuits[0].replace(/\s+/g, '');
      issuerTaxId = allCuits.map((c) => c.replace(/\s+/g, '')).find((c) => c !== recipientTaxId) || null;
      if (!issuerTaxId && issuerName && /HELP\s*COPIES/i.test(issuerName)) {
        issuerTaxId = '30-71171817-2';
      }
    }
  }

  if (!issuerTaxId) {
    if (issuerName && /HELP\s*COPIES/i.test(issuerName)) {
      issuerTaxId = '30-71171817-2';
    } else {
      issuerTaxId = allCuits.map((c) => c.replace(/\s+/g, '')).find((c) => c !== recipientTaxId) || primaryTaxId;
    }
  }

  // Responsable / Contacto / Firma
  const responsibleMatch =
    cleanText.match(/(?:saluda\s*(?:a\s*usted\s*)?atte:?)\s*([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{3,50})/i) ||
    cleanText.match(/(?:contacto|vendedor|responsable|solicitante|autorizado\s+por|firmante)\s*:\s*([^\n\r]{3,60})/i) ||
    cleanText.match(/(?<!servicio\s)(?<!soporte\s)\bt[eé]cnico\s*:\s*([^\n\r]{3,60})/i);
  const responsiblePerson = responsibleMatch ? responsibleMatch[1].trim() : null;

  // Forma de pago y observaciones
  const paymentTermsMatch = cleanText.match(/(?:forma\s+de\s+pago|condici[oó]n\s+de\s+venta|cta\.?\s*cte\.?|validez(?:\s+de\s+la\s+propuesta)?)[:\s]*([^\n\r]{3,100})/i);
  const paymentTerms = paymentTermsMatch ? paymentTermsMatch[1].trim() : null;

  const paymentMethod = /transferencia/i.test(cleanText)
    ? 'Transferencia Bancaria'
    : /cheque/i.test(cleanText)
      ? 'Cheque'
      : /efectivo/i.test(cleanText)
        ? 'Efectivo'
        : null;

  // Extraer pares dinámicos "Etiqueta: Valor" presentes en el documento (agnóstico al rubro)
  const attributes: Record<string, string | number | boolean | null> = {};
  const lines = cleanText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 60)) {
    const kv = line.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s./()-]{2,35}):\s*(.{1,100})$/);
    if (kv) {
      const key = kv[1].trim().toLowerCase().replace(/\s+/g, '_');
      if (!attributes[key] && Object.keys(attributes).length < 20) {
        attributes[key] = kv[2].trim();
      }
    }
  }

  if (equipmentId) attributes['equipo_id'] = equipmentId;
  if (meterCount) attributes['contador'] = meterCount;
  if (cae) attributes['cae'] = cae;

  const firstLines = lines.slice(0, 3).join(' · ').slice(0, 220);
  const summary = cleanText.length > 20
    ? `Documento clasificado como ${detectedType.replace(/_/g, ' ')}. ${firstLines}`
    : `Archivo PDF registrado (${originalFileName}). Procesado con motor OCR nativo.`;

  const tags = [detectedType];
  if (equipmentId) tags.push(`id_${equipmentId}`);
  if (detectedType === 'factura') tags.push('afip');
  if (!cleanText) tags.push('escaneo_imagen');

  const extractedItems = extractUniversalItemsFromText(cleanText);

  return {
    documentType: detectedType,
    summary,
    documentNumber: docNumMatch ? docNumMatch[1].replace(/\s+/g, '') : null,
    documentDate,
    dueDate,
    issuerName,
    issuerTaxId,
    recipientName,
    recipientTaxId,
    recipientPhone,
    recipientEmail,
    deliveryAddress,
    responsiblePerson,
    currency: totalAmount !== null ? currency : null,
    netAmount,
    taxAmount,
    totalAmount,
    paymentTerms,
    paymentMethod,
    referenceNumber: null,
    cae,
    taxCondition,
    equipmentId,
    equipmentModel,
    meterCount,
    tags,
    items: extractedItems,
    extractedData: {
      attributes,
      items: extractedItems,
      involvedParties: [],
      dates: {
        ...(documentDate ? { fecha_documento: documentDate } : {}),
        ...(dueDate ? { fecha_vencimiento: dueDate } : {}),
      },
      amounts: {
        ...(netAmount !== null ? { subtotal: netAmount } : {}),
        ...(taxAmount !== null ? { impuestos: taxAmount } : {}),
        ...(totalAmount !== null ? { total: totalAmount } : {}),
      },
    },
    rawText: cleanText,
    pageCount,
    aiConfidence: cleanText.length > 60 ? 0.75 : 0.3,
    extractionEngine: 'local_parser',
    tokensUsed: 0,
  };
};

