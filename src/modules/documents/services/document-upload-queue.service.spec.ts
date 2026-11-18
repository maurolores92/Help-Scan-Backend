import { DocumentUploadQueueService } from './document-upload-queue.service';

describe('DocumentUploadQueueService', () => {
  let service: DocumentUploadQueueService;

  beforeEach(() => {
    service = new DocumentUploadQueueService();
  });

  it('debe estar definido el servicio de cola de subida', () => {
    expect(service).toBeDefined();
    expect(service.getStatus().waitingCount).toBe(0);
    expect(service.getStatus().isProcessing).toBe(false);
  });

  it('debe procesar tareas estrictamente de 1 en 1 (concurrencia 1)', async () => {
    const executionOrder: number[] = [];
    let concurrentRunning = 0;
    let maxObservedConcurrency = 0;

    const makeTask = (id: number, delayMs: number) => async () => {
      concurrentRunning++;
      if (concurrentRunning > maxObservedConcurrency) {
        maxObservedConcurrency = concurrentRunning;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));

      executionOrder.push(id);
      concurrentRunning--;
      return `result-${id}`;
    };

    // Lanzar 4 tareas en paralelo al mismo tiempo
    const [res1, res2, res3, res4] = await Promise.all([
      service.enqueue({ companyId: 1, fileName: 'doc1.pdf' }, makeTask(1, 40)),
      service.enqueue({ companyId: 1, fileName: 'doc2.pdf' }, makeTask(2, 20)),
      service.enqueue({ companyId: 1, fileName: 'doc3.pdf' }, makeTask(3, 10)),
      service.enqueue({ companyId: 1, fileName: 'doc4.pdf' }, makeTask(4, 5)),
    ]);

    // Verificaciones
    expect(res1).toBe('result-1');
    expect(res2).toBe('result-2');
    expect(res3).toBe('result-3');
    expect(res4).toBe('result-4');

    // La concurrencia máxima jamás debió superar 1
    expect(maxObservedConcurrency).toBe(1);

    // El orden de ejecución debe ser estrictamente FIFO (1, 2, 3, 4)
    expect(executionOrder).toEqual([1, 2, 3, 4]);

    const status = service.getStatus();
    expect(status.totalProcessed).toBe(4);
    expect(status.totalFailed).toBe(0);
    expect(status.waitingCount).toBe(0);
    expect(status.isProcessing).toBe(false);
  });

  it('debe continuar de inmediato con el siguiente trabajo si uno falla (resiliencia)', async () => {
    const taskFail = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      throw new Error('Error al validar archivo duplicado o cuota');
    };

    const taskSuccess = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'ok-doc2';
    };

    const p1 = service.enqueue({ companyId: 2, fileName: 'falla.pdf' }, taskFail);
    const p2 = service.enqueue({ companyId: 2, fileName: 'exito.pdf' }, taskSuccess);

    await expect(p1).rejects.toThrow('Error al validar archivo duplicado o cuota');
    const result2 = await p2;

    expect(result2).toBe('ok-doc2');
    const status = service.getStatus();
    expect(status.totalProcessed).toBe(1);
    expect(status.totalFailed).toBe(1);
    expect(status.waitingCount).toBe(0);
  });

  it('debe reflejar el estado en tiempo real durante la ejecución', async () => {
    let checkStateDuringExecution: boolean | null = null;

    const slowTask = async () => {
      checkStateDuringExecution = service.getStatus().isProcessing;
      expect(service.getWaitingCount()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'done';
    };

    const secondTask = async () => 'done2';

    const p1 = service.enqueue({ companyId: 3, fileName: 'lento.pdf' }, slowTask);
    const p2 = service.enqueue({ companyId: 3, fileName: 'rapido.pdf' }, secondTask);

    await Promise.all([p1, p2]);

    expect(checkStateDuringExecution).toBe(true);
    expect(service.getStatus().isProcessing).toBe(false);
  });
});
