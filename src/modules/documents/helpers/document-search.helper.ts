import { ForbiddenException } from '@nestjs/common';
import { literal, Op, WhereOptions } from 'sequelize';
import { Document, DocumentPaymentStatus } from '../document.model';
import { QueryDocumentDto } from '../dto/query-document.dto';

/**
 * Construye condiciones de filtrado multitenant estricto por `companyId` y búsqueda universal profunda
 * en PostgreSQL abarcando columnas estructuradas, JSONB libre (`extracted_data`) y texto completo (`raw_text`).
 */
export const buildDocumentSearchWhere = (
  companyId: number,
  query: QueryDocumentDto,
): WhereOptions<Document> => {
  const scopedCompanyId = Number(companyId);
  if (!Number.isInteger(scopedCompanyId) || scopedCompanyId <= 0) {
    throw new ForbiddenException(
      'Acceso denegado: El filtro de compañía es obligatorio para consultar documentos.',
    );
  }

  const {
    search,
    status,
    paymentStatus,
    dueFilter,
    source,
    documentType,
    dateFrom,
    dateTo,
    purchaseOrderNumber,
    department,
    documentLetter,
    recipientTaxId,
    clientId,
    userId,
    minAmount,
    maxAmount,
  } = query;
  const andConditions: any[] = [{ companyId: scopedCompanyId }];
  const likeOp = Op.iLike ? Op.iLike : Op.like;

  if (status) {
    andConditions.push({ status });
  }

  if (clientId) {
    andConditions.push({ clientId });
  }

  if (userId) {
    andConditions.push({ userId });
  }

  if (paymentStatus) {
    andConditions.push({ paymentStatus });
  }

  if (dueFilter === 'OVERDUE' || dueFilter === 'DUE_SOON') {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    andConditions.push({
      paymentStatus: { [Op.in]: [DocumentPaymentStatus.PENDING, DocumentPaymentStatus.SCHEDULED] },
    });

    if (dueFilter === 'OVERDUE') {
      andConditions.push({ dueDate: { [Op.lt]: todayIso } });
    } else {
      const soon = new Date(today);
      soon.setDate(soon.getDate() + 5);
      const soonIso = soon.toISOString().slice(0, 10);
      andConditions.push({
        dueDate: { [Op.gte]: todayIso, [Op.lte]: soonIso },
      });
    }
  }

  if (source) {
    andConditions.push({ source });
  }

  if (documentType) {
    andConditions.push({ documentType: documentType.toLowerCase().trim() });
  }

  if (purchaseOrderNumber) {
    andConditions.push({ purchaseOrderNumber: { [likeOp]: `%${purchaseOrderNumber.trim()}%` } });
  }

  if (department) {
    andConditions.push({ department: { [likeOp]: `%${department.trim()}%` } });
  }

  if (documentLetter) {
    andConditions.push({ documentLetter: documentLetter.toUpperCase().trim() });
  }

  if (recipientTaxId) {
    andConditions.push({ recipientTaxId: { [likeOp]: `%${recipientTaxId.trim()}%` } });
  }

  if (minAmount !== undefined || maxAmount !== undefined) {
    const amountCondition: any = {};
    if (minAmount !== undefined) amountCondition[Op.gte] = minAmount;
    if (maxAmount !== undefined) amountCondition[Op.lte] = maxAmount;
    andConditions.push({ totalAmount: amountCondition });
  }

  if (dateFrom || dateTo) {
    const dateRange: Record<symbol, string> = {};
    if (dateFrom) dateRange[Op.gte] = dateFrom;
    if (dateTo) dateRange[Op.lte] = dateTo;
    andConditions.push({ documentDate: dateRange });
  }

  if (search && search.trim().length > 0) {
    const cleanTerm = search.trim();
    const wildcard = `%${cleanTerm}%`;
    const escapedLiteralTerm = cleanTerm.replace(/'/g, "''");

    const orClauses: any[] = [
      { originalName: { [likeOp]: wildcard } },
      { fileName: { [likeOp]: wildcard } },
      { fileHash: { [likeOp]: wildcard } },
      { documentType: { [likeOp]: wildcard } },
      { documentNumber: { [likeOp]: wildcard } },
      { issuerName: { [likeOp]: wildcard } },
      { issuerTaxId: { [likeOp]: wildcard } },
      { recipientName: { [likeOp]: wildcard } },
      { recipientTaxId: { [likeOp]: wildcard } },
      { deliveryAddress: { [likeOp]: wildcard } },
      { purchaseOrderNumber: { [likeOp]: wildcard } },
      { department: { [likeOp]: wildcard } },
      { carrierName: { [likeOp]: wildcard } },
      { referenceNumber: { [likeOp]: wildcard } },
      { cae: { [likeOp]: wildcard } },
      { responsiblePerson: { [likeOp]: wildcard } },
      { summary: { [likeOp]: wildcard } },
      { rawText: { [likeOp]: wildcard } },
      literal(`CAST("Document"."extracted_data" AS TEXT) ILIKE '%${escapedLiteralTerm}%'`),
      literal(`CAST("Document"."tags" AS TEXT) ILIKE '%${escapedLiteralTerm}%'`),
      literal(
        `to_tsvector('spanish', coalesce("Document"."raw_text", '') || ' ' || coalesce("Document"."summary", '')) @@ plainto_tsquery('spanish', '${escapedLiteralTerm}')`,
      ),
    ];

    andConditions.push({ [Op.or]: orClauses });
  }

  return { [Op.and]: andConditions };
};
