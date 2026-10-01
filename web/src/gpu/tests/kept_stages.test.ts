import { describe, expect, test } from 'bun:test';
import { KeptStages } from '../kept_stages';

const KEY = 7;

function kept(): { stages: KeptStages<string>; freed: string[] } {
  const freed: string[] = [];
  return { stages: new KeptStages<string>((stage) => freed.push(stage)), freed };
}

describe('a stage kept for the next photo', () => {
  test('is handed to the next open that asks', async () => {
    const { stages, freed } = kept();
    stages.keep(KEY, 'a');
    expect(await stages.take(KEY)).toBe('a');
    expect(freed).toEqual([]);
  });

  test('still held by an open, is handed over once that open keeps it, in the order asked', async () => {
    const { stages } = kept();
    const first = stages.take(KEY);
    const second = stages.take(KEY);
    stages.keep(KEY, 'a');
    expect(await first).toBe('a');
    stages.keep(KEY, 'b');
    expect(await second).toBe('b');
  });

  test('replaces one kept earlier, which is freed', async () => {
    const { stages, freed } = kept();
    stages.keep(KEY, 'a');
    stages.keep(KEY, 'b');
    expect(freed).toEqual(['a']);
    expect(await stages.take(KEY)).toBe('b');
  });

  test('is freed when the visit ends, and the opens waiting get none', async () => {
    const { stages, freed } = kept();
    stages.keep(KEY, 'a');
    stages.drop(KEY);
    expect(freed).toEqual(['a']);
    expect(await stages.take(KEY)).toBeNull();

    const late = kept();
    const waiting = late.stages.take(KEY);
    late.stages.drop(KEY);
    expect(await waiting).toBeNull();
  });

  test('closed after the visit ended, is freed rather than kept', () => {
    const { stages, freed } = kept();
    stages.drop(KEY);
    stages.keep(KEY, 'a');
    expect(freed).toEqual(['a']);
  });

  test('never arriving after the device is lost, wakes every open waiting with none', async () => {
    const { stages } = kept();
    const waiting = [stages.take(KEY), stages.take(KEY + 1)];
    stages.abandon();
    expect(await Promise.all(waiting)).toEqual([null, null]);
    expect(await stages.take(KEY)).toBeNull();
  });
});
