import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deleteBackedUpOriginal,
  deleteDataDirectory,
  deleteDraft,
  deleteGeneratedFile,
  deleteUpdateStaging,
  unlinkMovedFile,
} from '../deletions';
import { contentHash } from '../hash';

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

describe('deleteDraft', () => {
  it(
    'removes a whole draft directory, which is the one generated tree reaped as a unit',
    withTmp(async (root) => {
      const draft = path.join(root, 'drafts', 'aaa,bbb');
      mkdirSync(draft, { recursive: true });
      writeFileSync(path.join(draft, '0.avif'), '');
      writeFileSync(path.join(draft, '1.avif'), '');

      await deleteDraft(root, draft);

      expect(existsSync(draft)).toBe(false);
      expect(existsSync(path.join(root, 'drafts'))).toBe(true);
    }),
  );

  it(
    'refuses anything but one entry inside drafts, and a draft holding an original',
    withTmp(async (root) => {
      const shoot = path.join(root, 'Trip');
      mkdirSync(shoot, { recursive: true });
      writeFileSync(path.join(shoot, 'a.arw'), 'raw');
      const renditions = path.join(root, 'renditions');
      mkdirSync(renditions, { recursive: true });
      const drafts = path.join(root, 'drafts');
      const stray = path.join(drafts, 'stray');
      mkdirSync(stray, { recursive: true });
      writeFileSync(path.join(stray, 'b.arw'), 'raw');

      for (const target of [shoot, renditions, drafts]) {
        await expect(deleteDraft(root, target)).rejects.toThrow(/not a draft/);
      }
      await expect(deleteDraft(root, stray)).rejects.toThrow(/holds an original/);
      expect([shoot, renditions, stray].every((kept) => existsSync(kept))).toBe(true);
    }),
  );
});

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

describe('deleteUpdateStaging', () => {
  it(
    'removes the scratch directory it was asked for, and only that one',
    withTmp(async (home) => {
      for (const name of ['download', 'staged', 'versions']) {
        mkdirSync(path.join(home, name), { recursive: true });
        writeFileSync(path.join(home, name, 'file'), '');
      }
      await deleteUpdateStaging(home, 'download');
      expect(existsSync(path.join(home, 'download'))).toBe(false);
      // The two that are not scratch: `versions` is what the app is running out of.
      expect(existsSync(path.join(home, 'staged'))).toBe(true);
      expect(existsSync(path.join(home, 'versions'))).toBe(true);
    }),
  );

  // `BOWERBIRD_HOME` with its leading slash dropped is a real shape of typo, and
  // `path.resolve` would anchor it to wherever the server was started from - so this
  // would recursively delete `download` out of the working directory instead.
  it('refuses a home that is not absolute', async () => {
    await expect(deleteUpdateStaging('relative/updates', 'download')).rejects.toThrow(/absolute/);
    await expect(deleteUpdateStaging('', 'staged')).rejects.toThrow(/absolute/);
  });
});

describe('deleteDataDirectory', () => {
  it(
    'removes a tree of generated files',
    withTmp(async (root) => {
      // Shaped like the real thing: `<DATA_DIR>/<library id>`, outside every
      // library root (§6).
      const data = path.join(root, 'library-id');
      mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(data, 'renditions', 'grid', 'p1.avif'), '');
      await deleteDataDirectory(data);
      expect(existsSync(data)).toBe(false);
    }),
  );

  it(
    'refuses while an original is still inside, however deeply buried',
    withTmp(async (root) => {
      const data = path.join(root, 'library-id');
      mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(data, 'renditions', 'grid', 'a.arw'), 'raw');
      await expect(deleteDataDirectory(data)).rejects.toThrow(/still holds 1 original/);
      expect(existsSync(path.join(data, 'renditions', 'grid', 'a.arw'))).toBe(true);
    }),
  );
});

describe('deleteBackedUpOriginal', () => {
  // Every arm of this one: it is the only place an original a reader still has is removed on
  // purpose, and each check exists because the copy it trusts can be wrong in a different way.
  async function shaped(root: string, local: string, onBackup: string): Promise<{ raw: string; copy: string }> {
    const raw = path.join(root, 'library', 'a.arw');
    const copy = path.join(root, 'backup', 'a.arw');
    mkdirSync(path.dirname(raw), { recursive: true });
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(raw, local);
    writeFileSync(copy, onBackup);
    return { raw, copy };
  }

  it(
    'gives up the local copy once both files hash what the catalogue recorded',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');

      await deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, await contentHash(copy));

      expect(existsSync(raw)).toBe(false);
      expect(existsSync(copy)).toBe(true);
    }),
  );

  it(
    'refuses when the backup holds nothing at the path it was told',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');
      const hash = await contentHash(copy);
      rmSync(copy);

      await expect(deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, hash)).rejects.toThrow(/no copy/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses when the copy on the backup has rotted under the record of it',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');
      const hash = await contentHash(copy);
      writeFileSync(copy, 'half a RAW');

      await expect(deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, hash)).rejects.toThrow(/hashes/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  // The one an ordering mistake would produce: the file here has been edited or replaced since the
  // hash was taken, so the backup's copy is a *different* photograph's bytes and giving this one
  // up would lose the only copy of what is actually on this disk.
  it(
    'refuses when the local copy is no longer the one that was backed up',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW two', 'RAW');

      await expect(
        deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, await contentHash(copy)),
      ).rejects.toThrow(/this copy hashes/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses a target outside the library it was given',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');

      await expect(
        deleteBackedUpOriginal(path.join(root, 'elsewhere'), raw, copy, await contentHash(copy)),
      ).rejects.toThrow(/outside the library root/);
      expect(existsSync(raw)).toBe(true);
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
