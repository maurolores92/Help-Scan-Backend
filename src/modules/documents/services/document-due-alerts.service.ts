import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Op } from 'sequelize';
import {
  Document,
  DocumentPaymentStatus,
  DocumentStatus,
} from '../document.model';
import { NotificationsService } from '../../notifications/notifications.service';

const UPCOMING_DUE_WINDOW_DAYS = 3;

/**
 * Job programado diario encargado de alertar sobre comprobantes pendientes o programados
 * que están vencidos o próximos a vencer según su `dueDate`.
 */
@Injectable()
export class DocumentDueAlertsService {
  private readonly logger = new Logger(DocumentDueAlertsService.name);

  constructor(
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async handleDailyDueCheck(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.dispatchUpcomingAndOverdueAlerts();
  }

  async dispatchUpcomingAndOverdueAlerts(
    referenceDate: Date = new Date(),
  ): Promise<{ notifiedCount: number }> {
    const todayIso = referenceDate.toISOString().slice(0, 10);
    const windowLimit = new Date(referenceDate);
    windowLimit.setDate(windowLimit.getDate() + UPCOMING_DUE_WINDOW_DAYS);
    const limitIso = windowLimit.toISOString().slice(0, 10);

    const dueDocs = await this.documentModel.findAll({
      where: {
        status: { [Op.notIn]: [DocumentStatus.REJECTED, DocumentStatus.ERROR] },
        paymentStatus: {
          [Op.in]: [DocumentPaymentStatus.PENDING, DocumentPaymentStatus.SCHEDULED],
        },
        dueDate: {
          [Op.ne]: null,
          [Op.lte]: limitIso,
        },
        dueAlertSentAt: null,
      },
      order: [['dueDate', 'ASC']],
      limit: 200,
    });

    let notifiedCount = 0;

    for (const doc of dueDocs) {
      if (!doc.dueDate) continue;
      const isOverdue = doc.dueDate < todayIso;
      const label = doc.issuerName || doc.originalName;
      const amountPart =
        doc.totalAmount !== null && doc.totalAmount !== undefined
          ? ` (${doc.currency || '$'} ${Number(doc.totalAmount).toLocaleString('es-AR', { minimumFractionDigits: 2 })})`
          : '';

      try {
        await this.notificationsService.dispatch({
          type: 'document.due_alert',
          companyId: doc.companyId,
          targetUserId: doc.userId ?? null,
          title: isOverdue
            ? `⏰ Comprobante vencido (${doc.dueDate})`
            : `📅 Comprobante próximo a vencer (${doc.dueDate})`,
          body: `${label}${doc.documentNumber ? ` #${doc.documentNumber}` : ''}${amountPart} — ${isOverdue ? 'vencido y pendiente de pago.' : 'vence pronto.'}`,
          extraData: {
            documentId: doc.id,
            dueDate: doc.dueDate,
            isOverdue,
            link: '/documents',
          },
        });

        await doc.update({ dueAlertSentAt: referenceDate });
        notifiedCount++;
      } catch (err: any) {
        this.logger.warn(
          `No se pudo enviar alerta de vencimiento para documento #${doc.id}: ${err?.message}`,
        );
      }
    }

    if (notifiedCount > 0) {
      this.logger.log(
        `🔔 Se enviaron ${notifiedCount} alerta(s) de vencimiento de comprobantes.`,
      );
    }

    return { notifiedCount };
  }
}
