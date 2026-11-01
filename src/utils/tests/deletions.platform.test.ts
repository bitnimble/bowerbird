import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WriteGrants } from '../../services/libraries/write_grants';
import { deleteBackedUpOriginal, moveOriginal, unlinkMovedFile } from '../deletions';
import { contentHash } from '../hash';

const NEVER_ASKED: WriteGrants = {
  grant: () => Promise.reject(new Error('asked leave for a deletion it then refused')),
};

// Windows needs a privilege to make one.
const withSymlinks = it.skipIf(process.platform === 'win32');

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-del-links-'));
  file = path.join(root, 'a.arw');
  writeFileSync(file, 'RAW');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hardLink(): string {
  const hard = path.join(root, 'hard.arw');
  linkSync(file, hard);
  return hard;
}

function softLink(): string {
  const soft = path.join(root, 'soft.arw');
  symlinkSync(file, soft);
  return soft;
}

describe('moveOriginal', () => {
  withSymlinks('refuses a hard link and a symlink to the source', async () => {
    for (const destination of [hardLink(), softLink()]) {
      await expect(moveOriginal(file, destination)).rejects.toThrow(/is the same file/);
    }
    expect(readFileSync(file, 'utf8')).toBe('RAW');
  });

  it.skipIf(process.platform === 'win32')('deletes against a read-only copy', async () => {
    const copy = path.join(root, 'copy.arw');
    writeFileSync(copy, 'RAW');
    chmodSync(copy, 0o444);

    expect(await moveOriginal(file, copy)).toBe(true);

    expect(existsSync(file)).toBe(false);
    expect(readFileSync(copy, 'utf8')).toBe('RAW');
  });

  withSymlinks('refuses a source symlink when a copy is already there, leaving both', async () => {
    const link = softLink();
    const copy = path.join(root, 'copy.arw');
    writeFileSync(copy, 'RAW');

    await expect(moveOriginal(link, copy)).rejects.toThrow(/is not a file/);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  withSymlinks('copies through a source symlink, and keeps the link and its target', async () => {
    const link = softLink();
    const copy = path.join(root, 'copy.arw');

    expect(await moveOriginal(link, copy)).toBe(false);

    expect(readFileSync(copy, 'utf8')).toBe('RAW');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a source it could not unlink, with the copy in place',
    async () => {
      const card = path.join(root, 'card');
      mkdirSync(card);
      const locked = path.join(card, 'a.arw');
      writeFileSync(locked, 'RAW');
      chmodSync(card, 0o500);
      const copy = path.join(root, 'copy.arw');
      try {
        expect(await moveOriginal(locked, copy)).toBe(false);

        expect(readFileSync(locked, 'utf8')).toBe('RAW');
        expect(readFileSync(copy, 'utf8')).toBe('RAW');
      } finally {
        chmodSync(card, 0o700);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'lands nothing when the source reads a different length than it says',
    async () => {
      const copy = path.join(root, 'copy.arw');

      await expect(moveOriginal('/proc/self/status', copy)).rejects.toThrow(/read \d+ of 0 bytes/);

      expect(existsSync(copy)).toBe(false);
    },
  );
});

describe('deleteBackedUpOriginal', () => {
  it('refuses a backup path that is a second name for the local file', async () => {
    const hard = hardLink();

    await expect(
      deleteBackedUpOriginal(root, file, hard, await contentHash(file), NEVER_ASKED),
    ).rejects.toThrow(/is the same file/);

    expect(existsSync(file)).toBe(true);
  });
});

describe('unlinkMovedFile', () => {
  it('removes the source of a finished hard link', async () => {
    const hard = hardLink();

    await unlinkMovedFile(file, hard);

    expect(existsSync(file)).toBe(false);
    expect(readFileSync(hard, 'utf8')).toBe('RAW');
  });

  withSymlinks('refuses a symlink to the source, with or without a second name', async () => {
    const soft = softLink();
    await expect(unlinkMovedFile(file, soft)).rejects.toThrow(/is a link/);

    hardLink();
    await expect(unlinkMovedFile(file, soft)).rejects.toThrow(/is a link/);
    await expect(unlinkMovedFile(file, file)).rejects.toThrow(/is the same file/);

    expect(readFileSync(file, 'utf8')).toBe('RAW');
  });

  withSymlinks('removes a symlink moved by hard link, and leaves its target', async () => {
    const soft = softLink();
    const moved = path.join(root, 'moved.arw');
    await link(soft, moved);

    await unlinkMovedFile(soft, moved);

    expect(existsSync(soft)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe('RAW');
    expect(readFileSync(file, 'utf8')).toBe('RAW');
  });

  it('removes a source whose destination sits in another folder as a copy', async () => {
    const elsewhere = path.join(root, 'Bin');
    mkdirSync(elsewhere);
    const copy = path.join(elsewhere, 'a.arw');
    writeFileSync(copy, 'RAW');

    await unlinkMovedFile(file, copy);

    expect(existsSync(file)).toBe(false);
  });
});
