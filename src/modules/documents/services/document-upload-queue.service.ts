import { Injectable, Logger } from '@nestjs/common';

export interface UploadQueueJobMetadata {
  jobId: string;
  companyId: number;
  userId?: number | null;
  fileName: string;
  source: 'web' | 'ftp' | 'sync';
  enqueuedAt: Date;
}

export interface UploadQueueStatus {
  isProcessing: boolean;
  waitingCount: number;
  activeJob: UploadQueueJobMetadata | null;
  totalProcessed: number;
  totalFailed: number;
}

/**
 * Cola asíncrona estrictamente secuencial (concurrencia: 1) para la ingesta y subida de archivos PDF.
 * Procesa los archivos de 1 en 1 para proteger el CPU, la memoria y evitar la saturación del
 * pool de conexiones a la base de datos PostgreSQL.
 */
@Injectable()
export class DocumentUploadQueueService {
  private readonly logger = new Logger(DocumentUploadQueueService.name);

  // Cadena de ejecución FIFO de 1 en 1
  private queueTail: Promise<unknown> = Promise.resolve();
  private readonly waitingJobs: UploadQueueJobMetadata[] = [];
  private currentActiveJob: UploadQueueJobMetadata | null = null;
  private totalProcessedCount = 0;
  private totalFailedCount = 0;
  private jobCounter = 0;

  /**
   * Encola una tarea de subida/ingesta de archivo garantizando ejecución estrictamente
   * 1 a 1 (concurrency: 1).
   *
   * @param meta Metadatos descriptivos de la tarea (compañía, usuario, nombre de archivo y origen)
   * @param task Función asíncrona que ejecuta la validación, cuota, cifrado, escritura y guardado en BD
   * @returns Promesa con el resultado de task() (resuelve o rechaza a su invocador correspondiente)
   */
  async enqueue<T>(
    meta: {
      companyId: number;
      userId?: number | null;
      fileName: string;
      source?: 'web' | 'ftp' | 'sync';
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const jobId = `upload_${Date.now()}_${++this.jobCounter}`;
    const jobMeta: UploadQueueJobMetadata = {
      jobId,
      companyId: meta.companyId,
      userId: meta.userId ?? null,
      fileName: meta.fileName,
      source: meta.source || 'web',
      enqueuedAt: new Date(),
    };

    this.waitingJobs.push(jobMeta);
    const waitingPosition = this.waitingJobs.length;

    this.logger.log(
      `📥 [Cola 1-en-1] Encolado archivo '${jobMeta.fileName}' (Compañía #${jobMeta.companyId}, origen: ${jobMeta.source}). En cola: ${waitingPosition}`,
    );

    const executeTask = async (): Promise<T> => {
      const idx = this.waitingJobs.findIndex((j) => j.jobId === jobId);
      if (idx >= 0) {
        this.waitingJobs.splice(idx, 1);
      }
      this.currentActiveJob = jobMeta;
      const startTime = Date.now();

      this.logger.log(
        `⚡ [Cola 1-en-1] Procesando (1 en curso): '${jobMeta.fileName}' para Compañía #${jobMeta.companyId}. Restantes en espera: ${this.waitingJobs.length}`,
      );

      try {
        const result = await task();
        const durationMs = Date.now() - startTime;
        this.totalProcessedCount++;
        this.logger.log(
          `✅ [Cola 1-en-1] Archivo procesado exitosamente: '${jobMeta.fileName}' (${durationMs}ms). Total procesados: ${this.totalProcessedCount}`,
        );
        return result;
      } catch (error: any) {
        const durationMs = Date.now() - startTime;
        this.totalFailedCount++;
        this.logger.warn(
          `⚠️ [Cola 1-en-1] Fallo al procesar '${jobMeta.fileName}' (${durationMs}ms): ${error?.message}. Continuando de inmediato con el siguiente archivo...`,
        );
        throw error;
      } finally {
        this.currentActiveJob = null;
      }
    };

    // Encadenamiento seguro de la promesa tail:
    // Asegura que executeTask espere a que la tarea anterior termine (exitosamente o con error)
    const runPromise = this.queueTail.then(executeTask, executeTask);

    // Mantiene la cadena activa capturando cualquier rechazo en el puntero interno
    this.queueTail = runPromise.catch(() => {});

    return runPromise;
  }

  /**
   * Retorna el estado actual de la cola de subidas para métricas y diagnósticos en tiempo real.
   */
  getStatus(): UploadQueueStatus {
    return {
      isProcessing: this.currentActiveJob !== null,
      waitingCount: this.waitingJobs.length,
      activeJob: this.currentActiveJob,
      totalProcessed: this.totalProcessedCount,
      totalFailed: this.totalFailedCount,
    };
  }

  /**
   * Cantidad de archivos esperando turno en la cola.
   */
  getWaitingCount(): number {
    return this.waitingJobs.length;
  }
}
