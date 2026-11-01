import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../../config';
import type { BlobVerifyResponse } from '../../schemas/blobs';
import {
  copyOriginal,
  deleteBackedUpOriginal,
  deleteDataDirectory,
  deleteDraft,
  deleteEmptyStagingDirectory,
  deleteEvictedOriginal,
  deleteGeneratedFile,
  deleteImportStaging,
  deleteStagedBlob,
  deleteUpdateStaging,
  moveOriginal,
  unlinkMovedFile,
} from '../deletions';
import { contentHash } from '../hash';
import type { WriteGrants } from '../../services/libraries/write_grants';

/** A refused deletion must not ask the platform first, or the reader is prompted for nothing. */
const NEVER_ASKED: WriteGrants = {
  grant: () => Promise.reject(new Error('asked leave for a deletion it then refused')),
};

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

describe('deleteImportStaging', () => {
  it(
    'removes what a copy was writing',
    withTmp(async (root) => {
      const staging = path.join(root, 'DSC1.ARW.abcdefgh12345678.tmp');
      writeFileSync(staging, 'partial');

      await deleteImportStaging(staging);

      expect(existsSync(staging)).toBe(false);
    }),
  );

  it.each(['DSC1.ARW', 'notes.abcdefgh12345678.tmp', 'DSC1.ARW.bak.tmp'])(
    'refuses %s, and leaves it',
    (name) =>
      withTmp(async (root) => {
        const file = path.join(root, name);
        writeFileSync(file, 'theirs');

        await expect(deleteImportStaging(file)).rejects.toThrow('refusing');

        expect(readFileSync(file, 'utf8')).toBe('theirs');
      })(),
  );
});

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
      await expect(deleteGeneratedFile(root, path.join(root, 'bin', 'a.arw'))).rejects.toThrow(
        /not a generated file/,
      );
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
      for (const name of ['download', 'staged']) {
        mkdirSync(path.join(home, name), { recursive: true });
        writeFileSync(path.join(home, name, 'file'), '');
      }
      writeFileSync(path.join(home, 'updater.log'), '');
      await deleteUpdateStaging(home, 'download');
      expect(existsSync(path.join(home, 'download'))).toBe(false);
      expect(existsSync(path.join(home, 'staged'))).toBe(true);
      expect(existsSync(path.join(home, 'updater.log'))).toBe(true);
    }),
  );

  // `BOWERBIRD_UPDATES` with its leading slash dropped is a real shape of typo, and
  // `path.resolve` would anchor it to wherever the server was started from - so this
  // would recursively delete `download` out of the working directory instead.
  it('refuses a home that is not absolute', async () => {
    await expect(deleteUpdateStaging('relative/updates', 'download')).rejects.toThrow(/absolute/);
    await expect(deleteUpdateStaging('', 'staged')).rejects.toThrow(/absolute/);
  });
});

describe('deleteDataDirectory', () => {
  const LIBRARY_ID = `deletions-test-${process.pid}`;
  const data = path.join(config.dataDir, LIBRARY_ID);

  afterEach(() => {
    rmSync(data, { recursive: true, force: true });
  });

  it('removes a tree of generated files', async () => {
    mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
    writeFileSync(path.join(data, 'renditions', 'grid', 'p1.avif'), '');
    await deleteDataDirectory(LIBRARY_ID);
    expect(existsSync(data)).toBe(false);
  });

  it('refuses while an original is still inside, however deeply buried', async () => {
    mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
    writeFileSync(path.join(data, 'renditions', 'grid', 'a.arw'), 'raw');
    await expect(deleteDataDirectory(LIBRARY_ID)).rejects.toThrow(/still holds 1 original/);
    expect(existsSync(path.join(data, 'renditions', 'grid', 'a.arw'))).toBe(true);
  });

  it.each(['.', '..', '../elsewhere', `${LIBRARY_ID}/renditions`])(
    'refuses the id %s, which names no directory directly under DATA_DIR',
    async (id) => {
      mkdirSync(path.join(data, 'renditions'), { recursive: true });
      await expect(deleteDataDirectory(id)).rejects.toThrow(/not a library's data directory/);
      expect(existsSync(path.join(data, 'renditions'))).toBe(true);
    },
  );
});

describe('moveOriginal', () => {
  const SHOT_AT = new Date('2026-03-04T05:06:07.000Z');

  function shaped(
    root: string,
    source = 'RAW',
    destination: string | null = null,
  ): [string, string] {
    const card = path.join(root, 'card.arw');
    const copy = path.join(root, 'copy.arw');
    writeFileSync(card, source);
    utimesSync(card, SHOT_AT, SHOT_AT);
    if (destination != null) writeFileSync(copy, destination);
    return [card, copy];
  }

  it(
    'moves to a free name, keeping the bytes and the mtime and leaving no staging file',
    withTmp(async (root) => {
      const [card, copy] = shaped(root);

      expect(await moveOriginal(card, copy)).toBe(true);

      expect(existsSync(card)).toBe(false);
      expect(readFileSync(copy, 'utf8')).toBe('RAW');
      expect(statSync(copy).mtimeMs).toBe(SHOT_AT.getTime());
      expect(readdirSync(root)).toEqual(['copy.arw']);
    }),
  );

  it(
    'carries a file bigger than one read',
    withTmp(async (root) => {
      const bytes = randomBytes(9 * 1024 * 1024);
      const card = path.join(root, 'card.arw');
      const copy = path.join(root, 'copy.arw');
      writeFileSync(card, bytes);

      await moveOriginal(card, copy);

      expect(readFileSync(copy).equals(bytes)).toBe(true);
    }),
  );

  it(
    'never hashes the source apart from the copy',
    withTmp(async (root) => {
      const [card, copy] = shaped(root);
      const opened = spyOn(Bun, 'file');
      try {
        await moveOriginal(card, copy);
        expect(opened.mock.calls.map(([file]) => file)).not.toContain(card);
      } finally {
        opened.mockRestore();
      }
    }),
  );

  it(
    'keeps the source and lands nothing when the read-back differs from what was read',
    withTmp(async (root) => {
      const [card, copy] = shaped(root);
      const corrupted = path.join(root, 'corrupted');
      writeFileSync(corrupted, 'BAD');
      const realFile = Bun.file.bind(Bun);
      const opened = spyOn(Bun, 'file').mockImplementation(((target: string) =>
        realFile(target.endsWith('.tmp') ? corrupted : target)) as never);
      try {
        await expect(moveOriginal(card, copy)).rejects.toThrow(/does not match/);
      } finally {
        opened.mockRestore();
      }

      expect(readFileSync(card, 'utf8')).toBe('RAW');
      expect(readdirSync(root).sort()).toEqual(['card.arw', 'corrupted']);
    }),
  );

  it(
    'refuses a source that is not there',
    withTmp(async (root) => {
      const [card, copy] = shaped(root, 'RAW', 'RAW');
      rmSync(card);

      await expect(moveOriginal(card, copy)).rejects.toThrow(/is not a file/);
      rmSync(copy);
      await expect(moveOriginal(card, copy)).rejects.toThrow();
      expect(existsSync(copy)).toBe(false);
    }),
  );

  it(
    'deletes the source when the destination already holds the same bytes',
    withTmp(async (root) => {
      const [card, copy] = shaped(root, 'RAW', 'RAW');

      expect(await moveOriginal(card, copy)).toBe(true);

      expect(existsSync(card)).toBe(false);
      expect(readFileSync(copy, 'utf8')).toBe('RAW');
    }),
  );

  it(
    'refuses a directory for either path',
    withTmp(async (root) => {
      const [card, copy] = shaped(root, 'RAW', 'RAW');
      const folder = path.join(root, 'folder');
      mkdirSync(folder);

      await expect(moveOriginal(card, folder)).rejects.toThrow(/is not a file/);
      await expect(moveOriginal(folder, copy)).rejects.toThrow(/is not a file/);
      expect(existsSync(card) && existsSync(folder)).toBe(true);
    }),
  );

  it(
    'refuses a destination of the same size holding other bytes',
    withTmp(async (root) => {
      const [card, copy] = shaped(root, 'RAW', 'BAD');

      await expect(moveOriginal(card, copy)).rejects.toThrow(/does not match/);
      expect(readFileSync(card, 'utf8')).toBe('RAW');
      expect(readFileSync(copy, 'utf8')).toBe('BAD');
    }),
  );

  it(
    'refuses a path given as its own destination',
    withTmp(async (root) => {
      const [card] = shaped(root);

      await expect(moveOriginal(card, card)).rejects.toThrow(/is the same file/);
      expect(readFileSync(card, 'utf8')).toBe('RAW');
    }),
  );
});

describe('copyOriginal', () => {
  it(
    'leaves the source, and refuses to replace what holds the name',
    withTmp(async (root) => {
      const card = path.join(root, 'card.arw');
      const copy = path.join(root, 'copy.arw');
      writeFileSync(card, 'RAW');

      await copyOriginal(card, copy);
      expect(readFileSync(card, 'utf8')).toBe('RAW');
      expect(readFileSync(copy, 'utf8')).toBe('RAW');

      writeFileSync(card, 'new');
      await expect(copyOriginal(card, copy)).rejects.toThrow();
      expect(readFileSync(copy, 'utf8')).toBe('RAW');
      expect(readdirSync(root).sort()).toEqual(['card.arw', 'copy.arw']);
    }),
  );
});

describe('deleteEvictedOriginal', () => {
  function shaped(root: string, bytes = 'RAW'): string {
    const raw = path.join(root, 'a.arw');
    writeFileSync(raw, bytes);
    return raw;
  }
  const NEVER_REACHED = (): Promise<BlobVerifyResponse> => {
    throw new Error('asked the peer before the local file was checked');
  };

  it(
    'deletes once the local file and a matching peer both answer',
    withTmp(async (root) => {
      const raw = shaped(root);
      const hash = await contentHash(raw);
      const granted: string[] = [];

      await deleteEvictedOriginal(
        root,
        raw,
        hash,
        async () => ({ held: true, content_hash: hash }),
        { grant: async (paths) => void granted.push(...paths) },
      );

      expect(granted).toEqual([raw]);
      expect(existsSync(raw)).toBe(false);
    }),
  );

  it(
    'refuses a local file that no longer hashes what was recorded, before asking the peer',
    withTmp(async (root) => {
      const raw = shaped(root, 'edited');

      await expect(
        deleteEvictedOriginal(root, raw, 'recorded', NEVER_REACHED, NEVER_ASKED),
      ).rejects.toThrow(/has changed/);
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it.each<[string, BlobVerifyResponse]>([
    ['holds nothing', { held: false }],
    ['holds other bytes', { held: true, content_hash: 'other' }],
  ])('refuses when the peer %s', (_, answer) =>
    withTmp(async (root) => {
      const raw = shaped(root);

      await expect(
        deleteEvictedOriginal(root, raw, await contentHash(raw), async () => answer, NEVER_ASKED),
      ).rejects.toThrow(/could not verify possession/);
      expect(existsSync(raw)).toBe(true);
    })(),
  );

  it(
    'keeps the file when the peer cannot be asked',
    withTmp(async (root) => {
      const raw = shaped(root);

      await expect(
        deleteEvictedOriginal(
          root,
          raw,
          await contentHash(raw),
          () => Promise.reject(new Error('unreachable')),
          NEVER_ASKED,
        ),
      ).rejects.toThrow('unreachable');
      expect(existsSync(raw)).toBe(true);
    }),
  );
});

describe('deleteBackedUpOriginal', () => {
  // Every arm of this one: it is the only place an original a reader still has is removed on
  // purpose, and each check exists because the copy it trusts can be wrong in a different way.
  async function shaped(
    root: string,
    local: string,
    onBackup: string,
  ): Promise<{ raw: string; copy: string }> {
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

      const granted: string[] = [];
      await deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, await contentHash(copy), {
        grant: async (paths) => void granted.push(...paths),
      });

      expect(granted).toEqual([raw]);
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

      await expect(
        deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, hash, NEVER_ASKED),
      ).rejects.toMatchObject({ issueCode: 'backup_missing' });
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses when the copy on the backup has rotted under the record of it',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');
      const hash = await contentHash(copy);
      writeFileSync(copy, 'half a RAW');

      await expect(
        deleteBackedUpOriginal(path.join(root, 'library'), raw, copy, hash, NEVER_ASKED),
      ).rejects.toMatchObject({ issueCode: 'backup_changed' });
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
        deleteBackedUpOriginal(
          path.join(root, 'library'),
          raw,
          copy,
          await contentHash(copy),
          NEVER_ASKED,
        ),
      ).rejects.toMatchObject({ issueCode: 'local_changed' });
      expect(existsSync(raw)).toBe(true);
    }),
  );

  it(
    'refuses a target outside the library it was given',
    withTmp(async (root) => {
      const { raw, copy } = await shaped(root, 'RAW', 'RAW');

      await expect(
        deleteBackedUpOriginal(
          path.join(root, 'elsewhere'),
          raw,
          copy,
          await contentHash(copy),
          NEVER_ASKED,
        ),
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
      await expect(unlinkMovedFile(from, path.join(root, 'Bin', 'a.arw'))).rejects.toThrow(
        /does not exist/,
      );
      expect(existsSync(from)).toBe(true);
    }),
  );

  it(
    'removes the source of a copy that reads back the same',
    withTmp(async (root) => {
      const from = path.join(root, 'a.arw');
      const to = path.join(root, 'b.arw');
      writeFileSync(from, 'raw');
      writeFileSync(to, 'raw');

      await unlinkMovedFile(from, to);

      expect(existsSync(from)).toBe(false);
    }),
  );

  it(
    'refuses a destination holding other bytes',
    withTmp(async (root) => {
      const from = path.join(root, 'a.arw');
      const to = path.join(root, 'b.arw');
      writeFileSync(from, 'raw');
      writeFileSync(to, 'bad');

      await expect(unlinkMovedFile(from, to)).rejects.toThrow(/does not match/);
      expect(readFileSync(from, 'utf8')).toBe('raw');
    }),
  );

  it(
    'refuses a path given as its own destination',
    withTmp(async (root) => {
      const from = path.join(root, 'a.arw');
      writeFileSync(from, 'raw');

      await expect(unlinkMovedFile(from, from)).rejects.toThrow(/is the same file/);
      expect(readFileSync(from, 'utf8')).toBe('raw');
    }),
  );
});

describe('deleteEmptyStagingDirectory', () => {
  it(
    'removes only an empty staging directory, preserving partials and originals',
    withTmp(async (root) => {
      const dir = path.join(root, '.bowerbird-staging');
      const partial = path.join(dir, 'p1.partial');
      mkdirSync(dir);
      writeFileSync(partial, 'unfinished');
      await deleteEmptyStagingDirectory(dir);
      expect(readFileSync(partial, 'utf8')).toBe('unfinished');

      writeFileSync(path.join(dir, 'keep.arw'), 'users own');
      await deleteStagedBlob(dir, partial);
      expect(existsSync(partial)).toBe(false);
      expect(readFileSync(path.join(dir, 'keep.arw'), 'utf8')).toBe('users own');

      rmSync(path.join(dir, 'keep.arw'));
      await deleteEmptyStagingDirectory(dir);
      await deleteEmptyStagingDirectory(dir);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(root)).toBe(true);
    }),
  );

  it(
    'refuses other directories and leaves a file occupying the staging path',
    withTmp(async (root) => {
      const dir = path.join(root, '.bowerbird-staging');
      await expect(deleteEmptyStagingDirectory(root)).rejects.toThrow(
        'not a blob staging directory',
      );
      expect(existsSync(root)).toBe(true);

      writeFileSync(dir, 'users own');
      await deleteEmptyStagingDirectory(dir);
      expect(readFileSync(dir, 'utf8')).toBe('users own');
    }),
  );
});
