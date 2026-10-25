import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fetchReferenceFrame, REFERENCE_FRAME } from '../reference_frame';

const scratch = mkdtempSync(join(tmpdir(), 'bowerbird-reference-frame-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function serving(body: string | Uint8Array): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(body) });
}

test('a different file of the expected size is not taken for the frame', async () => {
  const wrong = join(scratch, 'wrong.ARW');
  writeFileSync(wrong, 'not the reference frame');
  truncateSync(wrong, REFERENCE_FRAME.byteLength);

  const served = serving('not the reference frame');
  try {
    await expect(
      fetchReferenceFrame(wrong, `http://127.0.0.1:${served.port}/frame`),
    ).rejects.toThrow('does not match');
  } finally {
    served.stop(true);
  }
});

test('a download of the right size that does not match leaves nothing behind', async () => {
  const served = serving(new Uint8Array(REFERENCE_FRAME.byteLength));
  const into = join(scratch, 'refused', 'reference_frame.ARW');
  try {
    await expect(
      fetchReferenceFrame(into, `http://127.0.0.1:${served.port}/frame`),
    ).rejects.toThrow('does not match');
  } finally {
    served.stop(true);
  }

  expect(existsSync(into)).toBe(false);
});
