import { describe, expect, test } from 'bun:test';
import { posted, usingMockWorker } from '../../pipeline/tests/processing_test_helpers';
import { ProcessingPool } from '../processing_pool';
import type { RenditionJob } from '../processing_types';

usingMockWorker();

function jobs(...photoIds: string[]): RenditionJob[] {
  return photoIds.map(
    (photoId) => ({ kind: 'rendition', photoId, targets: [] }) as unknown as RenditionJob,
  );
}

describe('ProcessingPool.prefer', () => {
  test('a preferred job jumps the queue mid-batch, once, and the batch still settles', async () => {
    const pool = new ProcessingPool(() => 1);
    const landed: string[] = [];
    const run = pool.run(jobs('a', 'b', 'c', 'd', 'e'), (result) => landed.push(result.photoId));
    // `a` is already on the worker; `zz` is in no batch.
    pool.prefer(['a', 'zz', 'd']);
    await run;

    expect(posted.map((job) => job.photoId)).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(landed.toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('preference reaches across batches, ahead of round-robin', async () => {
    const pool = new ProcessingPool(() => 1);
    const first = pool.run(jobs('a', 'b', 'c'), () => {});
    const second = pool.run(jobs('x', 'y', 'z'), () => {});
    pool.prefer(['z', 'c']);
    await Promise.all([first, second]);

    expect(posted.map((job) => job.photoId)).toEqual(['a', 'z', 'c', 'x', 'b', 'y']);
  });
});
