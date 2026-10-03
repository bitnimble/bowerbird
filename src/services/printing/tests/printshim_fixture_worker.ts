import type { PrintCommand, PrintshimReply } from '../printshim';

declare const self: {
  onmessage: ((event: MessageEvent<PrintCommand>) => void) | null;
  postMessage: (message: PrintshimReply) => void;
};

const REFUSALS: Record<string, unknown> = {
  'cups:invalid': { ok: false, error: 'not a queue', kind: 'invalid' },
  'cups:missing': { ok: false, error: 'no such queue', kind: 'missing' },
  'cups:unavailable': { ok: false, error: 'the queue is paused', kind: 'unavailable' },
  'cups:unkinded': { ok: false, error: 'the printer is offline' },
};

self.onmessage = ({ data }) => {
  if (data.kind === 'list' || data.kind === 'submit') for (;;);
  if (data.kind === 'capabilities' && data.printer === 'cups:garbled') {
    self.postMessage({ reply: 'not json' });
    return;
  }
  const refusal = data.kind === 'capabilities' ? REFUSALS[data.printer] : undefined;
  self.postMessage({ reply: JSON.stringify(refusal ?? { ok: true, asked: data.kind }) });
};
