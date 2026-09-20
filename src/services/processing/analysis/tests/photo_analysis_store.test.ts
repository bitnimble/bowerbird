import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPhotoAnalysis, writePhotoAnalysis } from '../photo_analysis_store';

const made: string[] = [];

function dataDir(): string {
  const at = mkdtempSync(path.join(tmpdir(), 'bowerbird-analysis-'));
  made.push(at);
  return at;
}

afterEach(() => {
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true });
});

describe('the photo analysis kept on disk', () => {
  test('comes back as it went in', () => {
    const at = dataDir();
    const analysis = new Uint8Array([0x42, 0x42, 0x50, 1, 0, 255, 128]);
    writePhotoAnalysis(at, 'photo-1', analysis);

    expect(Array.from(readPhotoAnalysis(at, 'photo-1') ?? [])).toEqual(Array.from(analysis));
  });

  test('is nothing for a photo nobody has rendered', () => {
    expect(readPhotoAnalysis(dataDir(), 'never-rendered')).toBeUndefined();
  });

  test('lives beside the renditions rather than inside them', () => {
    // The whole reason it is a file in its own directory: `renditions/` is a cache the orphan
    // sweep may take at any moment, and this is most of a second of measuring that depends almost
    // entirely on the RAW. A wipe of the cache must not reach it.
    const at = dataDir();
    writePhotoAnalysis(at, 'photo-1', new Uint8Array([1, 2, 3]));

    expect(readdirSync(at)).toEqual(['analysis']);
    expect(readdirSync(path.join(at, 'analysis'))).toEqual(['photo-1.bba']);
  });

  test('a write that cannot land is a slow render rather than a failed one', () => {
    // A path that cannot be a directory, which is what a permissions problem or a file in the
    // way looks like from here. Rendering a photograph must not depend on keeping this.
    const at = dataDir();
    const blocked = path.join(at, 'not-a-dir');
    Bun.write(blocked, 'x');

    expect(() => writePhotoAnalysis(blocked, 'photo-1', new Uint8Array([1]))).not.toThrow();
    expect(readPhotoAnalysis(blocked, 'photo-1')).toBeUndefined();
  });
});
