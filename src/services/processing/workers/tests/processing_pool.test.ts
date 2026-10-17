import { describe, expect, test } from 'bun:test';
import {
  built,
  CRASH,
  posted,
  usingMockWorker,
} from '../../pipeline/tests/processing_test_helpers';
import { ProcessingPool } from '../processing_pool';
import type { RenditionJob } from '../processing_types';
import { RenderBudget } from '../render_budget';

usingMockWorker();

function jobs(...photoIds: string[]): RenditionJob[] {
  return photoIds.map(
    (photoId) => ({ kind: 'rendition', photoId, targets: [] }) as unknown as RenditionJob,
  );
}

describe('ProcessingPool.prefer', () => {
  test('a preferred job jumps the queue mid-batch, once, and the batch still settles', async () => {
    const pool = new ProcessingPool(() => 1, new RenderBudget(1));
    const landed: string[] = [];
    const run = pool.run(jobs('a', 'b', 'c', 'd', 'e'), (result) => landed.push(result.photoId));
    // `a` is already on the worker; `zz` is in no batch.
    pool.prefer(['a', 'zz', 'd']);
    await run;

    expect(posted.map((job) => job.photoId)).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(landed.toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('preference reaches across batches, ahead of round-robin', async () => {
    const pool = new ProcessingPool(() => 1, new RenderBudget(1));
    const first = pool.run(jobs('a', 'b', 'c'), () => {});
    const second = pool.run(jobs('x', 'y', 'z'), () => {});
    pool.prefer(['z', 'c']);
    await Promise.all([first, second]);

    expect(posted.map((job) => job.photoId)).toEqual(['a', 'z', 'c', 'x', 'b', 'y']);
  });
});

describe('RenderBudget', () => {
  test('on-demand renders wait for a slot newest first, ahead of the queue', async () => {
    const budget = new RenderBudget(1);
    await budget.take();
    const started: string[] = [];
    const older = budget.take().then(() => started.push('older'));
    const newer = budget.take().then(() => started.push('newer'));
    const run = new ProcessingPool(() => 4, budget).run(jobs('a'), () => {});
    expect(posted).toHaveLength(0);

    budget.give();
    await newer;
    budget.give();
    await older;
    expect(started).toEqual(['newer', 'older']);
    expect(posted).toHaveLength(0);

    budget.give();
    await run;
    expect(posted.map((job) => job.photoId)).toEqual(['a']);
  });

  test('a worker that crashes gives its slot back to the jobs behind it', async () => {
    const landed: string[] = [];
    await new ProcessingPool(() => 1, new RenderBudget(1)).run(jobs(CRASH, 'b'), (result) =>
      landed.push(result.photoId),
    );

    expect(posted.map((job) => job.photoId)).toEqual([CRASH, 'b']);
    expect(landed).toContain('b');
  });

  test('the queue runs no more at once than the budget allows', async () => {
    const pool = new ProcessingPool(() => 4, new RenderBudget(2));
    await pool.run(jobs('a', 'b', 'c', 'd', 'e'), () => {});

    expect(built).toHaveLength(2);
  });
});
