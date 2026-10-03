import { ptr } from 'bun:ffi';
import { shim } from '../processing/rawshim/rawshim';
import type { PrintCommand, PrintshimReply } from './printshim';

const REPLY_CAPACITY = 8 * 1024 * 1024;

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
  let reply = new Uint8Array(REPLY_CAPACITY);
  const call = (): number =>
    Number(shim().bb_print_command(bytes, bytes.byteLength, ptr(reply), reply.byteLength));
  let written = call();
  if (written > reply.byteLength) {
    reply = new Uint8Array(written);
    written = call();
  }
  if (written < 0) throw new Error('printshim could not run the command');
  return new TextDecoder().decode(reply.subarray(0, written));
}
