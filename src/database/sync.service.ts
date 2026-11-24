import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { SeedService } from '../modules/seeders/seeders.service';
import { ensureTenantDirectories } from '../common/utils/storage-path.util';

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly seedService: SeedService,
  ) { }

  async onModuleInit() {
    const isForceSync = process.env.DB_FORCE_SYNC === 'true';
    const models = this.sequelize.models;

    const syncOrder = [
      'Plan',
      'PlanExchangeConfig',
      'Company',
      'FtpDevice',
      'CompanyMonthlyUsage',
      'Role',
      'Users',
      'Permission',
      'RolePermission',
      'UserPermission',
      'AuditLog',
      'Notification',
      'NotificationPreference',
      'PushSubscription',
      'Document',
      'CompanyEmailChannel',
      'EmailMessage',
      'CompanyWhatsappChannel',
      'WhatsappMessage',
      'CompanyTelegramChannel',
      'TelegramMessage',
      'DemoRequest',
    ];

    if (isForceSync) {
      this.logger.warn(
        'DB_FORCE_SYNC=true: Eliminando tablas para recrear esquemas limpios de HC-SCAN...',
      );
      for (const modelName of [...syncOrder].reverse()) {
        const model = models[modelName];
        if (model) {
          try {
            await model.drop({ cascade: true });
          } catch { }
        }
      }
    }

    this.logger.log('Sincronizando modelos de HC-SCAN...');
    for (const modelName of syncOrder) {
      const model = models[modelName];
      if (model) {
        await model.sync();
      }
    }

    await this.ensurePlanSchemaColumns();
    await this.ensureDocumentSchemaColumns();
    await this.ensureWhatsappSchemaColumns();
    await this.ensureIndexes();

    try {
      await this.seedService.seedAll();
      this.logger.log('Semillas de HC-SCAN sincronizadas exitosamente.');
    } catch (error: any) {
      this.logger.error('Error al ejecutar semillas iniciales:', error.message);
    }

    await this.sanitizeMultitenantDataIsolation();
    await this.provisionTenantStorageDirectories();

    this.logger.log('🚀 Base de datos HC-SCAN sincronizada y lista para operar.');
  }

  private async ensurePlanSchemaColumns() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS "plan_exchange_config" (
        "id" SERIAL PRIMARY KEY,
        "usd_rate" DECIMAL(10, 2) NOT NULL DEFAULT 1250.00,
        "round_prices" BOOLEAN NOT NULL DEFAULT TRUE,
        "updated_by" INTEGER,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );`,
      `INSERT INTO "plan_exchange_config" ("id", "usd_rate", "round_prices", "updated_by", "created_at", "updated_at")
       VALUES (1, 1250.00, TRUE, NULL, NOW(), NOW())
       ON CONFLICT ("id") DO NOTHING;`,
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) DEFAULT 'USD';`,
      `ALTER TABLE "plans" ALTER COLUMN "currency" SET DEFAULT 'USD';`,
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "is_trial" BOOLEAN NOT NULL DEFAULT FALSE;`,
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "trial_days" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_pages" INTEGER DEFAULT 1000;`,
      `UPDATE "plans" SET "max_pages" = "max_documents" WHERE "max_pages" IS NULL AND "max_documents" IS NOT NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "plan_id" INTEGER REFERENCES "plans"("id") ON DELETE SET NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "is_trial" BOOLEAN NOT NULL DEFAULT FALSE;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "use_custom_limits" BOOLEAN NOT NULL DEFAULT FALSE;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "max_pages" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "total_pages_uploaded" INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "max_documents" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "max_storage_mb" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "max_ai_queries_monthly" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "companies" ALTER COLUMN "max_users" DROP NOT NULL;`,
      `ALTER TABLE "company_monthly_usages" ADD COLUMN IF NOT EXISTS "pages_count" INTEGER NOT NULL DEFAULT 0;`,
    ];

    for (const sql of statements) {
      try {
        await this.sequelize.query(sql);
      } catch { }
    }
  }

  private async ensureDocumentSchemaColumns() {
    const statements = [
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_type" VARCHAR(80) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "summary" TEXT DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_number" VARCHAR(120) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_date" DATE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "issuer_name" VARCHAR(220) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "issuer_tax_id" VARCHAR(50) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "recipient_name" VARCHAR(220) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "responsible_person" VARCHAR(180) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "total_amount" DECIMAL(15, 2) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tags" JSONB DEFAULT '[]'::jsonb;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "items" JSONB DEFAULT '[]'::jsonb;`,
      `ALTER TABLE "documents" ALTER COLUMN "extracted_data" TYPE JSONB USING "extracted_data"::jsonb;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "raw_text" TEXT DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "page_count" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ai_confidence" REAL DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "extraction_engine" VARCHAR(40) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "processed_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ftp_device_id" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ftp_device_name" VARCHAR(120) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "due_date" DATE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "recipient_tax_id" VARCHAR(50) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "recipient_phone" VARCHAR(50) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "recipient_email" VARCHAR(100) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "delivery_address" VARCHAR(255) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "net_amount" DECIMAL(15, 2) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tax_amount" DECIMAL(15, 2) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "payment_terms" VARCHAR(150) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "payment_method" VARCHAR(60) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reference_number" VARCHAR(100) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "cae" VARCHAR(30) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tax_condition" VARCHAR(60) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_letter" VARCHAR(5) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "point_of_sale" VARCHAR(10) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "cae_due_date" DATE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "purchase_order_number" VARCHAR(100) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "exempt_amount" DECIMAL(15, 2) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "other_taxes_amount" DECIMAL(15, 2) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "carrier_name" VARCHAR(150) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "department" VARCHAR(100) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "branch" VARCHAR(100) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "period" VARCHAR(50) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "validated_by_user_id" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "validated_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "validation_notes" TEXT DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_email_id" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "payment_status" VARCHAR(25) NOT NULL DEFAULT 'PENDING';`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "paid_at" DATE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "payment_reference" VARCHAR(150) DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "due_alert_sent_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "duplicate_of_document_id" INTEGER DEFAULT NULL;`,
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "validation_warnings" JSONB DEFAULT '[]'::jsonb;`,
    ];

    for (const sql of statements) {
      try {
        await this.sequelize.query(sql);
      } catch { }
    }
  }

  private async ensureWhatsappSchemaColumns() {
    const statements = [
      `DROP INDEX IF EXISTS "idx_whatsapp_channels_phone_number_id";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "phone_number_id";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "waba_id";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "display_phone_number";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "verified_name";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "encrypted_access_token";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "encrypted_app_secret";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "verify_token";`,
      `ALTER TABLE "company_whatsapp_channels" DROP COLUMN IF EXISTS "last_webhook_at";`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "session_key" VARCHAR(80) DEFAULT '';`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "connection_status" VARCHAR(30) NOT NULL DEFAULT 'DISCONNECTED';`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "connected_phone" VARCHAR(40) DEFAULT NULL;`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "connected_name" VARCHAR(150) DEFAULT NULL;`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "ignore_groups" BOOLEAN NOT NULL DEFAULT TRUE;`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "last_qr_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "company_whatsapp_channels" ADD COLUMN IF NOT EXISTS "last_message_at" TIMESTAMP WITH TIME ZONE DEFAULT NULL;`,
      `ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "reply_jid" VARCHAR(120) DEFAULT NULL;`,
      `ALTER TABLE "company_email_channels" ADD COLUMN IF NOT EXISTS "webhook_secret" VARCHAR(120) DEFAULT NULL;`,
    ];

    for (const sql of statements) {
      try {
        await this.sequelize.query(sql);
      } catch { }
    }
  }

  private async ensureIndexes() {
    const singleColumnIndexes = [
      { table: 'plans', name: 'idx_plans_slug', column: 'slug' },
      { table: 'companies', name: 'idx_companies_slug', column: 'slug' },
      { table: 'companies', name: 'idx_companies_plan_id', column: 'plan_id' },
      { table: 'company_monthly_usages', name: 'idx_company_monthly_usages_company_id', column: 'company_id' },
      { table: 'users', name: 'idx_users_company_id', column: 'company_id' },
      { table: 'users', name: 'idx_users_email', column: 'email' },
      { table: 'roles', name: 'idx_roles_company_id', column: 'company_id' },
      { table: 'audits', name: 'idx_audits_company_id', column: 'company_id' },
      { table: 'audits', name: 'idx_audits_user_id', column: 'user_id' },
      { table: 'notifications', name: 'idx_notifications_company_id', column: 'company_id' },
      { table: 'notifications', name: 'idx_notifications_user_id', column: 'user_id' },
      { table: 'documents', name: 'idx_documents_company_id', column: 'company_id' },
      { table: 'documents', name: 'idx_documents_status', column: 'status' },
      { table: 'documents', name: 'idx_documents_file_hash', column: 'file_hash' },
      { table: 'documents', name: 'idx_documents_purchase_order_number', column: 'purchase_order_number' },
      { table: 'documents', name: 'idx_documents_department', column: 'department' },
      { table: 'documents', name: 'idx_documents_recipient_tax_id', column: 'recipient_tax_id' },
      { table: 'documents', name: 'idx_documents_due_date', column: 'due_date' },
      { table: 'documents', name: 'idx_documents_payment_status', column: 'payment_status' },
      { table: 'documents', name: 'idx_documents_issuer_tax_id', column: 'issuer_tax_id' },
      { table: 'ftp_devices', name: 'idx_ftp_devices_company_id', column: 'company_id' },
      { table: 'ftp_devices', name: 'idx_ftp_devices_status', column: 'status' },
      { table: 'company_email_channels', name: 'idx_email_channels_company_id', column: 'company_id' },
      { table: 'email_messages', name: 'idx_email_messages_company_id', column: 'company_id' },
      { table: 'email_messages', name: 'idx_email_messages_status', column: 'status' },
      { table: 'email_messages', name: 'idx_email_messages_message_id', column: 'message_id' },
      { table: 'company_whatsapp_channels', name: 'idx_whatsapp_channels_company_id', column: 'company_id' },
      { table: 'whatsapp_messages', name: 'idx_whatsapp_messages_company_id', column: 'company_id' },
      { table: 'whatsapp_messages', name: 'idx_whatsapp_messages_status', column: 'status' },
      { table: 'whatsapp_messages', name: 'idx_whatsapp_messages_external_id', column: 'external_message_id' },
      { table: 'company_telegram_channels', name: 'idx_telegram_channels_company_id', column: 'company_id' },
      { table: 'telegram_messages', name: 'idx_telegram_messages_company_id', column: 'company_id' },
      { table: 'telegram_messages', name: 'idx_telegram_messages_status', column: 'status' },
      { table: 'telegram_messages', name: 'idx_telegram_messages_external_id', column: 'external_message_id' },
      { table: 'demo_requests', name: 'idx_demo_requests_status', column: 'status' },
      { table: 'demo_requests', name: 'idx_demo_requests_created_at', column: 'created_at' },
    ];

    for (const idx of singleColumnIndexes) {
      try {
        await this.sequelize.query(
          `CREATE INDEX IF NOT EXISTS "${idx.name}" ON "${idx.table}" ("${idx.column}");`,
        );
      } catch { }
    }

    const advancedDocumentIndexes = [
      `CREATE INDEX IF NOT EXISTS "idx_documents_company_type" ON "documents" ("company_id", "document_type");`,
      `CREATE INDEX IF NOT EXISTS "idx_documents_company_date" ON "documents" ("company_id", "document_date");`,
      `CREATE INDEX IF NOT EXISTS "idx_documents_extracted_data_gin" ON "documents" USING GIN ("extracted_data");`,
      `CREATE INDEX IF NOT EXISTS "idx_documents_fts_spanish" ON "documents" USING GIN (to_tsvector('spanish', coalesce("raw_text", '') || ' ' || coalesce("summary", '')));`,
    ];

    for (const sql of advancedDocumentIndexes) {
      try {
        await this.sequelize.query(sql);
      } catch { }
    }
  }

  private async sanitizeMultitenantDataIsolation() {
    const cleanupQueries = [
      // El Super Admin global nunca debe pertenecer a una compañía tenant específica
      `UPDATE "users" SET "company_id" = NULL WHERE LOWER("username") = 'superadmin' OR "role_id" IN (SELECT "id" FROM "roles" WHERE "slug" = 'superadmin');`,
      // Limpiar company_id residual en auditorías de entidades globales de plataforma
      `UPDATE "audits" SET "company_id" = NULL WHERE LOWER("entity") IN ('plan', 'plans', 'permission', 'permissions', 'demorequest');`,
      // Purgar cualquier notificación cruzada recibida por usuarios de otra compañía
      `DELETE FROM "notifications" n USING "users" u WHERE n."user_id" = u."id" AND u."company_id" IS NOT NULL AND n."company_id" IS NOT NULL AND n."company_id" <> u."company_id";`,
      `DELETE FROM "notifications" n USING "users" u WHERE n."user_id" = u."id" AND u."company_id" IS NOT NULL AND n."type" = 'system.company_created';`,
    ];

    for (const sql of cleanupQueries) {
      try {
        await this.sequelize.query(sql);
      } catch { }
    }
  }

  private async provisionTenantStorageDirectories() {
    try {
      const companyModel = this.sequelize.models['Company'];
      if (!companyModel) return;
      const companies = await companyModel.findAll({ attributes: ['id', 'name', 'slug'], raw: true });
      for (const comp of companies as unknown as Array<{ id: number; name?: string; slug?: string }>) {
        ensureTenantDirectories(comp.id, comp.slug || comp.name);
      }
      this.logger.log(
        `📁 Directorios storage/tenancy/company_<id>_<slug>/{inbox,vault,quarantine} listos para ${companies.length} compañía(s).`,
      );
    } catch (error: any) {
      this.logger.warn(`No se pudieron aprovisionar directorios de storage: ${error?.message}`);
    }
  }
}
