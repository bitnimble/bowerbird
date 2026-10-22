import { Logger } from '../../../logger';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { workerEntry } from '../../worker_entry';
import type { ProcessingResult, RenditionJob } from './processing_types';
import type { RenderBudget } from './render_budget';

const log = new Logger('processing');

interface Batch {
  jobs: RenditionJob[];
  /** The first job not yet handed out; jobs handed out ahead of it are marked in `taken`. */
  next: number;
  taken: Uint8Array;
  byPhoto: Map<string, number>;
  running: number;
  onResult: (result: ProcessingResult, job: RenditionJob) => void;
  stopped?: () => boolean;
  held?: () => boolean;
  settle: () => void;
}

/** Every batch's jobs, on at most `concurrency()` workers in all, handed out to the batches in turn. */
export class ProcessingPool {
  private batches: Batch[] = [];
  private readonly idle: Worker[] = [];
  private busy = 0;
  private turn = 0;
  private preferred: readonly string[] = [];

  constructor(
    private readonly concurrency: () => number,
    private readonly budget: RenderBudget,
  ) {
    budget.onFreed(() => this.pump());
  }

  /** Jobs for these photos are handed out before any other, earliest first, from any batch. */
  prefer(photoIds: readonly string[]): void {
    this.preferred = photoIds;
  }

  /**
   * Settles once every job has landed, or once `stopped` and the jobs in flight have landed.
   * Jobs never started (stopped, or no worker could be spawned) keep their flags for the next sync.
   * While `held`, no more of its jobs start; call `wake` once it lets go.
   */
  run(
    jobs: RenditionJob[],
    onResult: (result: ProcessingResult, job: RenditionJob) => void,
    stopped?: () => boolean,
    held?: () => boolean,
  ): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    return new Promise((settle) => {
      this.batches.push({
        jobs,
        next: 0,
        taken: new Uint8Array(jobs.length),
        byPhoto: new Map(jobs.map((job, index) => [job.photoId, index])),
        running: 0,
        onResult,
        stopped,
        held,
        settle,
      });
      this.pump();
    });
  }

  wake(): void {
    this.pump();
  }

  private pump(): void {
    this.settleFinished();
    let drained = false;
    while (this.busy < this.limit() && this.budget.hasRoom()) {
      const pick = this.preferredJob() ?? this.nextJob();
      if (pick == null) {
        drained = true;
        break;
      }
      const worker = this.idle.pop() ?? this.spawn();
      if (worker == null) {
        // Nothing in flight would call back in here, so the batches would never settle.
        if (this.busy === 0) this.abandon();
        break;
      }
      this.budget.claim();
      this.assign(worker, pick.batch, this.take(pick.batch, pick.index));
    }
    // Kept while the budget alone holds the queue back, ready for its next job.
    if (drained) for (const worker of this.idle.splice(0)) worker.terminate();
  }

  private preferredJob(): { batch: Batch; index: number } | null {
    for (const photoId of this.preferred) {
      for (const batch of this.batches) {
        if (!this.ready(batch)) continue;
        const index = batch.byPhoto.get(photoId);
        if (index != null && batch.taken[index] === 0) return { batch, index };
      }
    }
    return null;
  }

  private nextJob(): { batch: Batch; index: number } | null {
    const batch = this.nextBatch();
    return batch == null ? null : { batch, index: batch.next };
  }

  private take(batch: Batch, index: number): RenditionJob {
    batch.taken[index] = 1;
    while (batch.next < batch.jobs.length && batch.taken[batch.next] === 1) batch.next++;
    return batch.jobs[index]!;
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
      if (!this.ready(batch)) continue;
      this.turn = index + 1;
      return batch;
    }
    return null;
  }

  private ready(batch: Batch): boolean {
    return this.owesWork(batch) && batch.held?.() !== true;
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
    const posted = performance.now();
    const landed = (result: ProcessingResult, reusable: Worker | null): void => {
      const ran = performance.now();
      try {
        batch.onResult(result, job);
      } finally {
        log.debug('job landed', {
          photo: job.photoId,
          ranMs: Math.round(ran - posted),
          landingMs: Math.round(performance.now() - ran),
        });
        this.busy--;
        batch.running--;
        if (reusable != null) this.idle.push(reusable);
        this.budget.give();
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
