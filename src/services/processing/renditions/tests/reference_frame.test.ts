import { afterAll, expect, test } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertReferenceFrame, REFERENCE_FRAME } from '../reference_frame';

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

test('a different file of the expected size is refused', () => {
  const wrong = join(scratch, 'wrong.ARW');
  writeFileSync(wrong, 'not the reference frame');
  truncateSync(wrong, REFERENCE_FRAME.byteLength);

  expect(() => assertReferenceFrame(wrong)).toThrow('Run `git lfs pull`.');
});
