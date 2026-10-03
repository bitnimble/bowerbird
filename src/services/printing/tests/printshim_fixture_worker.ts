import type { PrintCommand, PrintshimReply } from '../printshim';

declare const self: {
  onmessage: ((event: MessageEvent<PrintCommand>) => void) | null;
  postMessage: (message: PrintshimReply) => void;
};

self.onmessage = ({ data }) => {
  if (data.kind === 'list') for (;;);
  self.postMessage({ reply: JSON.stringify({ ok: true, outcome: { asked: data.kind } }) });
};
