import { expect, test } from 'bun:test';
import { z } from 'zod';
import { GpuThread } from '../gpu_thread';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  readonly posted: { id: number; to: unknown }[] = [];
  readonly sent: unknown[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
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

test('a lost device waits for what is unsaved, reloads, and the next worker splits its sites', async () => {
  const real = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const held = new Map<string, string>();
    const storage = (): Pick<Storage, 'getItem' | 'setItem'> => ({
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        held.set(key, value);
      },
    });
    const happened: string[] = [];
    const thread = new GpuThread(() => happened.push('reloaded'), storage);
    let release: () => void = () => {};
    thread.beforeReload(
      () =>
        new Promise((resolve) => {
          release = () => {
            happened.push('flushed');
            resolve();
          };
        }),
    );
    FakeWorker.last!.reply({ lost: 'hung', submitted: ['gpu.rs:10', 'gpu.rs:10'] });
    await Bun.sleep(0);
    expect(happened).toEqual([]);
    release();
    await Bun.sleep(0);
    expect(happened).toEqual(['flushed', 'reloaded']);

    new GpuThread(() => {}, storage);
    const start = FakeWorker.last!.sent.find(
      (message) => typeof message === 'object' && message != null && 'splitBands' in message,
    );
    expect(start).toMatchObject({ to: 'start', splitBands: ['gpu.rs:10'] });
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
