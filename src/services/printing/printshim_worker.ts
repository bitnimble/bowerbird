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
  const { bb_print_command } = openRawshim(SYMBOLS);
  const bytes = Buffer.from(JSON.stringify(command), 'utf8');
  const reply = new Uint8Array(REPLY_CAPACITY);
  const written = Number(bb_print_command(bytes, bytes.byteLength, ptr(reply), reply.byteLength));
  if (written < 0) throw new Error('printshim could not run the command');
  // A second call would run the command again, and for a submit that is a second print.
  if (written > reply.byteLength) throw new Error(`printshim's reply needs ${written} bytes`);
  return new TextDecoder().decode(reply.subarray(0, written));
}
