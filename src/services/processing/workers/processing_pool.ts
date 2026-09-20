import { Logger } from '../../../logger';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { workerEntry } from '../../worker_entry';
import type { ProcessingResult, RenditionJob } from './processing_types';

const log = new Logger('processing');

export function runProcessingPool(
  jobs: RenditionJob[],
  concurrency: number,
  onResult: (result: ProcessingResult, job: RenditionJob) => void,
  stopped?: () => boolean,
): Promise<void> {
  const poolSize = Math.min(concurrency, jobs.length);
  return new Promise((resolve) => {
    let next = 0;
    let live = 0;

    // Returns false if the worker couldn't be spawned (e.g. OS thread
    // exhaustion when several libraries process at once). Callers leave the
    // unstarted jobs pending (their flags stay set) for the next sync.
    const launch = (): boolean => {
      let worker: Worker;
      try {
        worker = new Worker(workerEntry('processing_worker', new URL('./processing_worker.ts', import.meta.url)));
      } catch (err) {
        log.error('could not spawn a worker; its jobs stay pending', { err });
        return false;
      }
      live++;
      let current: RenditionJob | undefined;

      const assignNext = (): void => {
        // A stop retires each worker as its current job lands rather than
        // killing it mid-encode, which would leave a half-written rendition.
        if (next >= jobs.length || stopped?.() === true) {
          worker.terminate();
          live--;
          if (live === 0) resolve();
          return;
        }
        current = jobs[next++];
        worker.postMessage(current);
      };

      worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
        if (current != null) onResult(event.data, current);
        assignNext();
      };
      // Bun kills the worker thread after onerror fires, so the worker can't be
      // reused. A native crash (a segfault in libavif, say) skips the worker's own
      // catch, so clean up the in-flight job's partial/stale output here too,
      // record the failure, drop this worker, and launch a replacement.
      worker.onerror = (event: ErrorEvent) => {
        if (current != null) {
          for (const target of current.targets) {
            void deleteGeneratedFile(current.dataPath, target.outputPath).catch(() => {});
          }
          onResult({ photoId: current.photoId, success: false, error: `worker crashed: ${event.message}` }, current);
        }
        worker.terminate();
        live--;
        if (next < jobs.length && stopped?.() !== true && launch()) return;
        if (live === 0) resolve();
      };

      assignNext();
      return true;
    };

    if (!(poolSize > 0)) {
      resolve();
      return;
    }
    let started = 0;
    for (let i = 0; i < poolSize; i++) if (launch()) started++;
    if (started === 0) resolve();
  });
}
