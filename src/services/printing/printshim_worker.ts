import { FFIType, ptr } from 'bun:ffi';
import { openRawshim } from '../processing/rawshim/rawshim';
import type { PrintCommand, PrintshimReply } from './printshim';

const REPLY_CAPACITY = 8 * 1024 * 1024;

const SYMBOLS = {
  bb_print_command: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
} as const;

declare const self: {
  onmessage: ((event: MessageEvent<PrintCommand>) => void) | null;
  postMessage: (message: PrintshimReply) => void;
};

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ reply: printCommand(data) });
  } catch (err) {
    self.postMessage({ failed: err instanceof Error ? err.message : String(err) });
  }
};

function printCommand(command: PrintCommand): string {
  const bytes = Buffer.from(JSON.stringify(command), 'utf8');
  const first = call(bytes, REPLY_CAPACITY);
  if (typeof first === 'string') return first;
  // Running a submit again would print it again.
  if (command.kind === 'submit') throw new Error(`printshim's reply needs ${first} bytes`);
  const second = call(bytes, first);
  if (typeof second === 'string') return second;
  throw new Error(`printshim's reply needs ${second} bytes`);
}

/** The reply, or the size it needs where `capacity` is too small. */
function call(command: Uint8Array, capacity: number): string | number {
  const { bb_print_command } = openRawshim(SYMBOLS);
  const reply = new Uint8Array(capacity);
  const written = Number(bb_print_command(command, command.byteLength, ptr(reply), capacity));
  if (written < 0) throw new Error('printshim could not run the command');
  if (written > capacity) return written;
  return new TextDecoder().decode(reply.subarray(0, written));
}
