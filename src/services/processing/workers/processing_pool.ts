import { Logger } from '../../../logger';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { workerEntry } from '../../worker_entry';
import type { ProcessingResult, RenditionJob } from './processing_types';

const log = new Logger('processing');

interface Batch {
  jobs: RenditionJob[];
  next: number;
  running: number;
  onResult: (result: ProcessingResult, job: RenditionJob) => void;
  stopped?: () => boolean;
  settle: () => void;
}

/** Every batch's jobs, on at most `concurrency()` workers in all, handed out to the batches in turn. */
export class ProcessingPool {
  private batches: Batch[] = [];
  private readonly idle: Worker[] = [];
  private busy = 0;
  private turn = 0;

  constructor(private readonly concurrency: () => number) {}

  /**
   * Settles once every job has landed, or once `stopped` and the jobs in flight have landed.
   * Jobs never started (stopped, or no worker could be spawned) keep their flags for the next sync.
   */
  run(
    jobs: RenditionJob[],
    onResult: (result: ProcessingResult, job: RenditionJob) => void,
    stopped?: () => boolean,
  ): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    return new Promise((settle) => {
      this.batches.push({ jobs, next: 0, running: 0, onResult, stopped, settle });
      this.pump();
    });
  }

  private pump(): void {
    this.settleFinished();
    while (this.busy < this.limit()) {
      const batch = this.nextBatch();
      if (batch == null) break;
      const worker = this.idle.pop() ?? this.spawn();
      if (worker == null) {
        // Nothing in flight would call back in here, so the batches would never settle.
        if (this.busy === 0) this.abandon();
        break;
      }
      this.assign(worker, batch, batch.jobs[batch.next++]!);
    }
    for (const worker of this.idle.splice(0)) worker.terminate();
  }

  private limit(): number {
    const asked = this.concurrency();
    return Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1;
  }

  private settleFinished(): void {
    const finished = this.batches.filter((batch) => batch.running === 0 && !this.owesWork(batch));
    if (finished.length === 0) return;
    this.batches = this.batches.filter((batch) => !finished.includes(batch));
    for (const batch of finished) batch.settle();
  }

  private nextBatch(): Batch | null {
    const count = this.batches.length;
    for (let i = 0; i < count; i++) {
      const index = (this.turn + i) % count;
      const batch = this.batches[index]!;
      if (!this.owesWork(batch)) continue;
      this.turn = index + 1;
      return batch;
    }
    return null;
  }

  // A stop retires each worker as its current job lands rather than killing it
  // mid-encode, which would leave a half-written rendition.
  private owesWork(batch: Batch): boolean {
    return batch.next < batch.jobs.length && batch.stopped?.() !== true;
  }

  private spawn(): Worker | null {
    try {
      return new Worker(
        workerEntry('processing_worker', new URL('./processing_worker.ts', import.meta.url)),
      );
    } catch (err) {
      log.error('could not spawn a worker; its jobs stay pending', { err });
      return null;
    }
  }

  private abandon(): void {
    for (const batch of this.batches) batch.next = batch.jobs.length;
    this.settleFinished();
  }

  private assign(worker: Worker, batch: Batch, job: RenditionJob): void {
    this.busy++;
    batch.running++;
    const landed = (result: ProcessingResult, reusable: Worker | null): void => {
      try {
        batch.onResult(result, job);
      } finally {
        this.busy--;
        batch.running--;
        if (reusable != null) this.idle.push(reusable);
        this.pump();
      }
    };
    worker.onmessage = (event: MessageEvent<ProcessingResult>) => landed(event.data, worker);
    // Bun kills the worker thread after onerror fires, so the worker can't be
    // reused. A native crash (a segfault in libavif, say) skips the worker's own
    // catch, so the in-flight job's partial/stale output is cleaned up here too.
    worker.onerror = (event: ErrorEvent) => {
      for (const target of job.targets) {
        void deleteGeneratedFile(job.dataPath, target.outputPath).catch(() => {});
      }
      worker.terminate();
      landed(
        { photoId: job.photoId, success: false, error: `worker crashed: ${event.message}` },
        null,
      );
    };
    worker.postMessage(job);
  }
}
