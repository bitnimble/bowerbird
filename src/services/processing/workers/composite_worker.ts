import { AppError } from '../../../errors';
import { workerEntry } from '../../worker_entry';
import type { ProcessingResult, WorkerJob } from './processing_types';

/**
 * Somewhere to run a panorama's jobs, so the several a merge is made of can share one device.
 *
 * Closed by whoever opened it, and on every path: the worker holds a GPU device until it is.
 */
export interface CompositeWorker {
  /**
   * One job, after whatever is already queued on this worker. Answers what an align answered.
   *
   * Any job, not only a panorama's: the far side dispatches on `kind`, and a merge has one that
   * is not - the fit of a lens nothing has measured, which it needs before it can align
   * (`measureCameraMatch`). Sending that to a worker of its own would open a second device and
   * compile the shader modules again, which is the half second this exists to pay once.
   */
  run(job: WorkerJob): Promise<string | undefined>;
  /** Whether its thread is gone, after which every job it is given is refused. */
  crashed(): boolean;
  close(): void;
}

export function openCompositeWorker(): CompositeWorker {
  const worker = new Worker(workerEntry('processing_worker', new URL('./processing_worker.ts', import.meta.url)));
  // A worker that crashed is not a worker any more - the thread is gone, and a job posted to it
  // would wait for an answer nobody is left to send.
  let crashed: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const post = (job: WorkerJob): Promise<string | undefined> =>
    new Promise<string | undefined>((resolve, reject) => {
      if (crashed != null) return reject(new Error(`worker crashed: ${crashed}`));
      worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
        if (event.data.success) resolve(event.data.composite);
        else reject(new AppError('VALIDATION_ERROR', event.data.error));
      };
      worker.onerror = (event: ErrorEvent) => {
        crashed = event.message;
        reject(new Error(`worker crashed: ${event.message}`));
      };
      worker.postMessage(job);
    });

  return {
    run: (job) => {
      // Chained rather than concurrent, and the chain survives a failure: one job's error is
      // the caller's to handle, not a reason the next cannot be posted.
      const answer = queue.then(() => post(job));
      queue = answer.then(
        () => undefined,
        () => undefined,
      );
      return answer;
    },
    crashed: () => crashed != null,
    close: () => worker.terminate(),
  };
}
