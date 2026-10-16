import { expect, test } from 'bun:test';
import { z } from 'zod';
import { GpuThread } from '../gpu_thread';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  readonly posted: { id: number; to: unknown }[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: unknown): void {
    if (typeof message !== 'object' || message == null || !('id' in message)) return;
    const to = 'to' in message ? message.to : null;
    if (typeof message.id === 'number') this.posted.push({ id: message.id, to });
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

test('a stage reaches the ask it belongs to, ahead of its answer', async () => {
  const real = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const thread = new GpuThread();
    const worker = FakeWorker.last!;
    const session = thread.open();
    const heard: string[][] = [[], []];
    const asks = [0, 1].map((which) =>
      thread.ask(z.string(), { to: 'open', session, ask: { kind: 'analysis' } }, [], (stage) =>
        heard[which]!.push(stage),
      ),
    );
    // First, ahead of anything that waits on the device, which waits on recipes read through it.
    expect(worker.posted[0]?.to).toBe('start');
    const [first, second] = worker.posted.filter((message) => message.to === 'open');

    worker.reply({ id: second!.id, stage: 'decoding' });
    worker.reply({ id: second!.id, stage: 'matching' });
    worker.reply({ id: first!.id, stage: 'demosaicing' });
    worker.reply({ id: second!.id, ok: true, value: 'second' });
    worker.reply({ id: first!.id, ok: true, value: 'first' });
    // A stage after its answer has nobody left to tell.
    worker.reply({ id: first!.id, stage: 'correcting' });

    expect(await Promise.all(asks)).toEqual(['first', 'second']);
    expect(heard).toEqual([['demosaicing'], ['decoding', 'matching']]);
  } finally {
    globalThis.Worker = real;
  }
});

test('a precompile hears every background compile, from the count before it asked', async () => {
  const real = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const thread = new GpuThread();
    const worker = FakeWorker.last!;
    worker.reply({ compiled: 3, of: 40 });
    const counted: [number, number][] = [];
    const precompiling = thread.precompile((compiled, of) => counted.push([compiled, of]));
    worker.reply({ compiled: 4, of: 40 });
    const asked = worker.posted.find((message) => message.to === 'precompile');
    worker.reply({ id: asked!.id, ok: true, value: null });
    await precompiling;
    worker.reply({ compiled: 5, of: 40 });

    expect(counted).toEqual([
      [3, 40],
      [4, 40],
    ]);
  } finally {
    globalThis.Worker = real;
  }
});
