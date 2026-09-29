import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { deleteEmptyStagingDirectory } from '../../../utils/deletions';
import { contentHash } from '../../../utils/hash';
import {
  appendToStage,
  materialise,
  occupant,
  stagePath,
  stagedSize,
  stagingDir,
} from '../blob_store';
import { library, stream, withRoot } from './blob_store_test_helpers';

describe('contentHash', () => {
  it(
    'is the SHA-256 of the bytes',
    withRoot(async (root) => {
      const file = path.join(root, 'a.arw');
      writeFileSync(file, 'abc');
      expect(await contentHash(file)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    }),
  );
});

describe('appendToStage', () => {
  it(
    'recreates staging when cleanup removes it between mkdir and open',
    withRoot(async (root) => {
      const lib = library(root);
      const stage = stagePath(lib, 'photo1');
      const open = fs.open;
      const opening = spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
        await deleteEmptyStagingDirectory(stagingDir(lib));
        return open(file, flags, mode);
      });
      try {
        expect(await appendToStage(stage, 0, stream('bytes'))).toBe(5);
        expect(readFileSync(stage, 'utf8')).toBe('bytes');
      } finally {
        opening.mockRestore();
      }
    }),
  );

  it(
    'appends only at exactly the staged size',
    withRoot(async (root) => {
      const stage = stagePath(library(root), 'photo1');
      expect(await appendToStage(stage, 0, stream('hello '))).toBe(6);
      expect(await appendToStage(stage, 6, stream('world'))).toBe(11);
      expect(readFileSync(stage, 'utf8')).toBe('hello world');
      await expect(appendToStage(stage, 4, stream('xx'))).rejects.toThrow('11 staged bytes, not 4');
      expect(stagedSize(stage)).toBe(11);
    }),
  );
});

describe('occupant', () => {
  it(
    'reads a free spot as free',
    withRoot((root) => {
      writeFileSync(path.join(root, 'other.arw'), 'x');
      expect(occupant(root, 'one.arw')).toBeNull();
      expect(occupant(path.join(root, 'no-such-dir'), 'one.arw')).toBeNull();
    }),
  );
});

describe('materialise', () => {
  it(
    'refuses a path that escapes the library root',
    withRoot(async (root) => {
      const lib = library(root);
      const stage = stagePath(lib, 'photo1');
      await appendToStage(stage, 0, stream('bytes'));
      await expect(materialise(lib, '../outside.arw', stage)).rejects.toThrow(
        'escapes the library root',
      );
    }),
  );
});
