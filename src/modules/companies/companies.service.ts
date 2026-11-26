import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Company, CompanyStatus } from './company.model';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { QueryCompanyDto } from './dto/query-company.dto';
import { Users, UserStatus } from '../users/users.model';
import { Role } from '../role/role.model';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.model';
import { NotificationsService } from '../notifications/notifications.service';
import { Plan } from '../plans/plan.model';
import { PlansService } from '../plans/plans.service';
import { TenantQuotasService } from '../plans/services/tenant-quotas.service';
import { FtpDevicesService } from '../ftp-devices/ftp-devices.service';
import { ensureTenantDirectories } from '../../common/utils/storage-path.util';
import {
  buildCompanyCreationAttributes,
  buildCompanySearchWhere,
  prepareInitialCompanyAdmin,
} from './helpers/company-onboarding.helper';
import {
  purgeCompanyDiskFiles,
  purgeCompanyRelationsInTransaction,
} from './helpers/company-cascade-delete.helper';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    @InjectModel(Company)
    private readonly companyModel: typeof Company,
    private readonly sequelize: Sequelize,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly plansService: PlansService,
    private readonly tenantQuotasService: TenantQuotasService,
    @Optional() private readonly ftpDevicesService?: FtpDevicesService,
  ) {}

  async create(dto: CreateCompanyDto, actorUserId?: number): Promise<any> {
    const slug = dto.slug.toLowerCase().trim();
    const existingSlug = await this.companyModel.findOne({ where: { slug } });
    if (existingSlug) {
      throw new BadRequestException(`El slug '${dto.slug}' ya se encuentra en uso por otra compañía`);
    }

    const assignedPlan = dto.planId
      ? await this.plansService.findById(dto.planId)
      : await this.plansService.findDefaultPlan();

    const adminSetup = await prepareInitialCompanyAdmin(dto, slug);
    const transaction = await this.sequelize.transaction();

    try {
      const company = await this.companyModel.create(
        buildCompanyCreationAttributes(dto, slug, assignedPlan) as never,
        { transaction },
      );

      const adminUser = await Users.create(
        {
          name: dto.adminName || 'Admin',
          lastName: dto.adminLastName || company.name,
          email: adminSetup.adminEmail,
          username: adminSetup.adminUsername,
          password: adminSetup.hashedPassword,
          phone: dto.phone || null,
          roleId: adminSetup.companyAdminRole.id,
          companyId: company.id,
          isAdmin: true,
          status: UserStatus.ACTIVE,
          createdByAdminId: actorUserId || null,
        } as never,
        { transaction },
      );

      await transaction.commit();

      // Aprovisionar inmediatamente su estructura física aislada storage/tenancy/company_<id>_<slug>/{inbox,vault,quarantine}
      ensureTenantDirectories(company.id, company.slug || company.name);

      await this.auditService.log({
        action: AuditAction.CREATE,
        entity: 'Company',
        entityId: company.id,
        companyId: company.id,
        userId: actorUserId,
        payload: {
          company: company.toJSON(),
          initialAdminUserId: adminUser.id,
          planSlug: assignedPlan?.slug ?? null,
        },
        description: `Se ha creado la compañía '${company.name}' (Plan: ${assignedPlan?.name || 'Personalizado'}) y su administrador '${adminUser.username}'`,
      });

      return {
        company,
        initialAdminUser: {
          id: adminUser.id,
          username: adminUser.username,
          email: adminUser.email,
          temporaryPassword: adminSetup.rawPassword,
        },
      };
    } catch (error: any) {
      await transaction.rollback();
      this.logger.error(`Error al registrar la compañía ${dto.name}: ${error.message}`);
      throw error;
    }
  }

  async findAll(query: QueryCompanyDto): Promise<{
    data: any[];
    meta: {
      totalItems: number;
      itemCount: number;
      itemsPerPage: number;
      totalPages: number;
      currentPage: number;
    };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
    const offset = (page - 1) * limit;

    const where = buildCompanySearchWhere(query);

    const { rows, count } = await this.companyModel.findAndCountAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: Plan,
          attributes: [
            'id',
            'name',
            'slug',
            'priceMonthly',
            'pricePerProcessedDocumentArs',
            'currency',
            'isTrial',
            'badgeColor',
            'maxUsers',
            'maxPages',
            'maxDocuments',
            'maxStorageMb',
            'maxAiQueriesMonthly',
          ],
        },
      ],
    });

    const summariesMap = await this.tenantQuotasService.getBatchQuotaSummaries(rows);

    const data = rows.map((comp) => {
      const summary = summariesMap.get(comp.id);
      return {
        ...comp.toJSON(),
        activeUsersCount: summary ? summary.users.current : 0,
        quotaSummary: summary || null,
      };
    });

    return {
      data,
      meta: {
        totalItems: count,
        itemCount: rows.length,
        itemsPerPage: limit,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
      },
    };
  }

  async findBySlug(slug: string): Promise<Company> {
    const company = await this.companyModel.findOne({
      where: { slug: slug.toLowerCase().trim() },
      include: [
        {
          model: Plan,
          attributes: [
            'id',
            'name',
            'slug',
            'priceMonthly',
            'pricePerProcessedDocumentArs',
            'currency',
            'isTrial',
            'badgeColor',
            'maxUsers',
            'maxPages',
            'maxDocuments',
            'maxStorageMb',
            'maxAiQueriesMonthly',
          ],
        },
      ],
    });

    if (!company) {
      throw new NotFoundException(`Compañía con slug '${slug}' no encontrada`);
    }

    return company;
  }

  async findById(id: number): Promise<Company> {
    const company = await this.companyModel.findByPk(id, {
      include: [
        {
          model: Plan,
          attributes: [
            'id',
            'name',
            'slug',
            'priceMonthly',
            'pricePerProcessedDocumentArs',
            'currency',
            'isTrial',
            'badgeColor',
            'maxUsers',
            'maxPages',
            'maxDocuments',
            'maxStorageMb',
            'maxAiQueriesMonthly',
            'includedModules',
          ],
        },
      ],
    });

    if (!company) {
      throw new NotFoundException(`Compañía con ID ${id} no encontrada`);
    }

    return company;
  }

  async update(id: number, dto: UpdateCompanyDto, actorUserId?: number): Promise<Company> {
    const company = await this.findById(id);

    if (dto.slug && dto.slug.toLowerCase().trim() !== company.slug) {
      const collision = await this.companyModel.findOne({
        where: { slug: dto.slug.toLowerCase().trim() },
      });
      if (collision && collision.id !== id) {
        throw new BadRequestException(`El slug '${dto.slug}' ya se encuentra utilizado por otra compañía`);
      }
    }

    let planOrLimitsChanged = false;
    let resolvedPlan: Plan | null = null;
    if (dto.planId !== undefined && dto.planId !== company.planId) {
      planOrLimitsChanged = true;
      resolvedPlan = dto.planId ? await this.plansService.findById(dto.planId) : null;
    }

    if (
      dto.useCustomLimits !== undefined ||
      dto.maxUsers !== undefined ||
      dto.maxPages !== undefined ||
      dto.maxDocuments !== undefined ||
      dto.maxStorageMb !== undefined ||
      dto.maxAiQueriesMonthly !== undefined
    ) {
      planOrLimitsChanged = true;
    }

    const transaction = await this.sequelize.transaction();
    try {
      const prevData = company.toJSON();
      const payloadDto: any = { ...dto, slug: dto.slug ? dto.slug.toLowerCase().trim() : company.slug };

      if (payloadDto.maxPages !== undefined && payloadDto.maxDocuments === undefined) {
        payloadDto.maxDocuments = payloadDto.maxPages;
      } else if (payloadDto.maxDocuments !== undefined && payloadDto.maxPages === undefined) {
        payloadDto.maxPages = payloadDto.maxDocuments;
      }

      if (payloadDto.useCustomLimits === true && payloadDto.maxDocuments !== undefined) {
        payloadDto.maxStorageMb =
          payloadDto.maxDocuments !== null && Number(payloadDto.maxDocuments) > 0
            ? Math.max(1, Math.round((Number(payloadDto.maxDocuments) / 1000) * 1024))
            : null;
      }

      if (dto.status === CompanyStatus.ACTIVE) {
        await this.activateCompanyUsersAndAdmin(id, transaction);
        if (
          company.isTrial ||
          (company.trialEndsAt && new Date(company.trialEndsAt) <= new Date() && dto.trialEndsAt === undefined)
        ) {
          payloadDto.trialEndsAt = null;
          payloadDto.isTrial = false;
        }
      } else if (dto.status === CompanyStatus.INACTIVE || dto.status === CompanyStatus.SUSPENDED) {
        await this.deactivateCompanyUsers(id, transaction);
      }

      await company.update(payloadDto, { transaction });
      await transaction.commit();

      if (dto.status === CompanyStatus.ACTIVE) {
        await this.ftpDevicesService?.syncCompanyDevicesStatus(id, true);
      } else if (
        dto.status === CompanyStatus.INACTIVE ||
        dto.status === CompanyStatus.SUSPENDED
      ) {
        await this.ftpDevicesService?.syncCompanyDevicesStatus(id, false);
      }

      await this.auditService.log({
        action: AuditAction.UPDATE,
        entity: 'Company',
        entityId: company.id,
        companyId: company.id,
        userId: actorUserId,
        payload: { previous: prevData, updated: company.toJSON() },
        description: `Se actualizó la información de la compañía '${company.name}'`,
      });

      if (planOrLimitsChanged) {
        await this.notificationsService.dispatch({
          type: 'company.plan_updated',
          title: '🏅 Plan y límites actualizados',
          body: resolvedPlan
            ? `El plan de ${company.name} fue actualizado a '${resolvedPlan.name}'.`
            : `Se actualizaron los cupos operativos de ${company.name}.`,
          companyId: company.id,
          actorUser: { id: actorUserId },
        });
      }

      return this.findById(id);
    } catch (error: any) {
      await transaction.rollback();
      this.logger.error(`Error al actualizar la compañía ${id}: ${error.message}`);
      throw error;
    }
  }

  async changeStatus(id: number, status: CompanyStatus, actorUserId?: number): Promise<Company> {
    const company = await this.findById(id);
    const transaction = await this.sequelize.transaction();
    try {
      const prevStatus = company.status;
      const updates: any = { status };

      // Si el Superadmin reactiva una empresa inactiva/vencida, reactiva usuarios, asegura el admin y limpia trial vencido
      if (status === CompanyStatus.ACTIVE) {
        await this.activateCompanyUsersAndAdmin(id, transaction);
        if (company.isTrial || (company.trialEndsAt && new Date(company.trialEndsAt) <= new Date())) {
          updates.trialEndsAt = null;
          updates.isTrial = false;
        }
      } else if (status === CompanyStatus.INACTIVE || status === CompanyStatus.SUSPENDED) {
        await this.deactivateCompanyUsers(id, transaction);
      }

      await company.update(updates, { transaction });
      await transaction.commit();

      if (status === CompanyStatus.ACTIVE) {
        await this.ftpDevicesService?.syncCompanyDevicesStatus(id, true);
      } else if (
        status === CompanyStatus.INACTIVE ||
        status === CompanyStatus.SUSPENDED
      ) {
        await this.ftpDevicesService?.syncCompanyDevicesStatus(id, false);
      }

      await this.auditService.log({
        action: AuditAction.STATUS_CHANGE,
        entity: 'Company',
        entityId: company.id,
        companyId: company.id,
        userId: actorUserId,
        payload: { from: prevStatus, to: status },
        description:
          status === CompanyStatus.ACTIVE
            ? `Se activó la compañía '${company.name}' y se reactivó su usuario administrador`
            : `Se suspendió/desactivó la compañía '${company.name}' y sus usuarios asociados`,
      });

      return this.findById(id);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async remove(id: number, actorUserId?: number): Promise<{ success: boolean; message: string }> {
    const company = await this.findById(id);
    const transaction = await this.sequelize.transaction();
    try {
      const deletedData = company.toJSON();
      const { ftpUsernames, documentPaths, userImagePaths } =
        await purgeCompanyRelationsInTransaction(this.sequelize, id, transaction);
      await company.destroy({ transaction });
      await transaction.commit();

      if (ftpUsernames.length > 0) {
        await this.ftpDevicesService?.deleteExternalVirtualUsers(ftpUsernames);
      }

      if (process.env.NODE_ENV !== 'test') {
        purgeCompanyDiskFiles({
          companyId: id,
          documentPaths,
          assetPaths: [company.logo, ...userImagePaths],
        });
      }

      await this.auditService.log({
        action: AuditAction.DELETE,
        entity: 'Company',
        entityId: id,
        companyId: null,
        userId: actorUserId,
        payload: deletedData,
        description: `Se eliminó la compañía '${company.name}' junto con sus archivos en disco y registros dependientes`,
      });

      return { success: true, message: `Compañía '${company.name}' eliminada correctamente` };
    } catch (error: any) {
      await transaction.rollback();
      this.logger.error(`Error al eliminar la compañía ${id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reactiva los usuarios de la compañía, garantizando de manera explícita que
   * el usuario administrador (rol company_admin o isAdmin: true) pase a estado ACTIVE.
   */
  private async activateCompanyUsersAndAdmin(
    companyId: number,
    transaction: any,
  ): Promise<number> {
    // 1. Activar todos los usuarios pertenecientes a la compañía
    await Users.update(
      { status: UserStatus.ACTIVE },
      { where: { companyId }, transaction },
    );

    // 2. Localizar y asegurar activación del rol de administrador de compañía
    const adminRole = await Role.findOne({
      where: { slug: { [Op.in]: ['company_admin', 'admin'] } },
      transaction,
    });

    const adminWhere: any = {
      companyId,
      [Op.or]: [
        { isAdmin: true },
        ...(adminRole ? [{ roleId: adminRole.id }] : []),
      ],
    };

    const [adminUpdatedCount] = await Users.update(
      { status: UserStatus.ACTIVE },
      { where: adminWhere, transaction },
    );

    // 3. Respaldo: si por alguna inconsistencia ningún usuario tenía isAdmin ni rol admin,
    // promover al usuario más antiguo de la compañía a administrador y dejarlo ACTIVO
    if (adminUpdatedCount === 0) {
      const firstUser = await Users.findOne({
        where: { companyId },
        order: [['id', 'ASC']],
        transaction,
      });

      if (firstUser) {
        await firstUser.update(
          {
            status: UserStatus.ACTIVE,
            isAdmin: true,
            ...(adminRole ? { roleId: adminRole.id } : {}),
          },
          { transaction },
        );
      }
    }

    return adminUpdatedCount;
  }

  /**
   * Pasa a estado inactivo los usuarios de una compañía al suspenderla o desactivarla.
   */
  private async deactivateCompanyUsers(
    companyId: number,
    transaction: any,
  ): Promise<void> {
    await Users.update(
      { status: UserStatus.INACTIVE },
      { where: { companyId }, transaction },
    );
  }
}
