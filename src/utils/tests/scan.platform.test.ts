import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibraryTree } from '../scan';
import type { LibraryScope } from '../scope';

const CAN_DENY_READS = process.platform !== 'win32' && process.getuid?.() !== 0;

let root: string;
let locked: string;

const scope = (): LibraryScope => ({
  rootPath: root,
  includeSubfolders: true,
  includeNonRaw: false,
  binName: null,
  excluded: new Set(),
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-scan-'));
  locked = path.join(root, 'locked');
  mkdirSync(locked);
  writeFileSync(path.join(root, 'kept.arw'), 'raw');
});

afterEach(() => {
  chmodSync(root, 0o700);
  chmodSync(locked, 0o700);
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!CAN_DENY_READS)(
  'a library walk fails on an unreadable folder, leaving its rows unread as missing',
  async () => {
    chmodSync(locked, 0o000);

    await expect(scanLibraryTree(scope())).rejects.toMatchObject({ code: 'EACCES' });
  },
);

test.skipIf(!CAN_DENY_READS)(
  'asked to, a walk skips an unreadable folder and says it is incomplete',
  async () => {
    chmodSync(locked, 0o000);

    const walked = await scanLibraryTree(scope(), '', undefined, undefined, true);

    expect(walked.files.map((file) => file.relPath)).toEqual(['kept.arw']);
    expect(walked.complete).toBe(false);
  },
);

test.skipIf(!CAN_DENY_READS)('an unreadable root fails even a walk that skips', async () => {
  chmodSync(root, 0o000);

  await expect(scanLibraryTree(scope(), '', undefined, undefined, true)).rejects.toMatchObject({
    code: 'EACCES',
  });
});
