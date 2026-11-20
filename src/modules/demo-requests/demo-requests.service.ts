import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as nodemailer from 'nodemailer';
import { CreateDemoRequestDto } from './dto/create-demo-request.dto';
import { QueryDemoRequestDto } from './dto/query-demo-request.dto';
import { UpdateDemoRequestStatusDto } from './dto/update-demo-request-status.dto';
import { DemoRequest, DemoRequestStatus } from './demo-request.model';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.model';

export interface DemoMailEnvConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
}

/**
 * Servicio para persistir y enviar por SMTP las solicitudes de demostración recibidas
 * desde la landing web pública, y gestionarlas exclusivamente desde el Super Admin.
 */
@Injectable()
export class DemoRequestsService {
  private readonly logger = new Logger(DemoRequestsService.name);

  constructor(
    @InjectModel(DemoRequest)
    private readonly demoRequestModel: typeof DemoRequest,
    private readonly auditService: AuditService,
  ) { }

  /**
   * Lee y normaliza la configuración SMTP y destinatario desde variables de entorno.
   */
  getMailConfig(): DemoMailEnvConfig {
    const host = (process.env.SMTP_HOST || '').trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const secureEnv = (process.env.SMTP_SECURE || '').trim().toLowerCase();
    // El puerto 465 exige TLS implícito (secure: true); 587 usa STARTTLS (secure: false).
    const secure = port === 465 ? true : port === 587 ? false : secureEnv === 'true';
    const user = (process.env.SMTP_USER || '').trim();
    const pass = (process.env.SMTP_PASS || '').trim();
    const fromName = (process.env.SMTP_FROM_NAME || 'Help Scan Web').trim();
    const fromEmail = (process.env.SMTP_FROM_EMAIL || user).trim();
    const toEmail = (process.env.DEMO_REQUEST_TO_EMAIL || '').trim();

    return {
      host,
      port,
      secure,
      user,
      pass,
      fromName,
      fromEmail,
      toEmail,
    };
  }

  /**
   * Guarda la solicitud en base de datos y envía el correo por SMTP al destinatario configurado.
   */
  async sendDemoRequest(
    dto: CreateDemoRequestDto,
  ): Promise<{ ok: true; id: number; message: string }> {
    const managementSystem =
      (dto.managementSystem || dto.scannersCount || '').trim() || null;

    const savedRequest = await this.demoRequestModel.create({
      fullName: dto.fullName.trim(),
      companyName: dto.companyName.trim(),
      email: dto.email.trim().toLowerCase(),
      phone: dto.phone?.trim() || null,
      managementSystem,
      selectedDemo: dto.selectedDemo?.trim() || null,
      message: dto.message?.trim() || null,
      source: dto.source || 'demo_modal',
      status: DemoRequestStatus.RECIBIDO,
      emailSent: false,
    });

    const config = this.getMailConfig();

    if (!config.host || !config.user || !config.pass || !config.toEmail) {
      this.logger.warn(
        `Solicitud de demostración #${savedRequest.id} guardada en DB, pero faltan variables SMTP_HOST/SMTP_USER/SMTP_PASS/DEMO_REQUEST_TO_EMAIL.`,
      );
      throw new ServiceUnavailableException(
        'El servicio de correo saliente aún no está configurado en el servidor. Configurá SMTP_HOST, SMTP_USER, SMTP_PASS y DEMO_REQUEST_TO_EMAIL.',
      );
    }

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    const subjectDemoSuffix = dto.selectedDemo ? ` — ${dto.selectedDemo}` : '';
    const subject = `Nueva solicitud de demostración: ${dto.companyName}${subjectDemoSuffix}`;

    const html = this.buildHtmlBody(dto);
    const text = this.buildTextBody(dto);

    try {
      await transporter.sendMail({
        from: `"${config.fromName}" <${config.fromEmail}>`,
        to: config.toEmail,
        replyTo: dto.email,
        subject,
        text,
        html,
      });

      await savedRequest.update({ emailSent: true });

      this.logger.log(
        `Solicitud de demostración #${savedRequest.id} enviada para "${dto.companyName}" (${dto.email}) hacia ${config.toEmail}.`,
      );

      return {
        ok: true,
        id: savedRequest.id,
        message: 'Solicitud de demostración enviada correctamente.',
      };
    } catch (error: any) {
      this.logger.error(
        `Error al enviar correo de solicitud de demostración #${savedRequest.id} por SMTP (${config.host}:${config.port}): ${error?.message || error}`,
      );
      throw new ServiceUnavailableException(
        'No pudimos enviar el correo en este momento. Verificá la configuración SMTP o intentá nuevamente en unos minutos.',
      );
    }
  }

  /**
   * Lista todas las solicitudes de demo para el panel exclusivo del Super Admin.
   */
  async findAll(query: QueryDemoRequestDto = {}) {
    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { fullName: { [Op.iLike]: term } },
        { companyName: { [Op.iLike]: term } },
        { email: { [Op.iLike]: term } },
        { phone: { [Op.iLike]: term } },
        { managementSystem: { [Op.iLike]: term } },
        { selectedDemo: { [Op.iLike]: term } },
        { message: { [Op.iLike]: term } },
      ];
    }

    const rows = await this.demoRequestModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });

    const allRows =
      query.status || query.search?.trim()
        ? await this.demoRequestModel.findAll({ attributes: ['status'], raw: true })
        : rows.map((r) => ({ status: r.status }));

    const counts: Record<string, number> = {
      ALL: allRows.length,
      [DemoRequestStatus.RECIBIDO]: 0,
      [DemoRequestStatus.CONTACTADO]: 0,
      [DemoRequestStatus.INTERESADO]: 0,
      [DemoRequestStatus.VENDIDO]: 0,
      [DemoRequestStatus.RECHAZADO]: 0,
    };

    for (const item of allRows) {
      const st = item.status || DemoRequestStatus.RECIBIDO;
      counts[st] = (counts[st] || 0) + 1;
    }

    return {
      data: rows,
      total: rows.length,
      counts,
    };
  }

  /**
   * Actualiza el estado comercial (y notas opcionales) de una solicitud de demo.
   */
  async updateStatus(
    id: number,
    dto: UpdateDemoRequestStatusDto,
    actorUserId: number,
  ): Promise<DemoRequest> {
    const record = await this.demoRequestModel.findByPk(id);
    if (!record) {
      throw new NotFoundException(`Solicitud de demo #${id} no encontrada.`);
    }

    const previousStatus = record.status;
    await record.update({
      status: dto.status,
      ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
    });

    await this.auditService.log({
      action: AuditAction.STATUS_CHANGE,
      entity: 'DemoRequest',
      entityId: record.id,
      userId: actorUserId,
      companyId: null,
      payload: {
        companyName: record.companyName,
        email: record.email,
        previousStatus,
        newStatus: record.status,
      },
    });

    return record;
  }

  /**
   * Elimina una solicitud de demo (por ejemplo, envíos de prueba o spam).
   */
  async remove(id: number, actorUserId: number): Promise<{ deleted: true; id: number }> {
    const record = await this.demoRequestModel.findByPk(id);
    if (!record) {
      throw new NotFoundException(`Solicitud de demo #${id} no encontrada.`);
    }

    const snapshot = {
      id: record.id,
      fullName: record.fullName,
      companyName: record.companyName,
      email: record.email,
      status: record.status,
    };

    await record.destroy();

    await this.auditService.log({
      action: AuditAction.DELETE,
      entity: 'DemoRequest',
      entityId: id,
      userId: actorUserId,
      companyId: null,
      payload: snapshot,
    });

    return { deleted: true, id };
  }

  private escapeHtml(value?: string): string {
    if (!value) return '';
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildTextBody(dto: CreateDemoRequestDto): string {
    const managementSystem = dto.managementSystem || dto.scannersCount || 'No especificado';
    const lines = [
      'Nueva solicitud de demostración - Help Scan (HelpCopies SRL)',
      '================================================================',
      dto.selectedDemo ? `Demo de interés: ${dto.selectedDemo}` : null,
      `Nombre y Apellido: ${dto.fullName}`,
      `Empresa / Razón Social: ${dto.companyName}`,
      `Correo Electrónico: ${dto.email}`,
      `Teléfono / WhatsApp: ${dto.phone || 'No especificado'}`,
      `Sistema de Gestión: ${managementSystem}`,
      `Origen del formulario: ${dto.source === 'contact_section' ? 'Sección Contacto Web' : 'Modal Solicitud de Demo'}`,
      '',
      'Mensaje / Consulta:',
      dto.message || 'Sin mensaje adicional.',
    ];

    return lines.filter((l) => l !== null).join('\n');
  }

  private buildHtmlBody(dto: CreateDemoRequestDto): string {
    const safeName = this.escapeHtml(dto.fullName);
    const safeCompany = this.escapeHtml(dto.companyName);
    const safeEmail = this.escapeHtml(dto.email);
    const safePhone = this.escapeHtml(dto.phone || 'No especificado');
    const safeManagementSystem = this.escapeHtml(
      dto.managementSystem || dto.scannersCount || 'No especificado',
    );
    const safeDemo = this.escapeHtml(dto.selectedDemo);
    const safeMessage = this.escapeHtml(dto.message || 'Sin mensaje adicional.').replace(/\n/g, '<br />');
    const originLabel =
      dto.source === 'contact_section' ? 'Formulario de Contacto Web' : 'Modal de Solicitud de Demostración';

    return `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 620px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
        <div style="background: linear-gradient(135deg, #32a048 0%, #257a36 100%); padding: 22px 26px; color: #ffffff;">
          <h2 style="margin: 0; font-size: 20px;">Nueva Solicitud de Demostración — Help Scan</h2>
          <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.92;">Recibida desde la landing web de HelpCopies SRL</p>
        </div>
        <div style="padding: 24px 26px; color: #0f172a;">
          ${safeDemo
        ? `<div style="margin-bottom: 16px; padding: 10px 14px; border-radius: 8px; background-color: #ecfdf5; border: 1px solid #86efac; color: #166534; font-size: 13px; font-weight: 700;">Demo seleccionada: ${safeDemo}</div>`
        : ''
      }
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; width: 185px; font-weight: 600;">Nombre y Apellido:</td>
              <td style="padding: 8px 0; font-weight: 700;">${safeName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Empresa / Razón Social:</td>
              <td style="padding: 8px 0; font-weight: 700;">${safeCompany}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Correo Electrónico:</td>
              <td style="padding: 8px 0;"><a href="mailto:${safeEmail}" style="color: #0284c7; font-weight: 600;">${safeEmail}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Teléfono / WhatsApp:</td>
              <td style="padding: 8px 0;">${safePhone}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Sistema de Gestión:</td>
              <td style="padding: 8px 0;">${safeManagementSystem}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Origen:</td>
              <td style="padding: 8px 0;">${originLabel}</td>
            </tr>
          </table>
          <div style="margin-top: 18px; padding: 14px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 6px;">Mensaje / Consulta</div>
            <div style="font-size: 14px; line-height: 1.55; color: #1e293b;">${safeMessage}</div>
          </div>
          <p style="margin-top: 18px; font-size: 12px; color: #64748b;">
            Podés responder directamente a este correo para contactar a ${safeName} (${safeEmail}).
          </p>
        </div>
      </div>
    `;
  }
}
