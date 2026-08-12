import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCameraMatch, writeCameraMatch } from '../camera_match_store';

const made: string[] = [];

function dataDir(): string {
  const at = mkdtempSync(path.join(tmpdir(), 'bowerbird-match-'));
  made.push(at);
  return at;
}

afterEach(() => {
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true });
});

describe('the camera match kept on disk', () => {
  test('comes back as it went in', () => {
    const at = dataDir();
    const match = new Uint8Array([0x42, 0x42, 0x4d, 1, 0, 255, 128]);
    writeCameraMatch(at, 'photo-1', match);

    expect(Array.from(readCameraMatch(at, 'photo-1') ?? [])).toEqual(Array.from(match));
  });

  test('is nothing for a photo nobody has rendered', () => {
    expect(readCameraMatch(dataDir(), 'never-rendered')).toBeUndefined();
  });

  test('lives beside the renditions rather than inside them', () => {
    // The whole reason it is a file in its own directory: `renditions/` is a cache the orphan
    // sweep may take at any moment, and a match is half a second of fitting that depends on
    // nothing but the RAW. A wipe of the cache must not reach it.
    const at = dataDir();
    writeCameraMatch(at, 'photo-1', new Uint8Array([1, 2, 3]));

    expect(readdirSync(at)).toEqual(['matches']);
    expect(readdirSync(path.join(at, 'matches'))).toEqual(['photo-1.bbm']);
  });

  test('a write that cannot land is a slow render rather than a failed one', () => {
    // A path that cannot be a directory, which is what a permissions problem or a file in the
    // way looks like from here. Rendering a photograph must not depend on keeping this.
    const at = dataDir();
    const blocked = path.join(at, 'not-a-dir');
    Bun.write(blocked, 'x');

    expect(() => writeCameraMatch(blocked, 'photo-1', new Uint8Array([1]))).not.toThrow();
    expect(readCameraMatch(blocked, 'photo-1')).toBeUndefined();
  });
});
