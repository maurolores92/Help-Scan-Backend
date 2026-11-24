import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { Op } from 'sequelize';
import ExcelJS = require('exceljs');
import pdfmake = require('pdfmake');
import {
  Document,
  DocumentPaymentStatus,
  DocumentStatusInfo,
} from '../document.model';
import { Company } from '../../companies/company.model';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';
import { ExportDocumentsQueryDto } from '../dto/export-documents-query.dto';
import { buildDocumentSearchWhere } from '../helpers/document-search.helper';
import { resolveSafeStorageFilePath } from '../../../common/utils/storage-path.util';
import { readDecryptedVaultFile } from '../../../common/utils/vault-crypto.util';

const MAX_TABULAR_EXPORT_ROWS = 1000;
const MAX_ZIP_EXPORT_FILES = 100;

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  [DocumentPaymentStatus.PENDING]: 'Pendiente de pago',
  [DocumentPaymentStatus.SCHEDULED]: 'Programado',
  [DocumentPaymentStatus.PAID]: 'Pagado',
  [DocumentPaymentStatus.NOT_APPLICABLE]: 'No aplica',
};

const SOURCE_LABELS: Record<string, string> = {
  APP_UPLOAD: 'Subida Web',
  FTP: 'Escáner / SFTP',
  EMAIL: 'Correo Email',
  WHATSAPP: 'WhatsApp',
  TELEGRAM: 'Telegram',
};

function sanitizeFileSegment(value?: string | null, maxLen = 32): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function formatMoney(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function formatMoneyDisplay(
  val: number | string | null | undefined,
  currency?: string | null,
): string {
  const num = formatMoney(val);
  if (num === null) return '—';
  return `${currency || '$'} ${num.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

@Injectable()
export class DocumentExportService {
  private readonly logger = new Logger(DocumentExportService.name);
  private fontsInitialized = false;

  constructor(
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly auditService: AuditService,
  ) {}

  private ensurePdfFonts(): void {
    if (this.fontsInitialized) return;
    const pdfmakeAny = pdfmake as any;
    try {
      const pkgDir = path.dirname(require.resolve('pdfmake/package.json'));
      const robotoDir = path.join(pkgDir, 'fonts', 'Roboto');
      const regular = path.join(robotoDir, 'Roboto-Regular.ttf');
      if (existsSync(regular)) {
        pdfmakeAny.setUrlAccessPolicy?.(() => false);
        pdfmakeAny.setLocalAccessPolicy?.((targetPath: string) =>
          targetPath.startsWith(robotoDir),
        );
        pdfmake.addFonts({
          Roboto: {
            normal: readFileSync(regular),
            bold: readFileSync(path.join(robotoDir, 'Roboto-Medium.ttf')),
            italics: readFileSync(path.join(robotoDir, 'Roboto-Italic.ttf')),
            bolditalics: readFileSync(path.join(robotoDir, 'Roboto-MediumItalic.ttf')),
          },
        });
        this.fontsInitialized = true;
        return;
      }
    } catch (err: any) {
      this.logger.warn(`No se pudieron cargar fuentes Roboto de pdfmake: ${err?.message}`);
    }

    pdfmakeAny.setUrlAccessPolicy?.(() => false);
    pdfmakeAny.setLocalAccessPolicy?.(() => false);
    pdfmake.addFonts({
      Roboto: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    });
    this.fontsInitialized = true;
  }

  async exportDocuments(
    companyId: number,
    userId: number,
    query: ExportDocumentsQueryDto,
    res: Response,
  ): Promise<void> {
    const format = query.format || 'xlsx';
    const maxLimit = format === 'zip' ? MAX_ZIP_EXPORT_FILES : MAX_TABULAR_EXPORT_ROWS;
    const where: any = buildDocumentSearchWhere(companyId, query);

    const parsedIds = String(query.ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (parsedIds.length > 0) {
      where[Op.and] = [...(where[Op.and] || []), { id: { [Op.in]: parsedIds } }];
    }

    const [docs, company] = await Promise.all([
      this.documentModel.findAll({
        where,
        attributes: { exclude: ['rawText'] },
        order: [
          ['documentDate', 'DESC'],
          ['createdAt', 'DESC'],
        ],
        limit: maxLimit,
      }),
      this.companyModel.findByPk(companyId, {
        attributes: ['id', 'name', 'slug'],
      }),
    ]);

    const companyName = company?.name || `Compañía #${companyId}`;
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `comprobantes_${sanitizeFileSegment(company?.slug || companyName, 24) || 'helpscan'}_${stamp}`;

    await this.auditService
      .log({
        action: AuditAction.DOWNLOAD,
        entity: 'Document',
        entityId: docs[0]?.id ?? companyId,
        companyId,
        userId,
        payload: {
          format,
          count: docs.length,
          selectedIdsCount: parsedIds.length,
          filters: {
            search: query.search || null,
            documentType: query.documentType || null,
            status: query.status || null,
            paymentStatus: query.paymentStatus || null,
            dueFilter: query.dueFilter || null,
            source: query.source || null,
            dateFrom: query.dateFrom || null,
            dateTo: query.dateTo || null,
          },
        },
        description: `Exportación administrativa (${format.toUpperCase()}) de ${docs.length} comprobante(s)`,
      })
      .catch(() => null);

    if (format === 'csv') {
      const csv = this.buildCsvString(docs);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${baseName}.csv"`,
      });
      res.send(csv);
      return;
    }

    if (format === 'xlsx') {
      const buffer = await this.buildXlsxBuffer(docs, companyName, query);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${baseName}.xlsx"`,
        'Content-Length': String(buffer.length),
      });
      res.send(buffer);
      return;
    }

    if (format === 'pdf') {
      const buffer = await this.buildPdfBuffer(docs, companyName, query);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${baseName}.pdf"`,
        'Content-Length': String(buffer.length),
      });
      res.send(buffer);
      return;
    }

    await this.streamZipResponse(docs, companyId, baseName, res);
  }

  private buildRowsMatrix(docs: Document[]) {
    return docs.map((doc) => {
      const statusLabel =
        DocumentStatusInfo[doc.status]?.label || doc.status || '—';
      const paymentLabel =
        PAYMENT_STATUS_LABELS[doc.paymentStatus] || doc.paymentStatus || 'Pendiente de pago';
      const warningsText = Array.isArray(doc.validationWarnings)
        ? doc.validationWarnings.map((w) => w.message).join(' | ')
        : '';

      return {
        id: doc.id,
        documentDate: doc.documentDate || doc.createdAt?.toISOString().slice(0, 10) || '',
        dueDate: doc.dueDate || '',
        documentType: (doc.documentType || 'otro').replace(/_/g, ' ').toUpperCase(),
        documentLetter: doc.documentLetter || '',
        pointOfSale: doc.pointOfSale || '',
        documentNumber: doc.documentNumber || '',
        issuerName: doc.issuerName || '',
        issuerTaxId: doc.issuerTaxId || '',
        recipientName: doc.recipientName || '',
        recipientTaxId: doc.recipientTaxId || '',
        currency: doc.currency || 'ARS',
        netAmount: formatMoney(doc.netAmount),
        taxAmount: formatMoney(doc.taxAmount),
        exemptAmount: formatMoney(doc.exemptAmount),
        otherTaxesAmount: formatMoney(doc.otherTaxesAmount),
        totalAmount: formatMoney(doc.totalAmount),
        status: statusLabel,
        paymentStatus: paymentLabel,
        paidAt: doc.paidAt || '',
        paymentReference: doc.paymentReference || '',
        purchaseOrderNumber: doc.purchaseOrderNumber || '',
        cae: doc.cae || '',
        source: SOURCE_LABELS[doc.source] || doc.source,
        originalName: doc.originalName,
        warnings: warningsText,
      };
    });
  }

  private buildCsvString(docs: Document[]): string {
    const headers = [
      'ID',
      'Fecha Emisión',
      'Vencimiento',
      'Tipo',
      'Letra',
      'Punto Venta',
      'N° Comprobante',
      'Emisor',
      'CUIT Emisor',
      'Receptor / Cliente',
      'CUIT Receptor',
      'Moneda',
      'Neto Gravado',
      'IVA / Impuestos',
      'Exento / No Gravado',
      'Otros Tributos',
      'Total',
      'Estado Validación',
      'Estado Pago',
      'Fecha Pago',
      'Ref. Pago',
      'O.C. / Referencia',
      'CAE',
      'Origen',
      'Archivo Original',
      'Alertas Fiscales',
    ];

    const rows = this.buildRowsMatrix(docs);
    const lines = [
      headers.map(csvEscape).join(';'),
      ...rows.map((r) =>
        [
          r.id,
          r.documentDate,
          r.dueDate,
          r.documentType,
          r.documentLetter,
          r.pointOfSale,
          r.documentNumber,
          r.issuerName,
          r.issuerTaxId,
          r.recipientName,
          r.recipientTaxId,
          r.currency,
          r.netAmount ?? '',
          r.taxAmount ?? '',
          r.exemptAmount ?? '',
          r.otherTaxesAmount ?? '',
          r.totalAmount ?? '',
          r.status,
          r.paymentStatus,
          r.paidAt,
          r.paymentReference,
          r.purchaseOrderNumber,
          r.cae,
          r.source,
          r.originalName,
          r.warnings,
        ]
          .map(csvEscape)
          .join(';'),
      ),
    ];

    return `\uFEFF${lines.join('\r\n')}`;
  }

  private async buildXlsxBuffer(
    docs: Document[],
    companyName: string,
    query: ExportDocumentsQueryDto,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Helpscan';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Comprobantes', {
      views: [{ state: 'frozen', ySplit: 4 }],
    });

    sheet.mergeCells('A1:Z1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `Helpscan — Listado Administrativo de Comprobantes (${companyName})`;
    titleCell.font = { bold: true, size: 13, color: { argb: 'FF1E293B' } };

    sheet.mergeCells('A2:Z2');
    const subCell = sheet.getCell('A2');
    subCell.value = `Generado: ${new Date().toLocaleString('es-AR')} | Registros: ${docs.length} | ${this.describeActiveFilters(query)}`;
    subCell.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };

    const headers = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Fecha Emisión', key: 'documentDate', width: 14 },
      { header: 'Vencimiento', key: 'dueDate', width: 14 },
      { header: 'Tipo', key: 'documentType', width: 16 },
      { header: 'Letra', key: 'documentLetter', width: 8 },
      { header: 'Pto. Vta.', key: 'pointOfSale', width: 11 },
      { header: 'N° Comprobante', key: 'documentNumber', width: 20 },
      { header: 'Emisor / Proveedor', key: 'issuerName', width: 28 },
      { header: 'CUIT Emisor', key: 'issuerTaxId', width: 16 },
      { header: 'Cliente / Receptor', key: 'recipientName', width: 28 },
      { header: 'CUIT Receptor', key: 'recipientTaxId', width: 16 },
      { header: 'Moneda', key: 'currency', width: 9 },
      { header: 'Neto Gravado', key: 'netAmount', width: 15 },
      { header: 'IVA', key: 'taxAmount', width: 14 },
      { header: 'Exento', key: 'exemptAmount', width: 14 },
      { header: 'Otros Trib.', key: 'otherTaxesAmount', width: 14 },
      { header: 'Total', key: 'totalAmount', width: 16 },
      { header: 'Estado', key: 'status', width: 20 },
      { header: 'Estado Pago', key: 'paymentStatus', width: 18 },
      { header: 'Fecha Pago', key: 'paidAt', width: 14 },
      { header: 'Ref. Pago', key: 'paymentReference', width: 18 },
      { header: 'O.C. / Ref.', key: 'purchaseOrderNumber', width: 18 },
      { header: 'CAE', key: 'cae', width: 18 },
      { header: 'Origen', key: 'source', width: 15 },
      { header: 'Archivo', key: 'originalName', width: 28 },
      { header: 'Alertas Fiscales', key: 'warnings', width: 34 },
    ];

    sheet.columns = headers.map((h) => ({ key: h.key, width: h.width }));
    const headerRow = sheet.getRow(4);
    headerRow.values = headers.map((h) => h.header);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F46E5' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
    headerRow.height = 22;

    const matrix = this.buildRowsMatrix(docs);
    matrix.forEach((row) => {
      const added = sheet.addRow(row);
      ['netAmount', 'taxAmount', 'exemptAmount', 'otherTaxesAmount', 'totalAmount'].forEach(
        (key) => {
          const cell = added.getCell(key);
          if (typeof cell.value === 'number') {
            cell.numFmt = '#,##0.00';
          }
        },
      );
      if (row.warnings) {
        added.getCell('warnings').font = { color: { argb: 'FFB91C1C' }, bold: true };
      }
    });

    sheet.autoFilter = {
      from: 'A4',
      to: `Z${Math.max(4, 4 + matrix.length)}`,
    };

    // Hoja 2: Resumen por Moneda y Tipo
    const summarySheet = workbook.addWorksheet('Resumen');
    summarySheet.columns = [
      { header: 'Moneda', key: 'currency', width: 12 },
      { header: 'Cantidad', key: 'count', width: 12 },
      { header: 'Total Neto', key: 'net', width: 18 },
      { header: 'Total IVA', key: 'tax', width: 18 },
      { header: 'Total Exento', key: 'exempt', width: 18 },
      { header: 'Total Otros Trib.', key: 'other', width: 18 },
      { header: 'Importe Total', key: 'total', width: 20 },
    ];
    const sumHeader = summarySheet.getRow(1);
    sumHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sumHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };

    const currencyTotals = this.computeCurrencyTotals(docs);
    for (const item of currencyTotals) {
      const r = summarySheet.addRow(item);
      ['net', 'tax', 'exempt', 'other', 'total'].forEach((k) => {
        r.getCell(k).numFmt = '#,##0.00';
      });
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async buildPdfBuffer(
    docs: Document[],
    companyName: string,
    query: ExportDocumentsQueryDto,
  ): Promise<Buffer> {
    this.ensurePdfFonts();

    const rows = this.buildRowsMatrix(docs);
    const currencyTotals = this.computeCurrencyTotals(docs);

    const tableBody: any[] = [
      [
        { text: 'Fecha', style: 'tableHeader' },
        { text: 'Tipo / N°', style: 'tableHeader' },
        { text: 'Emisor / CUIT', style: 'tableHeader' },
        { text: 'Cliente', style: 'tableHeader' },
        { text: 'Estado / Pago', style: 'tableHeader' },
        { text: 'Neto', style: 'tableHeaderNum' },
        { text: 'IVA', style: 'tableHeaderNum' },
        { text: 'Total', style: 'tableHeaderNum' },
      ],
    ];

    rows.forEach((r, idx) => {
      const fill = idx % 2 === 1 ? '#F8FAFC' : undefined;
      const tipoNumero = [
        `${r.documentType}${r.documentLetter ? ` ${r.documentLetter}` : ''}`,
        r.documentNumber || r.originalName,
      ]
        .filter(Boolean)
        .join('\n');
      const emisorInfo = [r.issuerName || '—', r.issuerTaxId ? `CUIT: ${r.issuerTaxId}` : '']
        .filter(Boolean)
        .join('\n');
      const estadoInfo = `${r.status}\n${r.paymentStatus}${r.dueDate ? ` (Vto: ${r.dueDate})` : ''}`;

      tableBody.push([
        { text: r.documentDate || '—', style: 'cell', fillColor: fill },
        { text: tipoNumero, style: 'cell', fillColor: fill },
        { text: emisorInfo, style: 'cell', fillColor: fill },
        { text: r.recipientName || '—', style: 'cell', fillColor: fill },
        { text: estadoInfo, style: 'cell', fillColor: fill },
        {
          text: formatMoneyDisplay(r.netAmount, r.currency),
          style: 'cellNum',
          fillColor: fill,
        },
        {
          text: formatMoneyDisplay(r.taxAmount, r.currency),
          style: 'cellNum',
          fillColor: fill,
        },
        {
          text: formatMoneyDisplay(r.totalAmount, r.currency),
          style: 'cellNumBold',
          fillColor: fill,
        },
      ]);
    });

    const summaryLines = currencyTotals.map((t) => ({
      text: `${t.currency} (${t.count} comp.): Neto ${formatMoneyDisplay(t.net, t.currency)} | IVA ${formatMoneyDisplay(t.tax, t.currency)} | Total ${formatMoneyDisplay(t.total, t.currency)}`,
      margin: [0, 2, 0, 2],
      fontSize: 9,
      bold: true,
    }));

    const docDefinition: any = {
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [24, 34, 24, 34],
      defaultStyle: {
        font: 'Roboto',
        fontSize: 8,
        color: '#0F172A',
      },
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          {
            text: `Helpscan · ${companyName} · Exportación administrativa`,
            fontSize: 7.5,
            color: '#64748B',
            margin: [24, 8, 0, 0],
          },
          {
            text: `Página ${currentPage} de ${pageCount}`,
            alignment: 'right',
            fontSize: 7.5,
            color: '#64748B',
            margin: [0, 8, 24, 0],
          },
        ],
      }),
      content: [
        {
          columns: [
            {
              stack: [
                { text: 'REPORTE DE COMPROBANTES', fontSize: 14, bold: true, color: '#312E81' },
                { text: companyName, fontSize: 10, bold: true, margin: [0, 2, 0, 0] },
              ],
            },
            {
              alignment: 'right',
              stack: [
                { text: `Generado: ${new Date().toLocaleString('es-AR')}`, fontSize: 8.5 },
                { text: `Total registros: ${docs.length}`, fontSize: 8.5, bold: true },
              ],
            },
          ],
          margin: [0, 0, 0, 6],
        },
        {
          text: this.describeActiveFilters(query),
          fontSize: 8,
          color: '#475569',
          italics: true,
          margin: [0, 0, 0, 10],
        },
        docs.length > 0
          ? {
              table: {
                headerRows: 1,
                widths: [52, 95, 130, 95, 110, 68, 62, 74],
                body: tableBody,
              },
              layout: {
                hLineColor: () => '#CBD5E1',
                vLineColor: () => '#E2E8F0',
                paddingTop: () => 4,
                paddingBottom: () => 4,
              },
            }
          : {
              text: 'No se encontraron comprobantes con los filtros seleccionados.',
              fontSize: 10,
              italics: true,
              margin: [0, 20, 0, 20],
            },
        summaryLines.length > 0
          ? {
              margin: [0, 12, 0, 0],
              stack: [
                { text: 'Totales acumulados del listado:', fontSize: 9.5, bold: true, color: '#312E81', margin: [0, 0, 0, 4] },
                ...summaryLines,
              ],
            }
          : {},
      ],
      styles: {
        tableHeader: {
          bold: true,
          fontSize: 8,
          color: '#FFFFFF',
          fillColor: '#4338CA',
        },
        tableHeaderNum: {
          bold: true,
          fontSize: 8,
          color: '#FFFFFF',
          fillColor: '#4338CA',
          alignment: 'right',
        },
        cell: { fontSize: 7.5 },
        cellNum: { fontSize: 7.5, alignment: 'right' },
        cellNumBold: { fontSize: 7.5, alignment: 'right', bold: true },
      },
    };

    const created = pdfmake.createPdf(docDefinition);
    return created.getBuffer();
  }

  private async streamZipResponse(
    docs: Document[],
    companyId: number,
    baseName: string,
    res: Response,
  ): Promise<void> {
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${baseName}.zip"`,
    });

    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: any) => {
      this.logger.error(`Error generando ZIP de comprobantes: ${err?.message}`);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    const csvSummary = this.buildCsvString(docs);
    archive.append(Buffer.from(csvSummary, 'utf8'), {
      name: '_resumen_comprobantes.csv',
    });

    const missingFiles: string[] = [];
    const usedNames = new Set<string>();

    for (const doc of docs) {
      const fullPath = resolveSafeStorageFilePath(
        doc.filePath,
        doc.companyId,
        doc.fileName,
      );

      if (!existsSync(fullPath)) {
        missingFiles.push(`#${doc.id} - ${doc.originalName} (no encontrado en bóveda)`);
        continue;
      }

      try {
        const plainBuffer = readDecryptedVaultFile(fullPath, companyId);
        const datePart = doc.documentDate || doc.createdAt?.toISOString().slice(0, 10) || 'sin_fecha';
        const typePart = sanitizeFileSegment(doc.documentType || 'doc', 20) || 'doc';
        const numPart = sanitizeFileSegment(doc.documentNumber, 24);
        const issuerPart = sanitizeFileSegment(doc.issuerName, 26);

        let entryName = [datePart, typePart, numPart, issuerPart, `id${doc.id}`]
          .filter(Boolean)
          .join('_');
        entryName = `${entryName}.pdf`;

        if (usedNames.has(entryName)) {
          entryName = `${doc.id}_${entryName}`;
        }
        usedNames.add(entryName);

        archive.append(plainBuffer, { name: entryName });
      } catch (err: any) {
        missingFiles.push(`#${doc.id} - ${doc.originalName} (${err?.message})`);
      }
    }

    if (missingFiles.length > 0) {
      archive.append(
        Buffer.from(
          `Archivos omitidos durante la exportación:\r\n${missingFiles.join('\r\n')}`,
          'utf8',
        ),
        { name: '_archivos_omitidos.txt' },
      );
    }

    await archive.finalize();
  }

  private computeCurrencyTotals(docs: Document[]) {
    const map = new Map<
      string,
      {
        currency: string;
        count: number;
        net: number;
        tax: number;
        exempt: number;
        other: number;
        total: number;
      }
    >();

    for (const doc of docs) {
      const curr = (doc.currency || 'ARS').toUpperCase();
      const entry = map.get(curr) || {
        currency: curr,
        count: 0,
        net: 0,
        tax: 0,
        exempt: 0,
        other: 0,
        total: 0,
      };
      entry.count++;
      entry.net += formatMoney(doc.netAmount) || 0;
      entry.tax += formatMoney(doc.taxAmount) || 0;
      entry.exempt += formatMoney(doc.exemptAmount) || 0;
      entry.other += formatMoney(doc.otherTaxesAmount) || 0;
      entry.total += formatMoney(doc.totalAmount) || 0;
      map.set(curr, entry);
    }

    return Array.from(map.values());
  }

  private describeActiveFilters(query: ExportDocumentsQueryDto): string {
    const parts: string[] = [];
    if (query.search) parts.push(`Búsqueda: "${query.search}"`);
    if (query.documentType) parts.push(`Tipo: ${query.documentType}`);
    if (query.status) parts.push(`Estado: ${query.status}`);
    if (query.paymentStatus) {
      parts.push(`Pago: ${PAYMENT_STATUS_LABELS[query.paymentStatus] || query.paymentStatus}`);
    }
    if (query.dueFilter === 'OVERDUE') parts.push('Vencimiento: Vencidos');
    if (query.dueFilter === 'DUE_SOON') parts.push('Vencimiento: Próximos 5 días');
    if (query.source) parts.push(`Origen: ${SOURCE_LABELS[query.source] || query.source}`);
    if (query.dateFrom || query.dateTo) {
      parts.push(`Período: ${query.dateFrom || '...'} a ${query.dateTo || '...'}`);
    }
    if (query.ids) parts.push('Selección manual de filas');

    return parts.length > 0 ? `Filtros aplicados: ${parts.join(' · ')}` : 'Filtros: Todos los comprobantes';
  }
}
