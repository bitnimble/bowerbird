import { z } from 'zod';
import type { OpenStage } from '../features/raw_edit/local_decode/local_open';
import { pageLog } from '../features/logs/page_log';
import { MessageSchema, ReplySchema, type Addressed } from './gpu_protocol';

/**
 * The app's GPU, on a thread of its own: one worker for the life of the page, holding the wasm
 * module and the one device everything draws with - the viewer's canvases, the editor, the print
 * mockup and the renditions this device builds.
 *
 * **Every open on it is seconds of unyielding wasm**, so none of it may run where the page draws: a
 * 61MP open measured eight seconds in one task, which froze the page from the moment the panel
 * mounted until the frame arrived.
 */
export class GpuThread {
  private readonly worker = pageLog.adopted(
    new Worker(new URL('./gpu_worker.ts', import.meta.url), { type: 'module' }),
  );
  private readonly waiting = new Map<
    number,
    {
      session: number | null;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      onStage: (stage: OpenStage) => void;
      onCompiled: (compiled: number, of: number) => void;
    }
  >();
  private asked = 0;
  private opened = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      const answer = ReplySchema.parse(event.data);
      const waiter = this.waiting.get(answer.id);
      if (waiter == null) return;
      if ('stage' in answer) {
        waiter.onStage(answer.stage);
        return;
      }
      if ('compiled' in answer) {
        waiter.onCompiled(answer.compiled, answer.of);
        return;
      }
      this.waiting.delete(answer.id);
      if (answer.ok) waiter.resolve(answer.value);
      else waiter.reject(new Error(answer.error));
    };
    this.worker.onerror = (event) => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error(event.message));
      this.waiting.clear();
    };
  }

  /** A number for one open's state on the worker, which {@link close} frees. */
  open(): number {
    return ++this.opened;
  }

  /**
   * Frees an open's state, refusing whatever it still has in flight. Its stage is kept under
   * `keepStage` for the next open's `adoptStage`.
   */
  close(session: number, why: Error, keepStage: number | null): void {
    for (const [id, waiter] of this.waiting) {
      if (waiter.session !== session) continue;
      this.waiting.delete(id);
      waiter.reject(why);
    }
    this.worker.postMessage(
      MessageSchema.parse({ id: ++this.asked, to: 'close', session, keepStage }),
    );
  }

  /**
   * Begins an edit visit, whose opens keep their stage under the key answered and whose prepares
   * let their buffers go for the next to take, until {@link dropSurface}.
   */
  keepSurface(): number {
    const key = ++this.opened;
    this.worker.postMessage(MessageSchema.parse({ id: ++this.asked, to: 'keepSurface', key }));
    return key;
  }

  /** Ends an edit visit: its stage is freed, and so is any closed open's kept under it later. */
  dropSurface(key: number): void {
    this.worker.postMessage(MessageSchema.parse({ id: ++this.asked, to: 'dropSurface', key }));
  }

  /** A pipeline the browser refuses still counts towards `compiled`. */
  async precompile(onCompiled: (compiled: number, of: number) => void): Promise<void> {
    await this.send(z.null(), { to: 'precompile' }, [], () => {}, onCompiled);
  }

  ask<S extends z.ZodType>(
    schema: S,
    message: Addressed,
    transfer: Transferable[] = [],
    onStage: (stage: OpenStage) => void = () => {},
  ): Promise<z.output<S>> {
    return this.send(schema, message, transfer, onStage, () => {});
  }

  private send<S extends z.ZodType>(
    schema: S,
    message: Addressed,
    transfer: Transferable[],
    onStage: (stage: OpenStage) => void,
    onCompiled: (compiled: number, of: number) => void,
  ): Promise<z.output<S>> {
    const id = ++this.asked;
    return new Promise<z.output<S>>((resolve, reject) => {
      this.waiting.set(id, {
        session: 'session' in message ? message.session : null,
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (parsed.success) resolve(parsed.data);
          else reject(parsed.error);
        },
        reject,
        onStage,
        onCompiled,
      });
      this.worker.postMessage(MessageSchema.parse({ ...message, id }), transfer);
    });
  }
}

let started: GpuThread | null = null;

/** The one GPU thread, started on first use - which `main.tsx` makes the app's boot. */
export function gpuThread(): GpuThread {
  started ??= new GpuThread();
  return started;
}
