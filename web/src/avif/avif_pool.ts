import { wasiImports } from './wasi';

/** One pool worker's slot in the control words: its state, the thread's id, and its argument. */
const SLOT_WORDS = 3;
const FREE = 0;
const CLAIMED = 1;
const STARTED = 2;

/** What a pool worker is started with. */
export interface PoolStart {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  control: SharedArrayBuffer;
  slot: number;
}

/** How long a spawn waits for a thread that is still returning to free its slot. */
const SPAWN_PATIENCE_MS = 1000;

/**
 * The decoder's threads, as workers started ahead of time.
 *
 * **Handed a thread through shared memory, not a message**, because the thread asking for one is
 * inside the decode and does not return to its event loop until the decode is done: a posted
 * start would sit in the new worker's queue while the decode waited on it forever. So each worker
 * instantiates the module once and then waits on its slot, and `spawn` writes the thread's id and
 * argument there and wakes it.
 */
export class ThreadPool {
  private readonly control: Int32Array<SharedArrayBuffer>;
  private readonly nextId: number;
  private readonly finished: number;

  private constructor(
    private readonly size: number,
    buffer: SharedArrayBuffer,
  ) {
    this.control = new Int32Array(buffer);
    this.nextId = size * SLOT_WORDS;
    this.finished = this.nextId + 1;
    // wasi-libc's own thread is 1, so a spawned one is numbered from 2.
    Atomics.store(this.control, this.nextId, 1);
  }

  static async start(module: WebAssembly.Module, memory: WebAssembly.Memory, size: number): Promise<ThreadPool> {
    const buffer = new SharedArrayBuffer((size * SLOT_WORDS + 2) * Int32Array.BYTES_PER_ELEMENT);
    await Promise.all(
      Array.from({ length: size }, (_, slot) => {
        const worker = new Worker(new URL('./avif_thread.ts', import.meta.url), { type: 'module' });
        return new Promise<void>((resolve, reject) => {
          worker.onmessage = () => resolve();
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ module, memory, control: buffer, slot } satisfies PoolStart);
        });
      }),
    );
    return new ThreadPool(size, buffer);
  }

  /** `wasi.thread-spawn`: a thread id, or a negative number where every worker stays busy. */
  readonly spawn = (arg: number): number => {
    const deadline = performance.now() + SPAWN_PATIENCE_MS;
    for (;;) {
      const seen = Atomics.load(this.control, this.finished);
      for (let slot = 0; slot < this.size; slot++) {
        const state = slot * SLOT_WORDS;
        if (Atomics.compareExchange(this.control, state, FREE, CLAIMED) !== FREE) continue;
        const id = Atomics.add(this.control, this.nextId, 1) + 1;
        Atomics.store(this.control, state + 1, id);
        Atomics.store(this.control, state + 2, arg);
        Atomics.store(this.control, state, STARTED);
        Atomics.notify(this.control, state);
        return id;
      }
      // A decoder closing joins its threads, and a joined thread has yet to leave its worker's loop.
      const left = deadline - performance.now();
      if (left <= 0) return -1;
      Atomics.wait(this.control, this.finished, seen, left);
    }
  };
}

/** A pool worker's loop, which never returns: the worker is that thread for its whole life. */
export async function serveSlot({ module, memory, control: buffer, slot }: PoolStart, ready: () => void): Promise<never> {
  const control = new Int32Array(buffer);
  const state = slot * SLOT_WORDS;
  const finished = control.length - 1;
  const instance = await WebAssembly.instantiate(module, wasiImports(memory, () => -1));
  const start = instance.exports['wasi_thread_start'] as (id: number, arg: number) => void;
  ready();
  for (;;) {
    for (let seen = Atomics.load(control, state); seen !== STARTED; seen = Atomics.load(control, state)) {
      Atomics.wait(control, state, seen);
    }
    try {
      start(Atomics.load(control, state + 1), Atomics.load(control, state + 2));
    } catch (err) {
      console.error('avif_planes: a decoder thread trapped', err);
    }
    Atomics.store(control, state, FREE);
    Atomics.add(control, finished, 1);
    Atomics.notify(control, finished);
  }
}
