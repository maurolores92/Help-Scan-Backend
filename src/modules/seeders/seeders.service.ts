import { Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Role } from '../role/role.model';
import { Users } from '../users/users.model';
import { Company, CompanyStatus } from '../companies/company.model';
import { Plan } from '../plans/plan.model';
import { PlanExchangeConfig } from '../plans/models/plan-exchange-config.model';
import { Permission } from '../permissions/permission.model';
import { DocumentTypeForm } from '../documents/models/document-type-form.model';
import { DEFAULT_DOCUMENT_FORMS_SEED } from '../documents/data/default-document-forms.data';
import { RolePermission } from '../permissions/role-permission/role-permission.model';
import { UserPermission } from '../permissions/user-permission/user-permission.model';
import {
  DEPRECATED_PLATFORM_PERMISSIONS,
  permissionsData,
} from './data/permissions.data';
import { defaultPlansData } from './data/plans.data';

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(private sequelize: Sequelize) {}

  async ensureDefaultPlans(): Promise<{ enterprisePlan: Plan | null; defaultPlan: Plan | null }> {
    let enterprisePlan: Plan | null = null;
    let defaultPlan: Plan | null = null;

    for (const p of defaultPlansData) {
      const [plan, created] = await Plan.findOrCreate({
        where: { slug: p.slug },
        defaults: p as any,
      });

      if (created) {
        this.logger.log(`[SeedService] Plan base creado: ${plan.name} (${plan.slug})`);
      } else {
        // Preservar siempre las modificaciones del administrador (precio en dólares, límites, descripción)
        if (!plan.currency) {
          await plan.update({ currency: (p as any).currency || 'USD' });
        }
      }

      if (plan.slug === 'enterprise') enterprisePlan = plan;
      if (plan.isDefault) defaultPlan = plan;
    }

    if (defaultPlan) {
      await Company.update(
        { planId: defaultPlan.id },
        { where: { planId: null, slug: { [Op.ne]: 'helpcopies' } } },
      );
    }

    return { enterprisePlan, defaultPlan };
  }

  async ensureDefaultCompany(enterprisePlanId?: number | null): Promise<Company> {
    const [company, created] = await Company.findOrCreate({
      where: { slug: 'helpcopies' },
      defaults: {
        name: 'Helpcopies Matriz',
        slug: 'helpcopies',
        legalName: 'Helpcopies S.A.',
        taxId: '30-12345678-9',
        email: 'contacto@helpcopies.com',
        phone: '+54 11 4000-0000',
        address: 'Buenos Aires, Argentina',
        status: CompanyStatus.ACTIVE,
        planId: enterprisePlanId ?? null,
        settings: {
          maxPdfUploadSizeMb: 25,
          aiExtractionEnabled: true,
        },
      },
    });

    if (created) {
      this.logger.log(`[SeedService] Compañía matriz creada: ${company.name} (${company.slug})`);
    } else if (!company.planId && enterprisePlanId) {
      await company.update({ planId: enterprisePlanId });
    }

    return company;
  }

  async ensureSystemRoles() {
    const defaultRoles = [
      {
        name: 'Super Admin',
        slug: 'superadmin',
        color: '#F44336',
        companyId: null,
      },
      {
        name: 'Administrador de Compañía',
        slug: 'company_admin',
        color: '#2196F3',
        companyId: null,
      },
      {
        name: 'Operador de Documentos',
        slug: 'user',
        color: '#4CAF50',
        companyId: null,
      },
    ];

    for (const r of defaultRoles) {
      const [, created] = await Role.findOrCreate({
        where: { slug: r.slug, userId: null },
        defaults: { ...r, userId: null },
      });
      if (created) {
        this.logger.log(`[SeedService] Rol del sistema creado: ${r.name} (${r.slug})`);
      }
    }
  }

  async seedPermissions() {
    const transaction = await this.sequelize.transaction();
    try {
      // Eliminar permisos de plataforma que ya no deben existir como permisos delegables
      const deprecatedRows = await Permission.findAll({
        where: { name: { [Op.in]: DEPRECATED_PLATFORM_PERMISSIONS } },
        transaction,
      });

      if (deprecatedRows.length > 0) {
        const deprecatedIds = deprecatedRows.map((p) => p.id);
        await RolePermission.destroy({
          where: { permissionId: { [Op.in]: deprecatedIds } },
          transaction,
        });
        await UserPermission.destroy({
          where: { permissionId: { [Op.in]: deprecatedIds } },
          transaction,
        });
        await Permission.destroy({
          where: { id: { [Op.in]: deprecatedIds } },
          transaction,
        });
      }

      let createdCount = 0;
      let updatedCount = 0;
      const newlyCreatedNames = new Set<string>();

      for (const p of permissionsData) {
        const [record, created] = await Permission.findOrCreate({
          where: { name: p.name },
          defaults: p,
          transaction,
        });

        if (created) {
          createdCount++;
          newlyCreatedNames.add(p.name);
        } else {
          await record.update(
            {
              categoria: p.categoria,
              displayName: p.displayName,
              description: p.description,
            },
            { transaction },
          );
          updatedCount++;
        }
      }

      const allTenantPermissions = await Permission.findAll({ transaction });

      // Super Admin: acceso total (además de sus bypasses exclusivos por rol)
      const superAdminRole = await Role.findOne({
        where: { slug: 'superadmin' },
        transaction,
      });
      if (superAdminRole) {
        await superAdminRole.$set('permissions', allTenantPermissions, { transaction });
      }

      // Company Admin: todos los permisos operativos dentro de su compañía
      const companyAdminRole = await Role.findOne({
        where: { slug: 'company_admin' },
        transaction,
      });
      if (companyAdminRole) {
        await companyAdminRole.$set('permissions', allTenantPermissions, { transaction });
      }

      // Operador de Documentos: visualización de dashboard, PDFs e IA + canales propios en creación o nuevos seeds
      const userRole = await Role.findOne({
        where: { slug: 'user' },
        transaction,
      });
      if (userRole) {
        const existingRolePerms = await RolePermission.count({
          where: { roleId: userRole.id },
          transaction,
        });

        const defaultUserPermNames = [
          'VIEW_DASHBOARD',
          'VIEW_DOCUMENTS',
          'UPLOAD_DOCUMENT',
          'QUERY_AI_DOCUMENTS',
          'VIEW_CHANNELS',
          'MANAGE_OWN_EMAIL',
          'MANAGE_OWN_WHATSAPP',
          'MANAGE_OWN_TELEGRAM',
          'VIEW_EMAIL_INBOX',
          'VIEW_WHATSAPP_INBOX',
          'VIEW_TELEGRAM_INBOX',
        ];

        if (existingRolePerms === 0) {
          const userPerms = allTenantPermissions.filter((p: any) =>
            defaultUserPermNames.includes(p.name),
          );
          await userRole.$set('permissions', userPerms, { transaction });
        } else {
          // Agregar solo los permisos propios recién introducidos sin sobrescribir cambios hechos en Roles
          const newOwnChannelPerms = allTenantPermissions.filter(
            (p: any) =>
              newlyCreatedNames.has(p.name) &&
              [
                'MANAGE_OWN_EMAIL',
                'MANAGE_OWN_WHATSAPP',
                'MANAGE_OWN_TELEGRAM',
              ].includes(p.name),
          );
          for (const perm of newOwnChannelPerms) {
            await RolePermission.findOrCreate({
              where: { roleId: userRole.id, permissionId: perm.id },
              defaults: { roleId: userRole.id, permissionId: perm.id } as never,
              transaction,
            });
          }
        }
      }

      await transaction.commit();
      this.logger.log(
        `[SeedService] Permisos procesados (Nuevos: ${createdCount}, Actualizados: ${updatedCount}, Deprecados eliminados: ${deprecatedRows.length})`,
      );
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async ensureSuperAdminUser() {
    try {
      const superAdminRole = await Role.findOne({
        where: { slug: 'superadmin', userId: null },
      });
      if (!superAdminRole) {
        this.logger.warn('[SeedService] Rol superadmin no encontrado para vincular usuario.');
        return;
      }

      const existingSuperAdmin = await Users.findOne({
        where: {
          [Op.or]: [
            { email: 'superadmin@helpcopies.com' },
            { username: 'superadmin' },
          ],
        },
      });

      if (!existingSuperAdmin) {
        const hashedPassword = await Users.hashPassword('superadmin123');
        await Users.create({
          name: 'Super',
          lastName: 'Admin',
          email: 'superadmin@helpcopies.com',
          username: 'superadmin',
          phone: '+54 11 0000-0000',
          password: hashedPassword,
          roleId: superAdminRole.id,
          companyId: null,
          isAdmin: true,
          status: 'ACTIVE',
        });
        this.logger.log(
          '[SeedService] Super Admin global creado: superadmin / superadmin@helpcopies.com (companyId: null)',
        );
      } else {
        if (
          existingSuperAdmin.roleId !== superAdminRole.id ||
          !existingSuperAdmin.isAdmin ||
          existingSuperAdmin.companyId !== null
        ) {
          await existingSuperAdmin.update({
            roleId: superAdminRole.id,
            isAdmin: true,
            companyId: null,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`[SeedService] Error asegurando usuario Super Admin: ${err?.message}`);
    }
  }

  async ensurePlanExchangeConfig(): Promise<void> {
    try {
      const [config, created] = await PlanExchangeConfig.findOrCreate({
        where: { id: 1 },
        defaults: {
          id: 1,
          usdRate: 1250.0,
          roundPrices: true,
          updatedBy: null,
        },
      });
      if (created) {
        this.logger.log(
          '[SeedService] Configuración de cotización base aprovisionada: 1 USD = $1.250 ARS (Redondeo: ON)',
        );
      }
    } catch (err: any) {
      this.logger.warn(`[SeedService] Error asegurando PlanExchangeConfig: ${err?.message}`);
    }
  }

  async seedRoles() {
    await this.ensureSystemRoles();
    return { success: true, message: 'Roles creados exitosamente' };
  }

  async seedUsers() {
    const { enterprisePlan } = await this.ensureDefaultPlans();
    await this.ensureDefaultCompany(enterprisePlan?.id);
    await this.ensureSuperAdminUser();
    await this.ensurePlanExchangeConfig();
    return { success: true, message: 'Usuarios base creados exitosamente' };
  }

  async seedDocumentTypeForms(): Promise<void> {
    try {
      for (const def of DEFAULT_DOCUMENT_FORMS_SEED) {
        const existing = await DocumentTypeForm.findOne({
          where: { companyId: null, code: def.code },
        });
        if (!existing) {
          await DocumentTypeForm.create({
            companyId: null,
            code: def.code,
            label: def.label,
            description: def.description,
            icon: def.icon,
            matchAliases: def.matchAliases,
            sectionsSchema: def.sectionsSchema,
            aiExtractionGuide: def.aiExtractionGuide,
            displayOrder: def.displayOrder,
            version: def.version,
            isActive: true,
          } as any);
        } else if ((existing.version ?? 0) < def.version) {
          await existing.update({
            label: def.label,
            description: def.description,
            icon: def.icon,
            matchAliases: def.matchAliases,
            sectionsSchema: def.sectionsSchema,
            aiExtractionGuide: def.aiExtractionGuide,
            displayOrder: def.displayOrder,
            version: def.version,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`[SeedService] Error sembrando formularios por tipo: ${err?.message}`);
    }
  }

  async seedAll() {
    await this.ensurePlanExchangeConfig();
    const { enterprisePlan } = await this.ensureDefaultPlans();
    await this.ensureDefaultCompany(enterprisePlan?.id);
    await this.ensureSystemRoles();
    await this.seedPermissions();
    await this.seedDocumentTypeForms();
    await this.ensureSuperAdminUser();

    return {
      success: true,
      message: 'Seeds de HC-SCAN ejecutados exitosamente',
    };
  }

  async seed() {
    return await this.seedAll();
  }
}
