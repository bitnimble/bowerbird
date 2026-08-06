import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deleteDataDirectory, deleteGeneratedFile, unlinkMovedFile } from '../deletions';

function withTmp(run: (root: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-del-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('deleteGeneratedFile', () => {
  it(
    'removes a rendition under the data directory',
    withTmp(async (root) => {
      const file = path.join(root, 'renditions', 'grid', 'p1.avif');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
      await deleteGeneratedFile(root, file);
      expect(existsSync(file)).toBe(false);
    }),
  );

  it(
    'refuses anything outside the generated directories',
    withTmp(async (root) => {
      const raw = path.join(root, 'a.arw');
      writeFileSync(raw, 'raw');
      await expect(deleteGeneratedFile(root, raw)).rejects.toThrow(/not a generated file/);
      // The Bin sits at the library root, but even a data-directory one is refused.
      await expect(deleteGeneratedFile(root, path.join(root, 'bin', 'a.arw'))).rejects.toThrow(/not a generated file/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses an original that has been placed under a generated directory',
    withTmp(async (root) => {
      const raw = path.join(root, 'renditions', 'grid', 'a.ARW');
      mkdirSync(path.dirname(raw), { recursive: true });
      writeFileSync(raw, 'raw');
      await expect(deleteGeneratedFile(root, raw)).rejects.toThrow(/it is an original/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses a traversal back out of the data directory',
    withTmp(async (root) => {
      const escape = path.join(root, 'renditions', '..', '..', 'a.arw');
      await expect(deleteGeneratedFile(root, escape)).rejects.toThrow(/not a generated file/);
    }),
  );
});

describe('deleteDataDirectory', () => {
  it(
    'removes a tree of generated files',
    withTmp(async (root) => {
      const data = path.join(root, '.bowerbird');
      mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(data, 'renditions', 'grid', 'p1.avif'), '');
      await deleteDataDirectory(data);
      expect(existsSync(data)).toBe(false);
    }),
  );

  it(
    'refuses while an original is still inside, however deeply buried',
    withTmp(async (root) => {
      const data = path.join(root, '.bowerbird');
      mkdirSync(path.join(data, 'bin'), { recursive: true });
      writeFileSync(path.join(data, 'bin', 'a.arw'), 'raw');
      await expect(deleteDataDirectory(data)).rejects.toThrow(/still holds 1 original/);
      expect(existsSync(path.join(data, 'bin', 'a.arw'))).toBe(true);
    }),
  );
});

describe('unlinkMovedFile', () => {
  it(
    'refuses to remove the source when the destination never appeared',
    withTmp(async (root) => {
      const from = path.join(root, 'a.arw');
      writeFileSync(from, 'raw');
      await expect(unlinkMovedFile(from, path.join(root, 'Bin', 'a.arw'))).rejects.toThrow(/does not exist/);
      expect(existsSync(from)).toBe(true);
    }),
  );
});
