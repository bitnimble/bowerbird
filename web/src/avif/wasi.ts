// The WASI `native/avif_planes` imports, which is a clock, randomness, a console and a way to start
// a thread: no files, no arguments and no environment.

const ESUCCESS = 0;
const CLOCK_REALTIME = 0;
const MAX_RANDOM_BYTES = 65536;

export function wasiImports(memory: WebAssembly.Memory, spawn: (arg: number) => number): WebAssembly.Imports {
  // Re-read on every call: a grown memory hands out a new buffer object.
  const view = (): DataView => new DataView(memory.buffer);
  const console = new ConsoleLines();
  return {
    env: { memory },
    wasi: { 'thread-spawn': spawn },
    wasi_snapshot_preview1: {
      environ_sizes_get(count: number, size: number): number {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return ESUCCESS;
      },
      environ_get: (): number => ESUCCESS,
      clock_time_get(id: number, _precision: bigint, out: number): number {
        const millis = id === CLOCK_REALTIME ? Date.now() : performance.timeOrigin + performance.now();
        view().setBigUint64(out, BigInt(Math.round(millis * 1e6)), true);
        return ESUCCESS;
      },
      random_get(at: number, length: number): number {
        // `getRandomValues` refuses a view of shared memory, so the bytes go through one of its own.
        for (let done = 0; done < length; done += MAX_RANDOM_BYTES) {
          const chunk = crypto.getRandomValues(new Uint8Array(Math.min(MAX_RANDOM_BYTES, length - done)));
          new Uint8Array(memory.buffer, at + done, chunk.length).set(chunk);
        }
        return ESUCCESS;
      },
      fd_write(_fd: number, iovs: number, count: number, written: number): number {
        let total = 0;
        for (let at = 0; at < count; at++) {
          const base = view().getUint32(iovs + at * 8, true);
          const length = view().getUint32(iovs + at * 8 + 4, true);
          console.write(new Uint8Array(memory.buffer, base, length).slice());
          total += length;
        }
        view().setUint32(written, total, true);
        return ESUCCESS;
      },
      proc_exit(code: number): never {
        throw new Error(`the AVIF decoder exited with ${code}`);
      },
      sched_yield: (): number => ESUCCESS,
    },
  };
}

/** What the decoder prints, a line at a time: a panic's message arrives in several writes. */
class ConsoleLines {
  private readonly decoder = new TextDecoder();
  private pending = '';

  write(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) console.warn(`avif_planes: ${line}`);
  }
}
