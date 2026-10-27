import { expect, test } from 'bun:test';
import { GpuLosses } from '../gpu_losses';

class MemoryStorage {
  readonly held = new Map<string, string>();
  full = false;

  getItem(key: string): string | null {
    return this.held.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.full) throw new Error('QuotaExceededError');
    this.held.set(key, value);
  }
}

const MINUTE = 60_000;

test('a page reloads for 3 losses in 10 minutes and carries every site to the next', () => {
  const storage = new MemoryStorage();
  expect(new GpuLosses(() => storage).record(['gpu.rs:10', 'gpu.rs:10', 'base.rs:20'], 0)).toBe(
    true,
  );
  expect(new GpuLosses(() => storage).record(['gpu.rs:10'], MINUTE)).toBe(true);
  expect(new GpuLosses(() => storage).record(['fit.rs:30'], 2 * MINUTE)).toBe(true);
  expect(new GpuLosses(() => storage).record(['fit.rs:30'], 3 * MINUTE)).toBe(false);
  expect(new GpuLosses(() => storage).sites()).toEqual([
    'gpu.rs:10',
    'base.rs:20',
    'gpu.rs:10',
    'fit.rs:30',
    'fit.rs:30',
  ]);
});

test('a loss older than 10 minutes no longer counts against the budget', () => {
  const storage = new MemoryStorage();
  const losses = new GpuLosses(() => storage);
  for (const at of [0, MINUTE, 2 * MINUTE]) losses.record(['gpu.rs:10'], at);
  expect(losses.record(['gpu.rs:10'], 10 * MINUTE + 1)).toBe(true);
});

test('a loss that cannot be recorded does not reload', () => {
  const storage = new MemoryStorage();
  storage.full = true;
  expect(new GpuLosses(() => storage).record(['gpu.rs:10'], 0)).toBe(false);
});

test('blocked storage neither reloads nor throws', () => {
  const losses = new GpuLosses(() => {
    throw new Error('SecurityError');
  });
  expect(losses.sites()).toEqual([]);
  expect(losses.record(['gpu.rs:10'], 0)).toBe(false);
});

test('unreadable storage reads as no losses', () => {
  const storage = new MemoryStorage();
  storage.held.set('bowerbird.gpuLosses', '{"at": "yesterday"}');
  expect(new GpuLosses(() => storage).sites()).toEqual([]);
});
