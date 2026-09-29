import { afterAll, expect, test } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertReferenceFrame, fetchReferenceFrame, REFERENCE_FRAME } from '../reference_frame';

const scratch = mkdtempSync(join(tmpdir(), 'bowerbird-reference-frame-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('the fixed reference frame is found without using the process working directory', () => {
  expect(isAbsolute(REFERENCE_FRAME.path)).toBe(true);
  expect(() => assertReferenceFrame()).not.toThrow();
});

test('a missing frame is downloaded where it was asked for', async () => {
  const served = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(Bun.file(REFERENCE_FRAME.path)),
  });
  const into = join(scratch, 'downloaded', 'reference_frame.ARW');
  try {
    await fetchReferenceFrame(into, `http://127.0.0.1:${served.port}/frame`);
  } finally {
    served.stop(true);
  }

  expect(() => assertReferenceFrame(into)).not.toThrow();
});
