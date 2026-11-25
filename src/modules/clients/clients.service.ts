import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { col, fn, Op } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Client } from './client.model';
import { Document, DocumentStatus } from '../documents/document.model';
import { DocumentLink } from '../documents/models/document-link.model';
import {
  computeDocumentBalanceSummary,
  computeSourceImputationSummary,
} from '../documents/helpers/document-balance.helper';
import { computeClientAccountStatement } from './helpers/client-account-statement.helper';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.model';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { QueryClientDocumentsDto } from './dto/query-client-documents.dto';
import { normalizeTaxIdDigits } from '../documents/helpers/document-fiscal-checks.helper';
import {
  cleanClientString as cleanNullableString,
  ClientDocumentRole,
  evaluateClientRoleInDocument,
  normalizeClientNameKey,
  normalizeDocumentTypeBucket,
} from './helpers/client-document-matching.helper';

export { normalizeClientNameKey };

/**
 * Formatea dígitos de CUIT/CUIL de 11 dígitos como XX-XXXXXXXX-X para presentación uniforme.
 */
export function formatTaxIdDisplay(rawTaxId: string): string {
  const digits = normalizeTaxIdDigits(rawTaxId);
  if (digits.length === 11) {
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
  }
  return String(rawTaxId || '').trim();
}

export function inferTaxIdType(rawTaxId?: string | null): string | null {
  const digits = normalizeTaxIdDigits(rawTaxId);
  if (digits.length === 11) {
    const prefix = digits.slice(0, 2);
    if (['30', '33', '34'].includes(prefix)) return 'CUIT';
    if (['20', '23', '24', '27'].includes(prefix)) return 'CUIL';
    return 'CUIT';
  }
  if (digits.length >= 7 && digits.length <= 8) return 'DNI';
  return null;
}

const INVALID_PLACEHOLDER_NAMES = new Set([
  'no detectado',
  's/d',
  's/n',
  'n/a',
  'na',
  'desconocido',
  'sin especificar',
  '—',
  '-',
]);

function pickExtractedAttr(
  extractedData: Record<string, any> | null | undefined,
  keys: string[],
): string | null {
  const attrs = extractedData?.attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  for (const key of keys) {
    const cleaned = cleanNullableString(attrs[key]);
    if (cleaned) return cleaned;
  }
  return null;
}

@Injectable()
export class ClientsService {
  constructor(
    @InjectModel(Client)
    private readonly clientModel: typeof Client,
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    private readonly sequelize: Sequelize,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    @Optional()
    @InjectModel(DocumentLink)
    private readonly documentLinkModel?: typeof DocumentLink,
  ) {}

  private assertValidCompanyScope(companyId?: number | null): number {
    const parsed = Number(companyId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ForbiddenException(
        'Acceso denegado: Se requiere pertenecer a una compañía activa para operar con clientes.',
      );
    }
    return parsed;
  }

  private normalizeOptionalTaxId(taxId?: string | null): {
    taxIdFormatted: string | null;
    normalizedTaxId: string | null;
  } {
    const clean = cleanNullableString(taxId);
    if (!clean) {
      return { taxIdFormatted: null, normalizedTaxId: null };
    }
    const digits = normalizeTaxIdDigits(clean);
    if (digits.length < 7 || digits.length > 15) {
      throw new BadRequestException(
        'El CUIT / CUIL debe contener entre 7 y 15 dígitos numéricos (ej: 20-30405060-7).',
      );
    }
    return {
      taxIdFormatted: formatTaxIdDisplay(clean),
      normalizedTaxId: digits,
    };
  }

  async findAll(companyId: number, query: QueryClientDto) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const { search, isActive, page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;
    const likeOp = Op.iLike ? Op.iLike : Op.like;

    const where: any = { companyId: scopedCompanyId };
    if (isActive === 'true') where.isActive = true;
    if (isActive === 'false') where.isActive = false;

    if (search && search.trim().length > 0) {
      const clean = search.trim();
      const wildcard = `%${clean}%`;
      const digitsOnly = normalizeTaxIdDigits(clean);
      const orClauses: any[] = [
        { name: { [likeOp]: wildcard } },
        { tradeName: { [likeOp]: wildcard } },
        { taxId: { [likeOp]: wildcard } },
        { iibbNumber: { [likeOp]: wildcard } },
        { erpCode: { [likeOp]: wildcard } },
        { contactName: { [likeOp]: wildcard } },
        { email: { [likeOp]: wildcard } },
        { phone: { [likeOp]: wildcard } },
        { city: { [likeOp]: wildcard } },
        { province: { [likeOp]: wildcard } },
      ];
      if (digitsOnly.length >= 2) {
        orClauses.push({ normalizedTaxId: { [likeOp]: `%${digitsOnly}%` } });
      }
      where[Op.or] = orClauses;
    }

    const { rows, count } = await this.clientModel.findAndCountAll({
      where,
      limit,
      offset,
      order: [['name', 'ASC']],
    });

    const clientIds = rows.map((c) => c.id);
    const countByClient = new Map<number, number>();
    if (clientIds.length > 0) {
      const docCounts = (await this.documentModel.findAll({
        attributes: ['clientId', [fn('COUNT', col('id')), 'count']],
        where: {
          companyId: scopedCompanyId,
          clientId: { [Op.in]: clientIds },
        },
        group: ['clientId'],
        raw: true,
      })) as unknown as Array<{ clientId: number; count: string | number }>;

      for (const item of docCounts) {
        countByClient.set(Number(item.clientId), Number(item.count || 0));
      }
    }

    return {
      data: rows.map((c) => ({
        ...c.toJSON(),
        documentsCount: countByClient.get(c.id) ?? 0,
      })),
      meta: {
        totalItems: count,
        totalPages: Math.max(1, Math.ceil(count / limit)),
        currentPage: page,
        itemsPerPage: limit,
      },
    };
  }

  async findById(id: number, companyId: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const client = await this.clientModel.findOne({
      where: { id, companyId: scopedCompanyId },
    });

    if (!client) {
      throw new NotFoundException(`Cliente #${id} no encontrado en tu compañía`);
    }

    const recentDocuments = await this.documentModel.findAll({
      where: { companyId: scopedCompanyId, clientId: client.id },
      attributes: [
        'id',
        'originalName',
        'documentType',
        'documentNumber',
        'documentDate',
        'totalAmount',
        'currency',
        'status',
        'source',
        'createdAt',
      ],
      order: [['createdAt', 'DESC']],
      limit: 25,
    });

    const documentsCount = await this.documentModel.count({
      where: { companyId: scopedCompanyId, clientId: client.id },
    });

    return {
      ...client.toJSON(),
      documentsCount,
      documents: recentDocuments,
    };
  }

  /**
   * Retorna el historial completo de documentos vinculados al cliente dentro de la compañía,
   * identificando si figura como Emisor, Destinatario/Cliente, ambos o vínculo directo,
   * junto con conteos agrupados por tipo de documento y rol.
   */
  async findClientDocuments(
    id: number,
    companyId: number,
    query: QueryClientDocumentsDto,
  ) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const client = await this.clientModel.findOne({
      where: { id, companyId: scopedCompanyId },
    });

    if (!client) {
      throw new NotFoundException(`Cliente #${id} no encontrado en tu compañía`);
    }

    const {
      documentType,
      role = 'all',
      status,
      paymentStatus,
      linkState = 'all',
      search,
      page = 1,
      limit = 15,
    } = query;

    const allCompanyDocs = await this.documentModel.findAll({
      where: { companyId: scopedCompanyId },
      attributes: [
        'id',
        'clientId',
        'originalName',
        'documentType',
        'documentLetter',
        'pointOfSale',
        'documentNumber',
        'documentDate',
        'dueDate',
        'issuerName',
        'issuerTaxId',
        'recipientName',
        'recipientTaxId',
        'recipientEmail',
        'purchaseOrderNumber',
        'referenceNumber',
        'currency',
        'netAmount',
        'taxAmount',
        'totalAmount',
        'status',
        'source',
        'paymentStatus',
        'summary',
        'createdAt',
        'updatedAt',
      ],
      order: [['createdAt', 'DESC']],
    });

    const related: Array<{
      doc: any;
      clientRole: ClientDocumentRole;
      normalizedType: string;
    }> = [];

    const byTypeMap: Record<string, number> = {};
    const byRole = { all: 0, issuer: 0, recipient: 0, linked: 0 };
    const byStatus = { pendingApproval: 0, validated: 0, error: 0 };

    for (const rawDoc of allCompanyDocs) {
      const plain = typeof (rawDoc as any).toJSON === 'function' ? (rawDoc as any).toJSON() : rawDoc;
      const evaluation = evaluateClientRoleInDocument(client, plain);
      if (!evaluation.matches) continue;

      const normalizedType = normalizeDocumentTypeBucket(plain.documentType);
      related.push({
        doc: plain,
        clientRole: evaluation.clientRole,
        normalizedType,
      });

      byRole.all++;
      if (evaluation.clientRole === 'issuer' || evaluation.clientRole === 'both') byRole.issuer++;
      if (evaluation.clientRole === 'recipient' || evaluation.clientRole === 'both') byRole.recipient++;
      if (evaluation.clientRole === 'linked') byRole.linked++;

      byTypeMap[normalizedType] = (byTypeMap[normalizedType] || 0) + 1;

      if (
        plain.status === DocumentStatus.PENDING_APPROVAL ||
        plain.status === DocumentStatus.PENDING ||
        plain.status === DocumentStatus.PROCESSING
      ) {
        byStatus.pendingApproval++;
      } else if (plain.status === DocumentStatus.VALIDATED || plain.status === DocumentStatus.PROCESSED) {
        byStatus.validated++;
      } else if (plain.status === DocumentStatus.ERROR || plain.status === DocumentStatus.REJECTED) {
        byStatus.error++;
      }
    }

    const allLinksByDocId = new Map<number, any[]>();
    if (this.documentLinkModel && related.length > 0) {
      const relatedIds = related.map((item) => item.doc.id);
      const links = await this.documentLinkModel.findAll({
        where: {
          companyId: scopedCompanyId,
          [Op.or]: [{ sourceDocumentId: relatedIds }, { targetDocumentId: relatedIds }],
        },
        include: [{ model: Document, as: 'sourceDocument', attributes: ['id', 'totalAmount'] }],
      });
      for (const lnk of links) {
        const plainLink = typeof (lnk as any).toJSON === 'function' ? (lnk as any).toJSON() : lnk;
        const srcList = allLinksByDocId.get(plainLink.sourceDocumentId) || [];
        srcList.push(plainLink);
        allLinksByDocId.set(plainLink.sourceDocumentId, srcList);

        if (plainLink.targetDocumentId !== plainLink.sourceDocumentId) {
          const tgtList = allLinksByDocId.get(plainLink.targetDocumentId) || [];
          tgtList.push(plainLink);
          allLinksByDocId.set(plainLink.targetDocumentId, tgtList);
        }
      }
    }

    const enrichedRelated = related.map(({ doc, clientRole, normalizedType }) => {
      const docLinks = allLinksByDocId.get(doc.id) || [];
      const linkInputs = docLinks.map((l) => ({
        sourceDocumentId: l.sourceDocumentId,
        targetDocumentId: l.targetDocumentId,
        linkType: l.linkType,
        appliedAmount: l.appliedAmount,
        sourceTotalAmount: l.sourceDocument?.totalAmount,
      }));
      const balanceSummary = computeDocumentBalanceSummary({
        documentId: doc.id,
        documentType: doc.documentType,
        totalAmount: doc.totalAmount,
        currentPaymentStatus: doc.paymentStatus,
        links: linkInputs,
      });
      const imputationSummary = computeSourceImputationSummary({
        documentId: doc.id,
        documentType: doc.documentType,
        totalAmount: doc.totalAmount,
        links: linkInputs,
      });

      return {
        doc,
        clientRole,
        normalizedType,
        linkedCount: docLinks.length,
        balanceSummary,
        imputationSummary,
      };
    });

    const accountStatement = computeClientAccountStatement(enrichedRelated);

    const searchClean = cleanNullableString(search)?.toLowerCase() || '';
    const requestedType =
      documentType && documentType !== 'all'
        ? normalizeDocumentTypeBucket(documentType)
        : null;

    const filtered = enrichedRelated.filter(
      ({ doc, clientRole, normalizedType, linkedCount, balanceSummary }) => {
        if (requestedType && normalizedType !== requestedType) return false;
        if (role === 'issuer' && clientRole !== 'issuer' && clientRole !== 'both') return false;
        if (role === 'recipient' && clientRole !== 'recipient' && clientRole !== 'both') return false;
        if (role === 'linked' && clientRole !== 'linked') return false;
        if (status && doc.status !== status) return false;

        if (linkState === 'linked' && linkedCount === 0) return false;
        if (linkState === 'unlinked' && linkedCount > 0) return false;

        if (paymentStatus && paymentStatus !== 'all') {
          const effectivePayStatus = balanceSummary.isTrackable
            ? balanceSummary.derivedPaymentStatus
            : doc.paymentStatus;
          if (paymentStatus === 'UNPAID_OR_PARTIAL') {
            if (effectivePayStatus !== 'PENDING' && effectivePayStatus !== 'PARTIALLY_PAID') {
              return false;
            }
          } else if (effectivePayStatus !== paymentStatus) {
            return false;
          }
        }

        if (searchClean) {
          const haystack = [
            doc.originalName,
            doc.documentNumber,
            doc.documentType,
            doc.issuerName,
            doc.issuerTaxId,
            doc.recipientName,
            doc.recipientTaxId,
            doc.purchaseOrderNumber,
            doc.referenceNumber,
            doc.summary,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(searchClean)) return false;
        }

        return true;
      },
    );

    const totalItems = filtered.length;
    const offset = (page - 1) * limit;
    const paged = filtered
      .slice(offset, offset + limit)
      .map(({ doc, clientRole, normalizedType, linkedCount, balanceSummary, imputationSummary }) => ({
        ...doc,
        clientRole,
        normalizedDocumentType: normalizedType,
        linkedCount,
        balanceSummary,
        imputationSummary,
      }));

    const typeCounts = Object.entries(byTypeMap)
      .map(([type, count]) => ({ documentType: type, count }))
      .sort((a, b) => b.count - a.count);

    return {
      client: typeof (client as any).toJSON === 'function' ? (client as any).toJSON() : client,
      data: paged,
      summary: {
        total: byRole.all,
        byRole,
        byStatus,
        byType: byTypeMap,
        typeCounts,
        accountStatement,
      },
      meta: {
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
        currentPage: page,
        itemsPerPage: limit,
      },
    };
  }

  async create(dto: CreateClientDto, companyId: number, actorUserId: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const { taxIdFormatted, normalizedTaxId } = this.normalizeOptionalTaxId(dto.taxId);

    if (normalizedTaxId) {
      const existing = await this.clientModel.findOne({
        where: { companyId: scopedCompanyId, normalizedTaxId },
      });
      if (existing) {
        throw new ConflictException(
          `Ya existe un cliente registrado con el CUIT/CUIL ${taxIdFormatted} ('${existing.name}').`,
        );
      }
    }

    const transaction = await this.sequelize.transaction();
    let client: Client;
    try {
      client = await this.clientModel.create(
        {
          companyId: scopedCompanyId,
          name: dto.name.trim(),
          tradeName: cleanNullableString(dto.tradeName),
          taxIdType:
            cleanNullableString(dto.taxIdType) ||
            (taxIdFormatted ? inferTaxIdType(taxIdFormatted) : null),
          taxId: taxIdFormatted,
          normalizedTaxId,
          taxCondition: cleanNullableString(dto.taxCondition),
          iibbNumber: cleanNullableString(dto.iibbNumber),
          iibbCondition: cleanNullableString(dto.iibbCondition),
          erpCode: cleanNullableString(dto.erpCode),
          contactName: cleanNullableString(dto.contactName),
          email: cleanNullableString(dto.email),
          phone: cleanNullableString(dto.phone),
          secondaryPhone: cleanNullableString(dto.secondaryPhone),
          address: cleanNullableString(dto.address),
          city: cleanNullableString(dto.city),
          province: cleanNullableString(dto.province),
          postalCode: cleanNullableString(dto.postalCode),
          country: cleanNullableString(dto.country),
          paymentTerms: cleanNullableString(dto.paymentTerms),
          cbu: cleanNullableString(dto.cbu),
          notes: cleanNullableString(dto.notes),
          isActive: dto.isActive ?? true,
        } as any,
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    const linkedDocumentsCount = await this.linkUnassignedDocumentsToClient(client);

    await this.auditService.log({
      action: AuditAction.CREATE,
      entity: 'Client',
      entityId: client.id,
      companyId: scopedCompanyId,
      userId: actorUserId,
      payload: {
        ...client.toJSON(),
        linkedDocumentsCount,
      },
      description: `Se creó el cliente '${client.name}' (${client.taxId || 'CUIT/CUIL pendiente'})${linkedDocumentsCount > 0 ? ` y se asociaron ${linkedDocumentsCount} documento(s)` : ''}`,
    });

    await this.notificationsService
      .dispatch({
        type: 'client.created',
        title: '👤 Nuevo cliente registrado',
        body: `${client.name} (${client.taxId ? `CUIT/CUIL: ${client.taxId}` : 'CUIT/CUIL pendiente'})${linkedDocumentsCount > 0 ? ` — ${linkedDocumentsCount} documento(s) asociado(s)` : ''}`,
        companyId: scopedCompanyId,
        targetUserId: actorUserId,
        extraData: { clientId: client.id, link: '/clients' },
      })
      .catch(() => null);

    return {
      client: {
        ...client.toJSON(),
        documentsCount: linkedDocumentsCount,
      },
      linkedDocumentsCount,
      message:
        linkedDocumentsCount > 0
          ? `Cliente creado y ${linkedDocumentsCount} documento(s) asociado(s) automáticamente.`
          : 'Cliente creado correctamente.',
    };
  }

  async update(
    id: number,
    dto: UpdateClientDto,
    companyId: number,
    actorUserId: number,
  ) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const client = await this.clientModel.findOne({
      where: { id, companyId: scopedCompanyId },
    });
    if (!client) {
      throw new NotFoundException(`Cliente #${id} no encontrado en tu compañía`);
    }

    const updatePayload: any = {};
    if (dto.name !== undefined) updatePayload.name = dto.name.trim();
    if (dto.tradeName !== undefined) updatePayload.tradeName = cleanNullableString(dto.tradeName);
    if (dto.taxIdType !== undefined) updatePayload.taxIdType = cleanNullableString(dto.taxIdType);
    if (dto.taxCondition !== undefined) updatePayload.taxCondition = cleanNullableString(dto.taxCondition);
    if (dto.iibbNumber !== undefined) updatePayload.iibbNumber = cleanNullableString(dto.iibbNumber);
    if (dto.iibbCondition !== undefined) updatePayload.iibbCondition = cleanNullableString(dto.iibbCondition);
    if (dto.erpCode !== undefined) updatePayload.erpCode = cleanNullableString(dto.erpCode);
    if (dto.contactName !== undefined) updatePayload.contactName = cleanNullableString(dto.contactName);
    if (dto.email !== undefined) updatePayload.email = cleanNullableString(dto.email);
    if (dto.phone !== undefined) updatePayload.phone = cleanNullableString(dto.phone);
    if (dto.secondaryPhone !== undefined) updatePayload.secondaryPhone = cleanNullableString(dto.secondaryPhone);
    if (dto.address !== undefined) updatePayload.address = cleanNullableString(dto.address);
    if (dto.city !== undefined) updatePayload.city = cleanNullableString(dto.city);
    if (dto.province !== undefined) updatePayload.province = cleanNullableString(dto.province);
    if (dto.postalCode !== undefined) updatePayload.postalCode = cleanNullableString(dto.postalCode);
    if (dto.country !== undefined) updatePayload.country = cleanNullableString(dto.country);
    if (dto.paymentTerms !== undefined) updatePayload.paymentTerms = cleanNullableString(dto.paymentTerms);
    if (dto.cbu !== undefined) updatePayload.cbu = cleanNullableString(dto.cbu);
    if (dto.notes !== undefined) updatePayload.notes = cleanNullableString(dto.notes);
    if (dto.isActive !== undefined) updatePayload.isActive = dto.isActive;

    if (dto.taxId !== undefined) {
      const { taxIdFormatted, normalizedTaxId } = this.normalizeOptionalTaxId(dto.taxId);
      if (normalizedTaxId) {
        const conflict = await this.clientModel.findOne({
          where: {
            companyId: scopedCompanyId,
            normalizedTaxId,
            id: { [Op.ne]: id },
          },
        });
        if (conflict) {
          throw new ConflictException(
            `Otro cliente ('${conflict.name}') ya utiliza el CUIT/CUIL ${taxIdFormatted}.`,
          );
        }
      }
      updatePayload.taxId = taxIdFormatted;
      updatePayload.normalizedTaxId = normalizedTaxId;
      if (dto.taxIdType === undefined && !client.taxIdType && taxIdFormatted) {
        updatePayload.taxIdType = inferTaxIdType(taxIdFormatted);
      }
    }

    const transaction = await this.sequelize.transaction();
    try {
      await client.update(updatePayload, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    const linkedDocumentsCount = await this.linkUnassignedDocumentsToClient(client);
    const documentsCount = await this.documentModel.count({
      where: { companyId: scopedCompanyId, clientId: client.id },
    });

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entity: 'Client',
      entityId: client.id,
      companyId: scopedCompanyId,
      userId: actorUserId,
      payload: { ...updatePayload, linkedDocumentsCount },
      description: `Cliente '${client.name}' (${client.taxId || 'CUIT pendiente'}) actualizado`,
    });

    await this.notificationsService
      .dispatch({
        type: 'client.updated',
        title: '📝 Cliente actualizado',
        body: `Se actualizaron los datos de ${client.name} (${client.taxId ? `CUIT/CUIL: ${client.taxId}` : 'CUIT/CUIL pendiente'})`,
        companyId: scopedCompanyId,
        targetUserId: actorUserId,
        extraData: { clientId: client.id, link: '/clients' },
      })
      .catch(() => null);

    return {
      client: {
        ...client.toJSON(),
        documentsCount,
      },
      linkedDocumentsCount,
      message: 'Cliente actualizado correctamente',
    };
  }

  async syncDocumentsByTaxId(id: number, companyId: number, actorUserId: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const client = await this.clientModel.findOne({
      where: { id, companyId: scopedCompanyId },
    });
    if (!client) {
      throw new NotFoundException(`Cliente #${id} no encontrado en tu compañía`);
    }

    const linkedDocumentsCount = await this.linkUnassignedDocumentsToClient(client);

    if (linkedDocumentsCount > 0) {
      await this.auditService.log({
        action: AuditAction.UPDATE,
        entity: 'Client',
        entityId: client.id,
        companyId: scopedCompanyId,
        userId: actorUserId,
        payload: { linkedDocumentsCount },
        description: `Se asociaron ${linkedDocumentsCount} documento(s) al cliente '${client.name}' por CUIT/CUIL ${client.taxId}`,
      });
    }

    return {
      linkedDocumentsCount,
      message:
        linkedDocumentsCount > 0
          ? `Se asociaron ${linkedDocumentsCount} documento(s) con CUIL/CUIT coincidente.`
          : 'No se encontraron documentos sin asignar con ese CUIL/CUIT.',
    };
  }

  async remove(id: number, companyId: number, actorUserId: number) {
    const scopedCompanyId = this.assertValidCompanyScope(companyId);
    const client = await this.clientModel.findOne({
      where: { id, companyId: scopedCompanyId },
    });
    if (!client) {
      throw new NotFoundException(`Cliente #${id} no encontrado en tu compañía`);
    }

    const transaction = await this.sequelize.transaction();
    try {
      await this.documentModel.update(
        { clientId: null },
        { where: { companyId: scopedCompanyId, clientId: client.id }, transaction },
      );
      await client.destroy({ transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    await this.auditService.log({
      action: AuditAction.DELETE,
      entity: 'Client',
      entityId: id,
      companyId: scopedCompanyId,
      userId: actorUserId,
      description: `Se eliminó el cliente '${client.name}' (${client.taxId})`,
    });

    return {
      success: true,
      message: `Cliente '${client.name}' eliminado correctamente`,
    };
  }

  /**
   * Busca automáticamente un cliente activo en la compañía comparando candidatos de CUIT/CUIL
   * (priorizando `recipientTaxId`, luego `issuerTaxId`, luego `rawText`) y, si el documento no trae CUIL,
   * por coincidencia de correo electrónico o Razón Social/Nombre normalizado.
   */
  async resolveMatchingClientForDocument(
    companyId: number,
    params: {
      recipientTaxId?: string | null;
      issuerTaxId?: string | null;
      rawText?: string | null;
      recipientName?: string | null;
      recipientEmail?: string | null;
    },
  ): Promise<Client | null> {
    if (!companyId || companyId <= 0) return null;

    const orderedCandidates: string[] = [];
    const pushCandidate = (raw?: string | null) => {
      const digits = normalizeTaxIdDigits(raw);
      if (digits.length >= 7 && !orderedCandidates.includes(digits)) {
        orderedCandidates.push(digits);
      }
    };

    pushCandidate(params.recipientTaxId);
    pushCandidate(params.issuerTaxId);

    if (params.rawText) {
      const matches = params.rawText.match(/\b\d{2}[-\s]?\d{8}[-\s]?\d\b/g) || [];
      for (const m of matches) {
        pushCandidate(m);
      }
    }

    if (orderedCandidates.length > 0) {
      const matchingClients = await this.clientModel.findAll({
        where: {
          companyId,
          isActive: true,
          normalizedTaxId: { [Op.in]: orderedCandidates },
        },
      });

      for (const candidateDigits of orderedCandidates) {
        const hit = matchingClients.find((c) => c.normalizedTaxId === candidateDigits);
        if (hit) return hit;
      }
    }

    const cleanEmail = cleanNullableString(params.recipientEmail)?.toLowerCase();
    const cleanNameKey = normalizeClientNameKey(params.recipientName);
    if (!cleanEmail && (!cleanNameKey || INVALID_PLACEHOLDER_NAMES.has(cleanNameKey))) {
      return null;
    }

    const activeClients = await this.clientModel.findAll({
      where: { companyId, isActive: true },
    });

    if (cleanEmail) {
      const byEmail = activeClients.find(
        (c) => cleanNullableString(c.email)?.toLowerCase() === cleanEmail,
      );
      if (byEmail) return byEmail;
    }

    if (cleanNameKey && !INVALID_PLACEHOLDER_NAMES.has(cleanNameKey)) {
      const byName = activeClients.find(
        (c) =>
          normalizeClientNameKey(c.name) === cleanNameKey ||
          (c.tradeName ? normalizeClientNameKey(c.tradeName) === cleanNameKey : false),
      );
      if (byName) return byName;
    }

    return null;
  }

  /**
   * Busca un cliente existente por CUIT/CUIL, email o nombre dentro de la compañía y, si NO existe,
   * lo crea automáticamente completando los datos administrativos disponibles del documento.
   * Si el documento (ej. un presupuesto) no trae CUIT/CUIL, se crea con `taxId = null` para completarlo luego.
   */
  async resolveOrCreateClientForDocument(
    companyId: number,
    params: {
      recipientName?: string | null;
      recipientTaxId?: string | null;
      recipientEmail?: string | null;
      recipientPhone?: string | null;
      deliveryAddress?: string | null;
      responsiblePerson?: string | null;
      taxCondition?: string | null;
      paymentTerms?: string | null;
      issuerTaxId?: string | null;
      rawText?: string | null;
      extractedData?: Record<string, any> | null;
      sourceDocumentName?: string | null;
      actorUserId?: number | null;
    },
  ): Promise<Client | null> {
    if (!companyId || companyId <= 0) return null;

    const rawName =
      cleanNullableString(params.recipientName) ||
      pickExtractedAttr(params.extractedData, [
        'cliente',
        'razon_social_cliente',
        'destinatario',
        'razon_social',
        'razón_social',
      ]);

    const rawTaxId =
      cleanNullableString(params.recipientTaxId) ||
      pickExtractedAttr(params.extractedData, [
        'cuit_cliente',
        'cuil_cliente',
        'cuit_destinatario',
        'cuil_destinatario',
      ]);

    const rawEmail =
      cleanNullableString(params.recipientEmail) ||
      pickExtractedAttr(params.extractedData, ['email_cliente', 'correo_cliente', 'email', 'e-mail']);
    const validEmail =
      rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail.slice(0, 120) : null;

    const rawPhone =
      cleanNullableString(params.recipientPhone) ||
      pickExtractedAttr(params.extractedData, ['telefono_cliente', 'telefono', 'teléfono']);

    const rawContact =
      cleanNullableString(params.responsiblePerson) ||
      pickExtractedAttr(params.extractedData, ['contacto_cliente', 'contacto']);

    const rawAddress =
      cleanNullableString(params.deliveryAddress) ||
      pickExtractedAttr(params.extractedData, [
        'domicilio_cliente',
        'direccion_cliente',
        'domicilio',
        'direccion',
      ]);

    const normalizedDigits = normalizeTaxIdDigits(rawTaxId);
    const validDigits =
      normalizedDigits.length >= 7 && normalizedDigits.length <= 15 ? normalizedDigits : null;

    const existingActive = await this.resolveMatchingClientForDocument(companyId, {
      recipientTaxId: params.recipientTaxId,
      issuerTaxId: params.issuerTaxId,
      rawText: params.rawText,
      recipientName: rawName,
      recipientEmail: validEmail,
    });

    if (existingActive) {
      await this.enrichExistingClientFromDocument(existingActive, {
        validDigits,
        email: validEmail,
        phone: rawPhone,
        contactName: rawContact,
        address: rawAddress,
        taxCondition: cleanNullableString(params.taxCondition),
        paymentTerms: cleanNullableString(params.paymentTerms),
      });
      return existingActive;
    }

    if (!rawName || INVALID_PLACEHOLDER_NAMES.has(rawName.toLowerCase())) {
      return null;
    }

    if (validDigits) {
      const existingAnyStatus = await this.clientModel.findOne({
        where: { companyId, normalizedTaxId: validDigits },
      });
      if (existingAnyStatus) {
        return existingAnyStatus.isActive ? existingAnyStatus : null;
      }
    }

    const taxIdFormatted = validDigits ? formatTaxIdDisplay(validDigits) : null;

    const clientPayload = {
      companyId,
      name: rawName.slice(0, 200),
      tradeName: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['nombre_fantasia_cliente', 'fantasia_cliente']),
      )?.slice(0, 200) || null,
      taxIdType: validDigits ? inferTaxIdType(validDigits) : null,
      taxId: taxIdFormatted ? taxIdFormatted.slice(0, 30) : null,
      normalizedTaxId: validDigits,
      taxCondition: cleanNullableString(
        params.taxCondition ||
          pickExtractedAttr(params.extractedData, [
            'condicion_iva_cliente',
            'condicion_frente_iva_cliente',
            'condicion_iva_receptor',
            'condicion_fiscal',
          ]),
      )?.slice(0, 60) || null,
      iibbNumber: cleanNullableString(
        pickExtractedAttr(params.extractedData, [
          'iibb_cliente',
          'ingresos_brutos_cliente',
          'nro_iibb_cliente',
        ]),
      )?.slice(0, 40) || null,
      iibbCondition: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['condicion_iibb_cliente']),
      )?.slice(0, 60) || null,
      erpCode: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['codigo_cliente', 'codigo_erp_cliente']),
      )?.slice(0, 50) || null,
      contactName: rawContact?.slice(0, 150) || null,
      email: validEmail,
      phone: rawPhone?.slice(0, 50) || null,
      secondaryPhone: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['celular_cliente', 'whatsapp_cliente']),
      )?.slice(0, 50) || null,
      address: rawAddress?.slice(0, 255) || null,
      city: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['localidad_cliente', 'localidad', 'ciudad']),
      )?.slice(0, 100) || null,
      province: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['provincia_cliente', 'provincia']),
      )?.slice(0, 100) || null,
      postalCode: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['codigo_postal_cliente', 'codigo_postal', 'cp']),
      )?.slice(0, 20) || null,
      country: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['pais_cliente', 'pais']),
      )?.slice(0, 80) || null,
      paymentTerms: cleanNullableString(params.paymentTerms)?.slice(0, 150) || null,
      cbu: cleanNullableString(
        pickExtractedAttr(params.extractedData, ['cbu_cliente', 'cbu']),
      )?.slice(0, 40) || null,
      notes: params.sourceDocumentName
        ? `Registrado automáticamente desde comprobante '${params.sourceDocumentName}'`
        : null,
      isActive: true,
    };

    const transaction = await this.sequelize.transaction();
    let created: Client;
    try {
      created = await this.clientModel.create(clientPayload as any, { transaction });
      await transaction.commit();
    } catch (error: any) {
      await transaction.rollback();
      if (error?.name === 'SequelizeUniqueConstraintError' && validDigits) {
        const concurrentClient = await this.clientModel.findOne({
          where: { companyId, normalizedTaxId: validDigits },
        });
        return concurrentClient?.isActive ? concurrentClient : null;
      }
      throw error;
    }

    await this.auditService
      .log({
        action: AuditAction.CREATE,
        entity: 'Client',
        entityId: created.id,
        companyId,
        userId: params.actorUserId ?? undefined,
        payload: { ...clientPayload, autoCreated: true },
        description: `Se creó automáticamente el cliente '${created.name}' (${created.taxId || 'CUIT/CUIL pendiente'}) desde documento`,
      })
      .catch(() => null);

    await this.notificationsService
      .dispatch({
        type: 'client.created',
        title: '👤 Cliente registrado automáticamente',
        body: `${created.name} (${created.taxId ? `CUIT/CUIL: ${created.taxId}` : 'CUIT/CUIL pendiente'})${params.sourceDocumentName ? ` desde '${params.sourceDocumentName}'` : ''}`,
        companyId,
        targetUserId: params.actorUserId ?? undefined,
        extraData: { clientId: created.id, link: '/clients' },
      })
      .catch(() => null);

    return created;
  }

  private async enrichExistingClientFromDocument(
    client: Client,
    data: {
      validDigits: string | null;
      email: string | null;
      phone: string | null;
      contactName: string | null;
      address: string | null;
      taxCondition: string | null;
      paymentTerms: string | null;
    },
  ): Promise<void> {
    if (typeof (client as any).update !== 'function') return;

    const patch: Record<string, any> = {};
    if (!client.normalizedTaxId && data.validDigits) {
      const collision = await this.clientModel.findOne({
        where: {
          companyId: client.companyId,
          normalizedTaxId: data.validDigits,
          id: { [Op.ne]: client.id },
        },
      });
      if (!collision) {
        patch.taxId = formatTaxIdDisplay(data.validDigits);
        patch.normalizedTaxId = data.validDigits;
        if (!client.taxIdType) patch.taxIdType = inferTaxIdType(data.validDigits);
      }
    }
    if (!client.email && data.email) patch.email = data.email;
    if (!client.phone && data.phone) patch.phone = data.phone.slice(0, 50);
    if (!client.contactName && data.contactName) patch.contactName = data.contactName.slice(0, 150);
    if (!client.address && data.address) patch.address = data.address.slice(0, 255);
    if (!client.taxCondition && data.taxCondition) patch.taxCondition = data.taxCondition.slice(0, 60);
    if (!client.paymentTerms && data.paymentTerms) patch.paymentTerms = data.paymentTerms.slice(0, 150);

    if (Object.keys(patch).length > 0) {
      await client.update(patch).catch(() => null);
    }
  }

  /**
   * Asocia retroactivamente documentos existentes de la compañía sin cliente asignado (`clientId IS NULL`)
   * comparando por CUIT/CUIL y, si aplica, por email o nombre normalizado.
   */
  async linkUnassignedDocumentsToClient(client: Client): Promise<number> {
    if (!client.isActive) return 0;

    const unlinkedDocs = await this.documentModel.findAll({
      where: {
        companyId: client.companyId,
        clientId: null,
      },
      attributes: ['id', 'recipientName', 'recipientEmail', 'recipientTaxId', 'issuerTaxId', 'rawText'],
      limit: 500,
    });

    const clientNameKey = normalizeClientNameKey(client.name);
    const clientTradeKey = client.tradeName ? normalizeClientNameKey(client.tradeName) : '';
    const clientEmail = cleanNullableString(client.email)?.toLowerCase();

    const idsToLink: number[] = [];
    for (const doc of unlinkedDocs) {
      const matchedByTax =
        client.normalizedTaxId && this.documentMatchesTaxId(doc, client.normalizedTaxId);
      const docEmail = cleanNullableString(doc.recipientEmail)?.toLowerCase();
      const matchedByEmail = Boolean(clientEmail && docEmail && clientEmail === docEmail);
      const docNameKey = normalizeClientNameKey(doc.recipientName);
      const matchedByName = Boolean(
        docNameKey &&
          ((clientNameKey && docNameKey === clientNameKey) ||
            (clientTradeKey && docNameKey === clientTradeKey)),
      );

      if (matchedByTax || matchedByEmail || matchedByName) {
        idsToLink.push(doc.id);
      }
    }

    if (idsToLink.length === 0) return 0;

    await this.documentModel.update(
      { clientId: client.id },
      { where: { companyId: client.companyId, id: { [Op.in]: idsToLink } } },
    );

    return idsToLink.length;
  }

  private documentMatchesTaxId(
    doc: Pick<Document, 'recipientTaxId' | 'issuerTaxId' | 'rawText'>,
    targetDigits: string,
  ): boolean {
    if (normalizeTaxIdDigits(doc.recipientTaxId) === targetDigits) return true;
    if (normalizeTaxIdDigits(doc.issuerTaxId) === targetDigits) return true;
    if (doc.rawText) {
      const matches = doc.rawText.match(/\b\d{2}[-\s]?\d{8}[-\s]?\d\b/g) || [];
      return matches.some((m) => normalizeTaxIdDigits(m) === targetDigits);
    }
    return false;
  }
}
