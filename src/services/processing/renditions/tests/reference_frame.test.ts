import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertReferenceFrame, fetchReferenceFrame, REFERENCE_FRAME } from '../reference_frame';

const scratch = mkdtempSync(join(tmpdir(), 'bowerbird-reference-frame-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('a Git LFS pointer is refused as the reference frame', () => {
  const pointer = join(scratch, 'reference_frame.ARW');
  writeFileSync(
    pointer,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${REFERENCE_FRAME.sha256}\nsize ${REFERENCE_FRAME.byteLength}\n`,
  );

  expect(() => assertReferenceFrame(pointer)).toThrow('Run `git lfs pull`.');
});

test('a different file of the expected size is refused', () => {
  const wrong = join(scratch, 'wrong.ARW');
  writeFileSync(wrong, 'not the reference frame');
  truncateSync(wrong, REFERENCE_FRAME.byteLength);

  expect(() => assertReferenceFrame(wrong)).toThrow('Run `git lfs pull`.');
});

test('a download that does not match leaves nothing behind', async () => {
  const served = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('not the reference frame'),
  });
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
