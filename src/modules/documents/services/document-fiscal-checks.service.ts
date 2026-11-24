import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  Document,
  DocumentStatus,
  DocumentValidationWarning,
} from '../document.model';
import {
  buildDocumentValidationWarnings,
  DuplicateDocumentCandidate,
  FiscalCheckInput,
  normalizeFiscalNumberKey,
  normalizeTaxIdDigits,
} from '../helpers/document-fiscal-checks.helper';

export interface FiscalEvaluationResult {
  duplicateOfDocumentId: number | null;
  validationWarnings: DocumentValidationWarning[];
}

/**
 * Evalúa duplicados fiscales y consistencia matemática/CUIT de un comprobante dentro de su compañía.
 */
@Injectable()
export class DocumentFiscalChecksService {
  constructor(
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
  ) {}

  async evaluateDocument(
    companyId: number,
    input: FiscalCheckInput,
    excludeDocumentId?: number | null,
  ): Promise<FiscalEvaluationResult> {
    const duplicateMatch = await this.findFiscalDuplicate(
      companyId,
      input,
      excludeDocumentId,
    );
    const validationWarnings = buildDocumentValidationWarnings(
      input,
      duplicateMatch,
    );

    return {
      duplicateOfDocumentId: duplicateMatch?.id ?? null,
      validationWarnings,
    };
  }

  private async findFiscalDuplicate(
    companyId: number,
    input: FiscalCheckInput,
    excludeDocumentId?: number | null,
  ): Promise<DuplicateDocumentCandidate | null> {
    const taxDigits = normalizeTaxIdDigits(input.issuerTaxId);
    const targetNumberKey = normalizeFiscalNumberKey(
      input.documentNumber,
      input.pointOfSale,
    );

    // Sin CUIT emisor y número de comprobante normalizable no declaramos duplicado fiscal
    if (taxDigits.length < 7 || !targetNumberKey) {
      return null;
    }

    const where: any = {
      companyId,
      status: { [Op.ne]: DocumentStatus.REJECTED },
      issuerTaxId: { [Op.ne]: null },
      documentNumber: { [Op.ne]: null },
    };
    if (excludeDocumentId) {
      where.id = { [Op.ne]: excludeDocumentId };
    }

    const candidates = await this.documentModel.findAll({
      where,
      attributes: [
        'id',
        'originalName',
        'issuerTaxId',
        'documentNumber',
        'pointOfSale',
        'documentType',
        'documentLetter',
      ],
      order: [['id', 'ASC']],
      limit: 250,
    });

    const targetType = this.normalizeDocTypeFamily(input.documentType);
    const targetLetter = String(input.documentLetter || '').trim().toUpperCase();

    for (const candidate of candidates) {
      const candidateTaxDigits = normalizeTaxIdDigits(candidate.issuerTaxId);
      if (candidateTaxDigits !== taxDigits) continue;

      const candidateNumberKey = normalizeFiscalNumberKey(
        candidate.documentNumber,
        candidate.pointOfSale,
      );
      if (!candidateNumberKey || candidateNumberKey !== targetNumberKey) continue;

      const candidateType = this.normalizeDocTypeFamily(candidate.documentType);
      if (targetType && candidateType && targetType !== candidateType) continue;

      const candidateLetter = String(candidate.documentLetter || '').trim().toUpperCase();
      if (targetLetter && candidateLetter && targetLetter !== candidateLetter) continue;

      return {
        id: candidate.id,
        originalName: candidate.originalName,
        documentNumber: candidate.documentNumber,
      };
    }

    return null;
  }

  private normalizeDocTypeFamily(documentType?: string | null): string {
    const clean = String(documentType || '').toLowerCase().trim();
    if (!clean) return '';
    if (clean.startsWith('factura')) return 'factura';
    return clean;
  }
}
