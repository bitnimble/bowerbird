import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../schemas/libraries';
import { appendToStage, contentHash, materialise, occupant, stagePath, stagedSize } from '../blob_store';

function withRoot(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-blobstore-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function library(root: string): Library {
  return {
    id: 'library1',
    root_path: root,
    bin_name: 'Bin',
    read_only: false,
    name: 'Trip',
    ordering: 'taken_asc',
    rendition_source: 'render',
    rendition_hdr: true,
    render_skip_full: [],
    render_skip_max: [],
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
  };
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe('contentHash', () => {
  it('is the SHA-256 of the bytes', withRoot(async (root) => {
    const file = path.join(root, 'a.arw');
    writeFileSync(file, 'abc');
    expect(await contentHash(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  }));
});

describe('appendToStage', () => {
  it('appends only at exactly the staged size', withRoot(async (root) => {
    const stage = stagePath(library(root), 'photo1');
    expect(await appendToStage(stage, 0, stream('hello '))).toBe(6);
    expect(await appendToStage(stage, 6, stream('world'))).toBe(11);
    expect(readFileSync(stage, 'utf8')).toBe('hello world');
    await expect(appendToStage(stage, 4, stream('xx'))).rejects.toThrow('11 staged bytes, not 4');
    expect(stagedSize(stage)).toBe(11);
  }));
});

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

  it('reads a free spot as free', withRoot((root) => {
    writeFileSync(path.join(root, 'other.arw'), 'x');
    expect(occupant(root, 'one.arw')).toBeNull();
    expect(occupant(path.join(root, 'no-such-dir'), 'one.arw')).toBeNull();
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

  it('refuses a path that escapes the library root', withRoot(async (root) => {
    const lib = library(root);
    const stage = stagePath(lib, 'photo1');
    await appendToStage(stage, 0, stream('bytes'));
    await expect(materialise(lib, '../outside.arw', stage)).rejects.toThrow('escapes the library root');
  }));
});
