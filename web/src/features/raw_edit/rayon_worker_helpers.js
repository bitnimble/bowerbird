/*
 * Replacement for wasm-bindgen-rayon's workerHelpers.js.
 *
 * Same pool-worker bootstrap, but startWorkers asks the page to spawn the pool
 * as document-owned workers. Nested workers cannot be terminated from the page
 * while the editor worker is blocked in wasm, and Chromium then leaves them
 * spinning after a bare parent terminate(). Workers the presenter holds can
 * be killed immediately on leave, together with the editor worker, which also
 * drops the SharedArrayBuffer backing the wasm heap.
 */

function waitForMsgType(target, type) {
  return new Promise((resolve) => {
    target.addEventListener('message', function onMsg({ data }) {
      if (data?.type !== type) return;
      target.removeEventListener('message', onMsg);
      resolve(data);
    });
  });
}

import { initSync, wbg_rayon_start_worker } from '../../wasm/rawshim';

if (typeof name !== 'undefined' && name === 'wasm_bindgen_worker') {
  waitForMsgType(self, 'wasm_bindgen_worker_init').then((data) => {
    initSync(data.init);
    postMessage({ type: 'wasm_bindgen_worker_ready' });
    wbg_rayon_start_worker(data.receiver);
    // Pool drop (exitThreadPool) returns from run(); tell the page before terminate.
    postMessage({ type: 'wasm_bindgen_worker_done' });
  });
}

export async function startWorkers(module, memory, builder) {
  self.postMessage({
    type: 'rayonSpawn',
    module,
    memory,
    receiver: builder.receiver(),
    numThreads: builder.numThreads(),
  });
  await waitForMsgType(self, 'rayonSpawned');
  builder.build();
}
