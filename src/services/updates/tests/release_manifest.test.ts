import { describe, expect, test } from 'bun:test';
import type { ReleaseManifest } from '../../../schemas/updates';
import { compareVersions, isNewer, parseReleaseManifest, writeReleaseManifest } from '../release_manifest';

const MANIFEST: ReleaseManifest = {
  version: '0.2.0',
  tag: 'v0.2.0',
  assets: {
    'linux-x86_64': {
      installer: 'Bowerbird_0.2.0_linux-x86_64.AppImage',
      payload: 'bowerbird-payload-linux-x86_64.tar.gz',
      payload_sha256: 'a'.repeat(64),
    },
    'android-arm64': { installer: 'Bowerbird_0.2.0_android-arm64.apk' },
    // Deliberately not this project's own image: what is being round-tripped is a string,
    // and one that looks like configuration invites being kept in step with it.
    'docker-x86_64': { image: 'ghcr.io/example/app:0.2.0' },
  },
};

describe('release.yml', () => {
  // The reader and the writer are a pair, and this is the only thing holding them to
  // each other: the format has no library behind it, so a change to either alone is a
  // release every installed copy of the app silently stops being able to read.
  test('round trips', () => {
    expect(parseReleaseManifest(writeReleaseManifest(MANIFEST))).toEqual(MANIFEST);
  });

  test('a platform with no files of its own is simply absent', () => {
    const parsed = parseReleaseManifest(writeReleaseManifest(MANIFEST));
    expect(parsed.assets['windows-x86_64']).toBeUndefined();
  });

  test('a version reads back as a string rather than a number', () => {
    expect(parseReleaseManifest('version: 1.0\ntag: v1.0\nassets:\n').version).toBe('1.0');
  });

  test('an unknown platform is refused rather than ignored', () => {
    expect(() => parseReleaseManifest('version: 1.0.0\ntag: v1.0.0\nassets:\n  solaris-sparc:\n    installer: x\n')).toThrow();
  });
});

describe('comparing versions', () => {
  test('orders by dotted number', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '0.10.0')).toBe(false);
  });

  // The rule that matters: a build with a suffix is below the release it is a candidate
  // for, so shipping 1.2.0 does not leave every 1.2.0-rc1 install thinking it is current.
  test('a prerelease is below its own release', () => {
    expect(isNewer('1.2.0', '1.2.0-rc1')).toBe(true);
    expect(isNewer('1.2.0-rc1', '1.2.0')).toBe(false);
  });

  test('a missing part is a zero, so 1.2 and 1.2.0 are the same version', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  test('a leading v is not part of the number', () => {
    expect(compareVersions('v1.3.0', '1.3.0')).toBe(0);
  });
});
