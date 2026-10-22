import { Logger } from '../../../logger';
import { extractMetadata, type HeaderMetadata } from './metadata';
import type { HeaderReply, HeaderRequest } from './header_worker';
import { workerEntry } from '../../worker_entry';

const log = new Logger('header-pool');

// How long a thread waits for another file before it goes. Longer than the gap between two
// reads of one selection by any margin that matters, and short enough that a server which has
// finished reading is not holding threads.
const IDLE_MS = 2000;

interface Waiting {
  absPath: string;
  settle: (reply: HeaderReply) => void;
}

/**
 * `extractMetadata` on worker threads.
 *
 * The threads live only as long as there is work: spawned on the first read and retired
 * when the last one lands, so an idle server holds none.
 */
export class HeaderPool {
  private readonly queue: Waiting[] = [];
  private readonly idle: Worker[] = [];
  private busy = 0;
  private retiring: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly concurrency: () => number) {}

  read = (absPath: string): Promise<HeaderMetadata> =>
    new Promise<HeaderMetadata>((resolve, reject) => {
      this.queue.push({
        absPath,
        settle: (reply) =>
          'error' in reply ? reject(new Error(reply.error)) : resolve(reply.metadata),
      });
      this.pump();
    });

  private limit(): number {
    const asked = this.concurrency();
    return Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1;
  }

  private pump(): void {
    if (this.retiring != null) {
      clearTimeout(this.retiring);
      this.retiring = null;
    }
    while (this.queue.length > 0) {
      // Full: whichever reply lands next calls back in here.
      if (this.idle.length === 0 && this.busy >= this.limit()) return;
      const worker = this.idle.pop() ?? this.spawn();
      const waiting = this.queue.shift()!;
      if (worker == null) this.readHere(waiting);
      else this.assign(worker, waiting);
    }
    // **On a timer, not on the queue running dry.** A selection's refresh asks for the next
    // file only once it has been handed the last one's result, so between every pair of files
    // the queue is empty and nothing is in flight - and retiring on that spawns a thread per
    // photograph.
    if (this.busy === 0 && this.queue.length === 0) {
      this.retiring = setTimeout(() => {
        this.retiring = null;
        this.retireIfDone();
      }, IDLE_MS);
      this.retiring.unref?.();
    }
  }

  private assign(worker: Worker, waiting: Waiting): void {
    this.busy++;
    let settled = false;
    // A worker that posts its reply and then dies would otherwise be counted back in
    // twice, and `busy` never recovers from going negative.
    const done = (reply: HeaderReply): void => {
      if (settled) return;
      settled = true;
      this.busy--;
      waiting.settle(reply);
    };
    worker.onmessage = (event: MessageEvent<HeaderReply>) => {
      done(event.data);
      this.idle.push(worker);
      this.pump();
    };
    // Bun kills the thread once this fires, so the worker cannot be reused. A native
    // crash skips the worker's own catch and arrives here instead.
    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      done({ error: `header worker crashed: ${event.message}` });
      this.pump();
    };
    const request: HeaderRequest = { absPath: waiting.absPath };
    worker.postMessage(request);
  }

  private spawn(): Worker | null {
    try {
      return new Worker(
        workerEntry('header_worker', new URL('./header_worker.ts', import.meta.url)),
      );
    } catch (err) {
      log.error('could not spawn a header worker; reading on the main thread instead', { err });
      return null;
    }
  }

  private readHere(waiting: Waiting): void {
    this.busy++;
    void extractMetadata(waiting.absPath)
      .then((metadata) => waiting.settle({ metadata }))
      .catch((err: unknown) => waiting.settle({ error: (err as Error).message }))
      .finally(() => {
        this.busy--;
        this.pump();
      });
  }

  private retireIfDone(): void {
    if (this.busy > 0 || this.queue.length > 0) return;
    for (const worker of this.idle.splice(0)) worker.terminate();
  }
}
