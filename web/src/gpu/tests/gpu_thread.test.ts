import { expect, test } from 'bun:test';
import { z } from 'zod';
import { GpuThread } from '../gpu_thread';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  readonly posted: { id: number }[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: { id: number }): void {
    this.posted.push(message);
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
    const [first, second] = worker.posted;

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
