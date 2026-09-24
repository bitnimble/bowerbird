import { afterAll, expect, test } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertReferenceFrame, fetchReferenceFrame, REFERENCE_FRAME } from '../reference_frame';

const scratch = mkdtempSync(join(tmpdir(), 'bowerbird-reference-frame-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('the fixed reference frame is found without using the process working directory', () => {
  expect(isAbsolute(REFERENCE_FRAME.path)).toBe(true);
  expect(() => assertReferenceFrame()).not.toThrow();
});

test('a Git LFS pointer is refused as the reference frame', () => {
  const pointer = join(scratch, 'reference_frame.ARW');
  writeFileSync(pointer, `version https://git-lfs.github.com/spec/v1\noid sha256:${REFERENCE_FRAME.sha256}\nsize ${REFERENCE_FRAME.byteLength}\n`);

  expect(() => assertReferenceFrame(pointer)).toThrow('Run `git lfs pull`.');
});

test('a missing frame is downloaded where it was asked for', async () => {
  const served = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(Bun.file(REFERENCE_FRAME.path)) });
  const into = join(scratch, 'downloaded', 'reference_frame.ARW');
  try {
    await fetchReferenceFrame(into, `http://127.0.0.1:${served.port}/frame`);
  } finally {
    served.stop(true);
  }

  expect(() => assertReferenceFrame(into)).not.toThrow();
});

test('a download that does not match leaves nothing behind', async () => {
  const served = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not the reference frame') });
  const into = join(scratch, 'refused', 'reference_frame.ARW');
  try {
    await expect(fetchReferenceFrame(into, `http://127.0.0.1:${served.port}/frame`)).rejects.toThrow('does not match');
  } finally {
    served.stop(true);
  }

  expect(existsSync(into)).toBe(false);
});

test('a different file of the expected size is refused', () => {
  const wrong = join(scratch, 'wrong.ARW');
  writeFileSync(wrong, 'not the reference frame');
  truncateSync(wrong, REFERENCE_FRAME.byteLength);

  expect(() => assertReferenceFrame(wrong)).toThrow('Run `git lfs pull`.');
});
