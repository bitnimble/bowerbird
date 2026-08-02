// The WASI syscalls wasi-libc references, stubbed for a browser.
//
// rawshim's wasm build links wasi-libc for malloc, memcpy and the C++ runtime LibRaw
// needs. That drags in libc's file and environment layer as *imports*, whether or not
// anything calls it - and nothing here does: the RAW is opened with `libraw_open_buffer`,
// so no path is ever resolved and no descriptor ever opened.
//
// So these exist to satisfy the linker's import list rather than to work. Each returns
// ENOSYS, which is what a caller would have to handle anyway; the two that could
// plausibly fire do something useful instead. If a stub other than those two ever runs,
// something reached for the filesystem and the right fix is upstream of here, not a real
// implementation in this file.

/** `errno` for "function not supported" in WASI. */
const ENOSYS = 52;

const decoder = new TextDecoder();

/** LibRaw prints diagnostics to stderr; send them somewhere a developer can see. */
export function fd_write(fd: number, iovs: number, iovsLen: number, written: number): number {
  const memory = view();
  if (memory == null) return ENOSYS;
  let total = 0;
  const text: string[] = [];
  for (let i = 0; i < iovsLen; i++) {
    const base = memory.getUint32(iovs + i * 8, true);
    const length = memory.getUint32(iovs + i * 8 + 4, true);
    text.push(decoder.decode(new Uint8Array(memory.buffer, base, length)));
    total += length;
  }
  memory.setUint32(written, total, true);
  const message = text.join('');
  // eslint-disable-next-line no-console
  if (message.trim() !== '') console.warn(`[rawshim fd ${fd}]`, message.trimEnd());
  return 0;
}

/** Reached only if the C side aborts, which a panic hook would not catch. */
export function proc_exit(code: number): never {
  throw new Error(`rawshim called proc_exit(${code}) - the C side aborted`);
}

export const environ_get = (): number => 0;
export const environ_sizes_get = (count: number, size: number): number => {
  const memory = view();
  if (memory == null) return ENOSYS;
  memory.setUint32(count, 0, true);
  memory.setUint32(size, 0, true);
  return 0;
};

export const fd_close = (): number => ENOSYS;
export const fd_fdstat_get = (): number => ENOSYS;
export const fd_fdstat_set_flags = (): number => ENOSYS;
export const fd_prestat_dir_name = (): number => ENOSYS;
export const fd_prestat_get = (): number => ENOSYS;
export const fd_read = (): number => ENOSYS;
export const fd_seek = (): number => ENOSYS;
export const path_filestat_get = (): number => ENOSYS;
export const path_open = (): number => ENOSYS;

// The module's memory, published by the worker once wasm-bindgen has instantiated it.
// A getter rather than an import because the stubs are linked *into* that instantiation
// and cannot import from it.
let memory: WebAssembly.Memory | null = null;

export function useMemory(instance: WebAssembly.Memory): void {
  memory = instance;
}

function view(): DataView | null {
  return memory == null ? null : new DataView(memory.buffer);
}
