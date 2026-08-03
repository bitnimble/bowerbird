/*
 * Replacement for wasm-bindgen-rayon's workerHelpers.js.
 *
 * Pool workers are nested under whatever called initThreadPool (the editor daemon).
 * The daemon stays free of decode/grade, so it can exitThreadPool and terminate these
 * workers on leave without waiting on a blocked editor.
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
    postMessage({ type: 'wasm_bindgen_worker_done' });
  });
}

/** Held on the daemon so kill can terminate them after exitThreadPool. */
export async function startWorkers(module, memory, builder) {
  const workers = [];
  const n = builder.numThreads();
  for (let i = 0; i < n; i++) {
    const worker = new Worker(new URL('./rayon_worker_helpers.js', import.meta.url), {
      type: 'module',
      name: 'wasm_bindgen_worker',
    });
    workers.push(worker);
    worker.postMessage({
      type: 'wasm_bindgen_worker_init',
      init: { module, memory },
      receiver: builder.receiver(),
    });
    await waitForMsgType(worker, 'wasm_bindgen_worker_ready');
  }
  self.__rayonPoolWorkers = workers;
  self.__rawshimModule = module;
  builder.build();
  self.__rayonPoolBuilt = true;
}
