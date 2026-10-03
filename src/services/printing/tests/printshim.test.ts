import { describe, expect, test } from 'bun:test';
import { printshimWorkers } from '../printshim';

const run = printshimWorkers(new URL('./printshim_fixture_worker.ts', import.meta.url));

describe('printshimWorkers', () => {
  test('a command that never returns times out without holding up the next one', async () => {
    const stuck = expect(run({ kind: 'list' }, 300)).rejects.toThrow(
      'the printer did not answer in 300 ms',
    );
    expect(await run({ kind: 'capabilities', printer: 'cups:PRO-200' }, 5000)).toEqual({
      asked: 'capabilities',
    });
    await stuck;
  });
});
