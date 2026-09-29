import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendToStage, materialise, occupant, stagePath, stagedSize } from '../blob_store';
import { library, stream, withRoot } from './blob_store_test_helpers';

describe('occupant', () => {
  it('finds a name differing only in case', withRoot((root) => {
    writeFileSync(path.join(root, 'IMG_0001.ARW'), 'x');
    expect(occupant(root, 'img_0001.arw')).toBe('IMG_0001.ARW');
  }));

  // macOS hands back NFD where the server minted NFC.
  it('finds a name differing only in Unicode normalisation', withRoot((root) => {
    const nfd = 'café.arw';
    const nfc = 'café.arw';
    writeFileSync(path.join(root, nfd), 'x');
    expect(occupant(root, nfc)).toBe(nfd);
  }));
});

describe('materialise', () => {
  it('renames the staged blob to the path, creating folders', withRoot(async (root) => {
    const lib = library(root);
    const stage = stagePath(lib, 'photo1');
    await appendToStage(stage, 0, stream('bytes'));
    const outcome = await materialise(lib, 'Day1/one.arw', stage);
    expect(outcome).toEqual({ placed: true });
    expect(readFileSync(path.join(root, 'Day1/one.arw'), 'utf8')).toBe('bytes');
    expect(stagedSize(stage)).toBe(0);
  }));

  it('skips an occupied target and never suffixes', withRoot(async (root) => {
    const lib = library(root);
    mkdirSync(path.join(root, 'Day1'));
    writeFileSync(path.join(root, 'Day1', 'ONE.arw'), 'users own');
    const stage = stagePath(lib, 'photo1');
    await appendToStage(stage, 0, stream('bytes'));

    const outcome = await materialise(lib, 'Day1/one.arw', stage);
    expect(outcome).toEqual({ placed: false, occupiedBy: 'ONE.arw' });
    expect(readFileSync(path.join(root, 'Day1', 'ONE.arw'), 'utf8')).toBe('users own');
    expect(readdirSync(path.join(root, 'Day1'))).toEqual(['ONE.arw']);
    // The staged copy is kept: a retry after the user resolves it costs nothing.
    expect(stagedSize(stage)).toBe(5);
  }));
});
