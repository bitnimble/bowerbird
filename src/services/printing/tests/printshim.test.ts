import { describe, expect, test } from 'bun:test';
import { printshimWorkers } from '../printshim';

const run = printshimWorkers(new URL('./printshim_fixture_worker.ts', import.meta.url));

describe('printshimWorkers', () => {
  test('a command that never returns times out without holding up the next one', async () => {
    const stuck = expect(run({ kind: 'list' }, 300)).rejects.toThrow(
      'the printer did not answer in 300 ms',
    );
    expect(await run({ kind: 'capabilities', printer: 'cups:PRO-200' }, 5000)).toEqual({
      ok: true,
      asked: 'capabilities',
    });
    await stuck;
  });

  test('a submit that times out says the print may still arrive', async () => {
    await expect(
      run(
        {
          kind: 'submit',
          printer: 'cups:PRO-200',
          image: '/tmp/print.png',
          job: {
            name: 'IMG_0001',
            media: 'iso_a4_210x297mm',
            mediaType: null,
            borderless: false,
            copies: 1,
            resolutionDpi: 300,
            page: { widthPx: 2480, heightPx: 3508 },
            place: { x: 0, y: 0, width: 2480, height: 3508 },
            transport: { space: 'srgb', bits: 8 },
          },
        },
        300,
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'the printer did not confirm the print in 300 ms, so it may still arrive',
      details: [{ printUnconfirmed: true }],
    });
  });

  test('a refusal carries the kind of failure the printshim named', async () => {
    const refused = (printer: string): Promise<unknown> =>
      run({ kind: 'capabilities', printer }, 5000).catch((err: unknown) => err);
    expect(await refused('cups:invalid')).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'not a queue',
    });
    expect(await refused('cups:missing')).toMatchObject({
      code: 'NOT_FOUND',
      message: 'no such queue',
    });
    expect(await refused('cups:unavailable')).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await refused('cups:unkinded')).toMatchObject({
      code: 'UNAVAILABLE',
      message: 'the printer is offline',
    });
    expect(await refused('cups:garbled')).toMatchObject({
      code: 'UNAVAILABLE',
      message: "the printer's reply couldn't be read",
    });
  });
});
