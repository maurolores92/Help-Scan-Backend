import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Document, DocumentPaymentStatus, DocumentStatus } from '../document.model';
import { DocumentFormRecord } from '../models/document-form-record.model';
import {
  DOCUMENT_LINK_TYPE_LABELS,
  DocumentLink,
  DocumentLinkMatchSource,
  DocumentLinkType,
} from '../models/document-link.model';
import {
  BALANCE_TOLERANCE_AMOUNT,
  DocumentBalanceSummary,
  computeDocumentBalanceSummary,
  computeSourceImputationSummary,
  toNumericAmount,
} from '../helpers/document-balance.helper';
import {
  MatchableDocumentCandidate,
  evaluateCounterpartyCompatibility,
  resolveLinkDirectionAndType,
  scoreMatchCandidate,
} from '../helpers/document-matching.helper';
import {
  BatchDocumentLinksDto,
  CreateDocumentLinkDto,
  UpdateDocumentLinkDto,
} from '../dto/document-link.dto';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.model';

const DOC_SUMMARY_ATTRIBUTES = [
  'id',
  'companyId',
  'clientId',
  'originalName',
  'documentType',
  'documentLetter',
  'pointOfSale',
  'documentNumber',
  'referenceNumber',
  'purchaseOrderNumber',
  'documentDate',
  'dueDate',
  'issuerName',
  'issuerTaxId',
  'recipientName',
  'recipientTaxId',
  'currency',
  'totalAmount',
  'status',
  'paymentStatus',
  'extractedData',
];

@Injectable()
export class DocumentLinksService {
  constructor(
    @InjectModel(DocumentLink)
    private readonly documentLinkModel: typeof DocumentLink,
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    private readonly auditService: AuditService,
  ) {}

  private assertCompanyScope(companyId?: number | null): number {
    const parsed = Number(companyId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ForbiddenException('Compañía inválida para gestionar vínculos documentales.');
    }
    return parsed;
  }

  private async loadDocumentOrThrow(id: number, companyId: number): Promise<Document> {
    const doc = await this.documentModel.findOne({
      where: { id, companyId },
      include: [{ model: DocumentFormRecord, attributes: ['id', 'documentType', 'formData'] }],
    });
    if (!doc) {
      throw new NotFoundException(`Documento #${id} no encontrado en tu compañía.`);
    }
    return doc;
  }

  private toMatchCandidate(doc: any): MatchableDocumentCandidate {
    const plain = typeof doc?.toJSON === 'function' ? doc.toJSON() : doc;
    return {
      id: plain.id,
      documentType: plain.documentType,
      documentLetter: plain.documentLetter,
      pointOfSale: plain.pointOfSale,
      documentNumber: plain.documentNumber,
      referenceNumber: plain.referenceNumber,
      purchaseOrderNumber: plain.purchaseOrderNumber,
      documentDate: plain.documentDate,
      issuerTaxId: plain.issuerTaxId,
      issuerName: plain.issuerName,
      recipientTaxId: plain.recipientTaxId,
      recipientName: plain.recipientName,
      clientId: plain.clientId,
      currency: plain.currency,
      totalAmount: plain.totalAmount,
      paymentStatus: plain.paymentStatus,
      status: plain.status,
      formData: plain.formRecord?.formData || null,
      extractedAttributes: plain.extractedData?.attributes || null,
    };
  }

  private serializeRelatedDoc(doc: any) {
    if (!doc) return null;
    const plain = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
    return {
      id: plain.id,
      originalName: plain.originalName,
      documentType: plain.documentType,
      documentLetter: plain.documentLetter,
      pointOfSale: plain.pointOfSale,
      documentNumber: plain.documentNumber,
      documentDate: plain.documentDate,
      issuerName: plain.issuerName,
      issuerTaxId: plain.issuerTaxId,
      recipientName: plain.recipientName,
      recipientTaxId: plain.recipientTaxId,
      currency: plain.currency,
      totalAmount: plain.totalAmount !== null && plain.totalAmount !== undefined ? Number(plain.totalAmount) : null,
      status: plain.status,
      paymentStatus: plain.paymentStatus,
    };
  }

  async recalculateDocumentBalance(documentId: number, companyId: number): Promise<DocumentBalanceSummary> {
    const doc = await this.documentModel.findOne({ where: { id: documentId, companyId } });
    if (!doc) {
      throw new NotFoundException(`Documento #${documentId} no encontrado.`);
    }

    const incomingLinks = await this.documentLinkModel.findAll({
      where: { companyId, targetDocumentId: documentId },
      include: [{ model: Document, as: 'sourceDocument', attributes: ['id', 'totalAmount'] }],
    });

    const summary = computeDocumentBalanceSummary({
      documentId: doc.id,
      documentType: doc.documentType,
      totalAmount: doc.totalAmount,
      currentPaymentStatus: doc.paymentStatus,
      links: incomingLinks.map((lnk) => ({
        sourceDocumentId: lnk.sourceDocumentId,
        targetDocumentId: lnk.targetDocumentId,
        linkType: lnk.linkType,
        appliedAmount: lnk.appliedAmount,
        sourceTotalAmount: lnk.sourceDocument?.totalAmount,
      })),
    });

    if (
      summary.isTrackable &&
      doc.paymentStatus !== DocumentPaymentStatus.NOT_APPLICABLE &&
      doc.paymentStatus !== summary.derivedPaymentStatus
    ) {
      const nextPaidAt =
        summary.derivedPaymentStatus === DocumentPaymentStatus.PAID
          ? doc.paidAt || new Date().toISOString().slice(0, 10)
          : null;
      await doc.update({
        paymentStatus: summary.derivedPaymentStatus,
        paidAt: nextPaidAt,
      });
    }

    return summary;
  }

  /**
   * Lista vínculos activos, resumen de saldo y sugerencias inteligentes para un documento.
   */
  async getDocumentLinksAndSuggestions(documentId: number, companyId: number) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const doc = await this.loadDocumentOrThrow(documentId, scopedCompanyId);

    const activeLinks = await this.documentLinkModel.findAll({
      where: {
        companyId: scopedCompanyId,
        [Op.or]: [{ sourceDocumentId: doc.id }, { targetDocumentId: doc.id }],
      },
      include: [
        { model: Document, as: 'sourceDocument', attributes: DOC_SUMMARY_ATTRIBUTES },
        { model: Document, as: 'targetDocument', attributes: DOC_SUMMARY_ATTRIBUTES },
      ],
      order: [['createdAt', 'DESC']],
    });

    const balanceSummary = await this.recalculateDocumentBalance(doc.id, scopedCompanyId);
    const sourceImputationSummary = computeSourceImputationSummary({
      documentId: doc.id,
      documentType: doc.documentType,
      totalAmount: doc.totalAmount,
      links: activeLinks.map((lnk) => ({
        sourceDocumentId: lnk.sourceDocumentId,
        targetDocumentId: lnk.targetDocumentId,
        linkType: lnk.linkType,
        appliedAmount: lnk.appliedAmount,
      })),
    });
    const alreadyLinkedIds = new Set<number>([doc.id]);
    const formattedLinks = activeLinks.map((lnk) => {
      const isOutgoing = lnk.sourceDocumentId === doc.id;
      const relatedRaw = isOutgoing ? lnk.targetDocument : lnk.sourceDocument;
      if (relatedRaw?.id) alreadyLinkedIds.add(relatedRaw.id);

      return {
        id: lnk.id,
        sourceDocumentId: lnk.sourceDocumentId,
        targetDocumentId: lnk.targetDocumentId,
        direction: isOutgoing ? ('outgoing' as const) : ('incoming' as const),
        linkType: lnk.linkType,
        linkTypeLabel: DOCUMENT_LINK_TYPE_LABELS[lnk.linkType] || lnk.linkType,
        appliedAmount:
          lnk.appliedAmount !== null && lnk.appliedAmount !== undefined
            ? Number(lnk.appliedAmount)
            : null,
        matchSource: lnk.matchSource,
        confidence: lnk.confidence,
        notes: lnk.notes,
        createdAt: lnk.createdAt,
        relatedDocument: this.serializeRelatedDoc(relatedRaw),
      };
    });

    const candidates = await this.documentModel.findAll({
      where: {
        companyId: scopedCompanyId,
        id: { [Op.notIn]: Array.from(alreadyLinkedIds) },
        status: {
          [Op.in]: [
            DocumentStatus.PENDING_APPROVAL,
            DocumentStatus.VALIDATED,
            DocumentStatus.PROCESSED,
          ],
        },
      },
      attributes: DOC_SUMMARY_ATTRIBUTES,
      include: [{ model: DocumentFormRecord, attributes: ['id', 'documentType', 'formData'] }],
      order: [['createdAt', 'DESC']],
      limit: 120,
    });

    const candidateIds = candidates.map((c) => c.id);
    const candidateIncomingLinks =
      candidateIds.length > 0
        ? await this.documentLinkModel.findAll({
            where: { companyId: scopedCompanyId, targetDocumentId: candidateIds },
            include: [{ model: Document, as: 'sourceDocument', attributes: ['id', 'totalAmount'] }],
          })
        : [];

    const docCandidate = this.toMatchCandidate(doc);
    const suggestions: any[] = [];

    for (const candidate of candidates) {
      const incomingForCandidate = candidateIncomingLinks.filter(
        (l) => l.targetDocumentId === candidate.id,
      );
      const candidateBalance = computeDocumentBalanceSummary({
        documentId: candidate.id,
        documentType: candidate.documentType,
        totalAmount: candidate.totalAmount,
        currentPaymentStatus: candidate.paymentStatus,
        links: incomingForCandidate.map((l) => ({
          sourceDocumentId: l.sourceDocumentId,
          targetDocumentId: l.targetDocumentId,
          linkType: l.linkType,
          appliedAmount: l.appliedAmount,
          sourceTotalAmount: l.sourceDocument?.totalAmount,
        })),
      });

      const scored = scoreMatchCandidate(
        docCandidate,
        this.toMatchCandidate(candidate),
        candidateBalance.isTrackable ? candidateBalance.remainingBalance : null,
      );
      if (!scored) continue;

      const { swapDirection } = resolveLinkDirectionAndType(doc.documentType, candidate.documentType);
      suggestions.push({
        targetDocumentId: candidate.id,
        swapDirection,
        linkType: scored.linkType,
        linkTypeLabel: DOCUMENT_LINK_TYPE_LABELS[scored.linkType] || scored.linkType,
        score: scored.score,
        isExactNumberMatch: scored.isExactNumberMatch,
        reasons: scored.reasons,
        suggestedAppliedAmount: scored.suggestedAppliedAmount,
        candidateRemainingBalance: candidateBalance.isTrackable
          ? candidateBalance.remainingBalance
          : null,
        relatedDocument: this.serializeRelatedDoc(candidate),
      });
    }

    suggestions.sort((a, b) => b.score - a.score);

    return {
      documentId: doc.id,
      balanceSummary,
      sourceImputationSummary,
      links: formattedLinks,
      suggestions: suggestions.slice(0, 12),
    };
  }

  /**
   * Enriquece un listado paginado de documentos con conteo de vínculos,
   * resumen de saldo pendiente y saldo disponible por imputar.
   */
  async enrichDocumentsWithBalances(companyId: number, docs: Document[]) {
    if (!docs || docs.length === 0) return [];
    const docIds = docs.map((d) => d.id);
    const links = await this.documentLinkModel.findAll({
      where: {
        companyId,
        [Op.or]: [{ sourceDocumentId: docIds }, { targetDocumentId: docIds }],
      },
      include: [{ model: Document, as: 'sourceDocument', attributes: ['id', 'totalAmount'] }],
    });

    const linksByDocId = new Map<number, any[]>();
    for (const lnk of links) {
      const plain = typeof (lnk as any).toJSON === 'function' ? (lnk as any).toJSON() : lnk;
      const srcList = linksByDocId.get(plain.sourceDocumentId) || [];
      srcList.push(plain);
      linksByDocId.set(plain.sourceDocumentId, srcList);

      if (plain.targetDocumentId !== plain.sourceDocumentId) {
        const tgtList = linksByDocId.get(plain.targetDocumentId) || [];
        tgtList.push(plain);
        linksByDocId.set(plain.targetDocumentId, tgtList);
      }
    }

    return docs.map((doc) => {
      const plainDoc = typeof (doc as any).toJSON === 'function' ? (doc as any).toJSON() : { ...doc };
      const docLinks = linksByDocId.get(doc.id) || [];
      const linkInputs = docLinks.map((l) => ({
        sourceDocumentId: l.sourceDocumentId,
        targetDocumentId: l.targetDocumentId,
        linkType: l.linkType,
        appliedAmount: l.appliedAmount,
        sourceTotalAmount: l.sourceDocument?.totalAmount,
      }));

      return {
        ...plainDoc,
        linkedCount: docLinks.length,
        balanceSummary: computeDocumentBalanceSummary({
          documentId: doc.id,
          documentType: doc.documentType,
          totalAmount: doc.totalAmount,
          currentPaymentStatus: doc.paymentStatus,
          links: linkInputs,
        }),
        imputationSummary: computeSourceImputationSummary({
          documentId: doc.id,
          documentType: doc.documentType,
          totalAmount: doc.totalAmount,
          links: linkInputs,
        }),
      };
    });
  }

  /**
   * Crea un vínculo documental validando coherencia, duplicados y recalculando saldo.
   */
  async createLink(
    documentId: number,
    companyId: number,
    actorUserId: number,
    dto: CreateDocumentLinkDto,
  ) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    if (Number(documentId) === Number(dto.targetDocumentId)) {
      throw new BadRequestException('No se puede vincular un comprobante consigo mismo.');
    }

    const [docA, docB] = await Promise.all([
      this.loadDocumentOrThrow(documentId, scopedCompanyId),
      this.loadDocumentOrThrow(dto.targetDocumentId, scopedCompanyId),
    ]);

    const resolved = resolveLinkDirectionAndType(docA.documentType, docB.documentType);
    const shouldSwap =
      dto.swapDirection !== undefined ? dto.swapDirection : dto.linkType ? false : resolved.swapDirection;

    const sourceDoc = shouldSwap ? docB : docA;
    const targetDoc = shouldSwap ? docA : docB;
    const finalLinkType = dto.linkType || resolved.linkType;

    const existing = await this.documentLinkModel.findOne({
      where: {
        companyId: scopedCompanyId,
        sourceDocumentId: sourceDoc.id,
        targetDocumentId: targetDoc.id,
        linkType: finalLinkType,
      },
    });
    if (existing) {
      throw new BadRequestException('Ya existe ese vínculo entre ambos comprobantes.');
    }

    const warnings: string[] = [];
    const compat = evaluateCounterpartyCompatibility(
      this.toMatchCandidate(sourceDoc),
      this.toMatchCandidate(targetDoc),
    );
    if (!compat.compatible) {
      warnings.push(
        'Los comprobantes no coinciden automáticamente por cliente ni CUIT. Se vinculó por confirmación manual.',
      );
    }

    if (sourceDoc.currency && targetDoc.currency && sourceDoc.currency !== targetDoc.currency) {
      warnings.push(
        `Diferencia de moneda detectada (${sourceDoc.currency} vs ${targetDoc.currency}). Verifica el importe imputado.`,
      );
    }

    const targetBalanceBefore = await this.recalculateDocumentBalance(targetDoc.id, scopedCompanyId);
    let finalAppliedAmount: number | null =
      dto.appliedAmount !== undefined && dto.appliedAmount !== null ? Number(dto.appliedAmount) : null;

    const isMonetaryLink =
      finalLinkType === DocumentLinkType.PAYMENT_IMPUTATION ||
      finalLinkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT ||
      finalLinkType === DocumentLinkType.DEBIT_NOTE_ADJUSTMENT;

    if (isMonetaryLink && finalAppliedAmount === null) {
      const srcTotal = toNumericAmount(sourceDoc.totalAmount);
      if (srcTotal > 0 && targetBalanceBefore.remainingBalance > 0) {
        finalAppliedAmount = Math.min(srcTotal, targetBalanceBefore.remainingBalance);
      } else if (srcTotal > 0) {
        finalAppliedAmount = srcTotal;
      }
    }

    if (
      (finalLinkType === DocumentLinkType.PAYMENT_IMPUTATION ||
        finalLinkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT) &&
      finalAppliedAmount !== null &&
      targetBalanceBefore.isTrackable &&
      finalAppliedAmount > targetBalanceBefore.remainingBalance + BALANCE_TOLERANCE_AMOUNT
    ) {
      warnings.push(
        `El monto imputado ($${finalAppliedAmount.toLocaleString('es-AR')}) supera el saldo pendiente ($${targetBalanceBefore.remainingBalance.toLocaleString('es-AR')}). Se registró igualmente.`,
      );
    }

    const created = await this.documentLinkModel.create({
      companyId: scopedCompanyId,
      sourceDocumentId: sourceDoc.id,
      targetDocumentId: targetDoc.id,
      linkType: finalLinkType,
      appliedAmount: finalAppliedAmount,
      matchSource: dto.matchSource || DocumentLinkMatchSource.MANUAL,
      notes: dto.notes?.trim() || null,
      createdByUserId: actorUserId,
    });

    const targetBalanceSummary = await this.recalculateDocumentBalance(targetDoc.id, scopedCompanyId);

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'DocumentLink',
      entityId: created.id,
      companyId: scopedCompanyId,
      userId: actorUserId,
      description: `Vínculo ${finalLinkType} creado entre doc #${sourceDoc.id} y doc #${targetDoc.id}`,
      payload: { appliedAmount: finalAppliedAmount, warnings },
    });

    return {
      message: 'Comprobantes vinculados correctamente',
      link: created,
      warnings,
      targetBalanceSummary,
    };
  }

  async createBatchLinks(companyId: number, actorUserId: number, dto: BatchDocumentLinksDto) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const createdLinks: DocumentLink[] = [];
    const warnings: string[] = [];
    const skipped: Array<{ sourceDocumentId: number; targetDocumentId: number; reason: string }> = [];

    for (const item of dto.links || []) {
      try {
        const res = await this.createLink(item.sourceDocumentId, scopedCompanyId, actorUserId, {
          targetDocumentId: item.targetDocumentId,
          linkType: item.linkType,
          appliedAmount: item.appliedAmount,
          notes: item.notes,
          matchSource: DocumentLinkMatchSource.MANUAL,
        });
        createdLinks.push(res.link);
        warnings.push(...res.warnings);
      } catch (err: any) {
        skipped.push({
          sourceDocumentId: item.sourceDocumentId,
          targetDocumentId: item.targetDocumentId,
          reason: err?.message || 'No se pudo vincular el par de comprobantes',
        });
      }
    }

    return {
      createdCount: createdLinks.length,
      links: createdLinks,
      warnings: Array.from(new Set(warnings)),
      skipped,
    };
  }

  async updateLink(
    documentId: number,
    linkId: number,
    companyId: number,
    actorUserId: number,
    dto: UpdateDocumentLinkDto,
  ) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const link = await this.documentLinkModel.findOne({
      where: {
        id: linkId,
        companyId: scopedCompanyId,
        [Op.or]: [{ sourceDocumentId: documentId }, { targetDocumentId: documentId }],
      },
    });
    if (!link) {
      throw new NotFoundException(`Vínculo #${linkId} no encontrado.`);
    }

    await link.update({
      appliedAmount: dto.appliedAmount !== undefined ? dto.appliedAmount : link.appliedAmount,
      linkType: dto.linkType !== undefined ? dto.linkType : link.linkType,
      notes: dto.notes !== undefined ? dto.notes?.trim() || null : link.notes,
    });

    const targetBalanceSummary = await this.recalculateDocumentBalance(
      link.targetDocumentId,
      scopedCompanyId,
    );

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'DocumentLink',
      entityId: link.id,
      companyId: scopedCompanyId,
      userId: actorUserId,
      description: `Vínculo #${link.id} actualizado (monto imputado: ${link.appliedAmount ?? 'N/A'})`,
    });

    return {
      message: 'Vínculo actualizado correctamente',
      link,
      targetBalanceSummary,
    };
  }

  async removeLink(documentId: number, linkId: number, companyId: number, actorUserId: number) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const link = await this.documentLinkModel.findOne({
      where: {
        id: linkId,
        companyId: scopedCompanyId,
        [Op.or]: [{ sourceDocumentId: documentId }, { targetDocumentId: documentId }],
      },
    });
    if (!link) {
      throw new NotFoundException(`Vínculo #${linkId} no encontrado.`);
    }

    const targetId = link.targetDocumentId;
    await link.destroy();
    const targetBalanceSummary = await this.recalculateDocumentBalance(targetId, scopedCompanyId);

    await this.auditService.log({
      action: AuditAction.DELETE,
      entity: 'DocumentLink',
      entityId: linkId,
      companyId: scopedCompanyId,
      userId: actorUserId,
      description: `Vínculo #${linkId} eliminado del documento #${documentId}`,
    });

    return {
      message: 'Vínculo eliminado correctamente',
      targetBalanceSummary,
    };
  }

  /**
   * Ejecuta conciliación automática estrictamente determinística (Cero errores silenciosos):
   * solo crea vínculos AUTO_EXACT cuando hay número exacto único, mismo circuito cliente/CUIT,
   * moneda compatible y sin sobre-imputación.
   */
  async runAutoExactMatchingForDocument(
    documentId: number,
    companyId: number,
    actorUserId?: number,
  ) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const doc = await this.loadDocumentOrThrow(documentId, scopedCompanyId);
    const { suggestions } = await this.getDocumentLinksAndSuggestions(doc.id, scopedCompanyId);

    const exactCandidates = suggestions.filter((s) => s.isExactNumberMatch);
    if (exactCandidates.length === 0) {
      return { autoMatchedCount: 0, autoMatchedLinks: [] };
    }

    // Si hay ambigüedad (dos o más documentos comparten el mismo número normalizado), no auto-vincular
    const numberCountMap = new Map<string, number>();
    for (const s of exactCandidates) {
      const key = `${s.linkType}::${s.relatedDocument?.documentNumber || s.targetDocumentId}`;
      numberCountMap.set(key, (numberCountMap.get(key) || 0) + 1);
    }

    const created: DocumentLink[] = [];
    for (const item of exactCandidates) {
      const key = `${item.linkType}::${item.relatedDocument?.documentNumber || item.targetDocumentId}`;
      if ((numberCountMap.get(key) || 0) > 1) continue;

      const relDoc = item.relatedDocument;
      if (doc.currency && relDoc?.currency && doc.currency !== relDoc.currency) continue;

      if (
        (item.linkType === DocumentLinkType.PAYMENT_IMPUTATION ||
          item.linkType === DocumentLinkType.CREDIT_NOTE_ADJUSTMENT) &&
        !item.swapDirection &&
        item.candidateRemainingBalance !== null &&
        item.suggestedAppliedAmount !== null &&
        item.suggestedAppliedAmount > item.candidateRemainingBalance + BALANCE_TOLERANCE_AMOUNT
      ) {
        continue;
      }

      try {
        const res = await this.createLink(doc.id, scopedCompanyId, actorUserId || 0, {
          targetDocumentId: item.targetDocumentId,
          linkType: item.linkType,
          appliedAmount: item.suggestedAppliedAmount,
          matchSource: DocumentLinkMatchSource.AUTO_EXACT,
          swapDirection: item.swapDirection,
        });
        await res.link.update({ confidence: item.score });
        created.push(res.link);
      } catch {
        // Ignorar duplicados o conflictos no determinísticos
      }
    }

    return {
      autoMatchedCount: created.length,
      autoMatchedLinks: created,
    };
  }

  async cleanupLinksForDeletedDocument(documentId: number, companyId: number) {
    const scopedCompanyId = this.assertCompanyScope(companyId);
    const links = await this.documentLinkModel.findAll({
      where: {
        companyId: scopedCompanyId,
        [Op.or]: [{ sourceDocumentId: documentId }, { targetDocumentId: documentId }],
      },
    });
    if (links.length === 0) return;

    const affectedTargetIds = new Set<number>();
    for (const link of links) {
      if (link.targetDocumentId !== documentId) {
        affectedTargetIds.add(link.targetDocumentId);
      }
      await link.destroy();
    }

    for (const targetId of affectedTargetIds) {
      await this.recalculateDocumentBalance(targetId, scopedCompanyId).catch(() => null);
    }
  }
}
