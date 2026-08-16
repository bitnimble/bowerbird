/// <reference lib="webworker" />
import init, {
  type Decoded,
  type InitOutput,
  type Tile,
  decodeRaw,
  openGpuDevice,
  prepareRaw,
  renderTile,
} from '../../../../native/rawshim/pkg/rawshim';
import type { Answer, Ask, LocalFrame, LocalTile } from './local_open';

/** The other half of `LocalDecoder`, which says why the module is over here. */

/** The RAW this decoder was given, kept so a tile costs neither a download nor a copy. */
let held: Uint8Array | null = null;
let module: Promise<InitOutput> | null = null;

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<Ask>): Promise<void> => {
  const ask = event.data;
  try {
    const { value, transfer } = await answer(ask);
    worker.postMessage({ id: ask.id, ok: true, value } satisfies Answer, transfer ?? []);
  } catch (error) {
    worker.postMessage({
      id: ask.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Answer);
  }
};

async function answer(ask: Ask): Promise<{ value: unknown; transfer?: Transferable[] }> {
  module ??= init();
  const wasm = await module;
  switch (ask.kind) {
    case 'hold':
      held = ask.raw;
      return { value: null };
    case 'open': {
      const frame = await opened(wasm, ask.atLeastLongEdge);
      return { value: frame, transfer: [frame.samples.buffer] };
    }
    case 'prepare': {
      const prepared = await prepareRaw(raw(), ask.request);
      return { value: prepared, transfer: [prepared.buffer] };
    }
    case 'tile': {
      const tile = await rendered(wasm, ask.request);
      return { value: tile, transfer: [tile.samples.buffer] };
    }
    case 'gpu':
      return { value: await openGpuDevice().then(() => true).catch(() => false) };
  }
}

function raw(): Uint8Array {
  if (held == null) throw new Error('this decoder was given no RAW to read');
  return held;
}

async function opened(wasm: InitOutput, atLeastLongEdge: number): Promise<LocalFrame> {
  let decoded: Decoded | undefined;
  try {
    decoded = await decodeRaw(raw(), atLeastLongEdge);
    const view = new Uint16Array(wasm.memory.buffer, decoded.ptr, decoded.length);
    return {
      width: decoded.width,
      height: decoded.height,
      halved: decoded.halved,
      // Copied, not handed out: the view is over the module's memory, and the next allocation
      // that grows it detaches every view taken before the growth.
      samples: new Uint16Array(view),
    };
  } finally {
    decoded?.free();
  }
}

async function rendered(wasm: InitOutput, request: string): Promise<LocalTile> {
  let tile: Tile | undefined;
  try {
    tile = await renderTile(raw(), request);
    const [left, top, width, height] = tile.keep;
    const [detailWidth, detailHeight] = tile.detail;
    const view = new Uint16Array(wasm.memory.buffer, tile.ptr, tile.length);
    return {
      width: tile.width,
      height: tile.height,
      keep: [left ?? 0, top ?? 0, width ?? 0, height ?? 0],
      edits: [...tile.edits],
      detail: { width: detailWidth ?? 1, height: detailHeight ?? 1 },
      samples: new Uint16Array(view),
    };
  } finally {
    tile?.free();
  }
}
