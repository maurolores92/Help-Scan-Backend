import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BaseError, UniqueConstraintError, ValidationError } from 'sequelize';
import {
  extractClientIp,
  sanitizeSecurityPayload,
} from '../../modules/security/helpers/security-request.helper';

export interface RecordedBackendException {
  statusCode: number;
  method: string;
  path: string;
  errorCode?: string | null;
  message: string;
  stackTrace?: string | null;
  payload?: Record<string, any> | null;
  userId?: number | null;
  username?: string | null;
  companyId?: number | null;
  ipAddress: string;
  userAgent?: string | null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private static errorRecorder: ((err: RecordedBackendException) => void) | null = null;

  static setErrorRecorder(
    recorder: ((err: RecordedBackendException) => void) | null,
  ): void {
    AllExceptionsFilter.errorRecorder = recorder;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        message = (res as any).message || res;
        if (typeof (res as any).code === 'string') {
          code = (res as any).code;
        }
      }
    } else if (exception instanceof UniqueConstraintError) {
      status = HttpStatus.BAD_REQUEST;
      message = `El registro ya existe. Detalle: ${exception.errors.map((e) => e.message).join(', ')}`;
    } else if (exception instanceof ValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = `Error de validación en la base de datos: ${exception.errors.map((e) => e.message).join(', ')}`;
    } else if (exception instanceof BaseError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      const ex: any = exception;
      const sqlMsg =
        ex.parent?.errors?.[0]?.message ||
        ex.original?.errors?.[0]?.message ||
        ex.parent?.originalError?.message ||
        ex.parent?.message ||
        ex.original?.message ||
        ex.message ||
        'Error desconocido en base de datos';
      this.logger.error(`Database BaseError detail: ${sqlMsg}`);
      message = `Error interno en la base de datos: ${sqlMsg}`;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    this.logger.error(
      `[${request.method}] ${request.url} - Status: ${status} - Message: ${JSON.stringify(message)}`,
    );

    const requestUrl = request.originalUrl || request.url || '';
    if (
      status >= 400 &&
      AllExceptionsFilter.errorRecorder &&
      !requestUrl.includes('/security/client-errors')
    ) {
      try {
        const reqUser = (request as any).user;
        const normalizedMessage = Array.isArray(message)
          ? message.join('; ')
          : typeof message === 'string'
            ? message
            : JSON.stringify(message);

        AllExceptionsFilter.errorRecorder({
          statusCode: status,
          method: (request.method || 'GET').toUpperCase(),
          path: requestUrl,
          errorCode: code || null,
          message: normalizedMessage || 'Error HTTP',
          stackTrace:
            status >= 500 && exception instanceof Error
              ? exception.stack || null
              : null,
          payload: sanitizeSecurityPayload(request.body),
          userId: reqUser?.id ? Number(reqUser.id) : null,
          username: reqUser?.username || reqUser?.email || null,
          companyId:
            reqUser?.companyId !== undefined && reqUser?.companyId !== null
              ? Number(reqUser.companyId)
              : null,
          ipAddress: extractClientIp(request),
          userAgent:
            typeof request.headers?.['user-agent'] === 'string'
              ? request.headers['user-agent']
              : null,
        });
      } catch {
        // Nunca interrumpir la respuesta HTTP por un error en telemetría
      }
    }

    response.status(status).json({
      statusCode: status,
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
