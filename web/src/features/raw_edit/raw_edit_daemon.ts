/// <reference lib="webworker" />
/**
 * Owns wasm SharedArrayBuffer memory and the rayon ThreadPool. Forwards open/grade to
 * the editor worker without awaiting them, so kill can run immediately: exitThreadPool,
 * wait for pool workers to leave run(), then release the SAB.
 */
import { describe } from '../../errors';
import init, { exitThreadPool, initThreadPool, thread_count } from '../../wasm/rawshim';
import { useMemory } from './wasi_stub';
import type { FromWorker, ToWorker } from './raw_edit_worker';

export type ToDaemon = ToWorker | { type: 'kill' };

export type FromDaemon = FromWorker | { type: 'killDone' };

type DaemonScope = DedicatedWorkerGlobalScope & {
  __rayonPoolWorkers?: Worker[];
  __rayonPoolBuilt?: boolean;
  __rawshimModule?: WebAssembly.Module;
};

const scope = self as unknown as DaemonScope;

const post = (message: FromDaemon, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

let editor: Worker | null = null;
let killed = false;

const booted = boot();

void booted.catch((error: unknown) => {
  post({ type: 'failed', message: describe(error) });
});

async function boot(): Promise<void> {
  const instance = await init();
  useMemory(instance.memory);
  const requested = Math.max(1, navigator.hardwareConcurrency);
  await initThreadPool(requested);
  if (killed) return;

  const module = scope.__rawshimModule;
  if (module == null) throw new Error('rayon startWorkers did not publish the wasm module');

  const channel = new MessageChannel();

  editor = new Worker(new URL('./raw_edit_worker.ts', import.meta.url), {
    type: 'module',
    name: 'raw_edit_editor',
  });
  editor.onerror = (event) => {
    post({ type: 'failed', message: event.message || 'editor worker error' });
  };

  await new Promise<void>((resolve, reject) => {
    const onMessage = ({ data }: MessageEvent<{ type?: string; message?: string }>): void => {
      if (data?.type === 'booted') {
        editor?.removeEventListener('message', onMessage);
        resolve();
        return;
      }
      if (data?.type === 'failed') {
        editor?.removeEventListener('message', onMessage);
        reject(new Error(data.message ?? 'editor boot failed'));
      }
    };
    editor?.addEventListener('message', onMessage);
    editor?.postMessage(
      { type: 'boot', module, memory: instance.memory, resultPort: channel.port2 },
      [channel.port2],
    );
  });

  if (killed) {
    editor.terminate();
    editor = null;
    channel.port1.close();
    return;
  }

  post({ type: 'ready', threads: thread_count() }, [channel.port1]);
}

function waitPoolDone(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = ({ data }: MessageEvent<{ type?: string }>): void => {
      if (data?.type !== 'wasm_bindgen_worker_done') return;
      worker.removeEventListener('message', onMessage);
      resolve();
    };
    worker.addEventListener('message', onMessage);
  });
}

async function kill(): Promise<void> {
  if (killed) {
    post({ type: 'killDone' });
    return;
  }
  killed = true;

  // Editor first: it may be mid with_pool; drop the pool only after it cannot inject work.
  editor?.terminate();
  editor = null;

  // Finish or fail boot so startWorkers has published the full pool list (or none).
  await booted.catch(() => undefined);

  const pool = scope.__rayonPoolWorkers ?? [];
  scope.__rayonPoolWorkers = [];

  if (scope.__rayonPoolBuilt) {
    const exited = pool.map((worker) => waitPoolDone(worker));
    exitThreadPool();
    await Promise.all(exited);
  }

  // Idle (post-done) or never entered main_loop (pre-build): safe to reap.
  for (const worker of pool) worker.terminate();
  post({ type: 'killDone' });
}

scope.onmessage = ({ data }: MessageEvent<ToDaemon>): void => {
  if (data.type === 'kill') {
    void kill();
    return;
  }
  if (killed) return;
  void booted.then(() => {
    if (killed || editor == null) return;
    if (data.type === 'open') {
      editor.postMessage(data, [data.bytes]);
      return;
    }
    editor.postMessage(data);
  });
};
