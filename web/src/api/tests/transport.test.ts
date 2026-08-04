// The two transports have to agree, and the places they quietly did not.
import { afterEach, describe, expect, test } from 'bun:test';
import { assetUrl } from '../transport';

type Internals = { convertFileSrc?: (file: string, protocol: string) => string };
const global = globalThis as { __TAURI_INTERNALS__?: Internals };

afterEach(() => {
  delete global.__TAURI_INTERNALS__;
});

/** What `tauri/scripts/core.js` emits, verbatim, for each platform it distinguishes. */
function shell(osName: 'windows' | 'android' | 'macos'): void {
  global.__TAURI_INTERNALS__ = {
    convertFileSrc: (file, protocol) =>
      osName === 'windows' || osName === 'android'
        ? `http://${protocol}.localhost/${encodeURIComponent(file)}`
        : `${protocol}://localhost/${encodeURIComponent(file)}`,
  };
}

describe('assetUrl', () => {
  test('is the path itself in a browser', () => {
    expect(assetUrl('/image/abc/renditions/grid')).toBe('/image/abc/renditions/grid');
  });

  // The bug this exists for: the prefix was hardcoded to the macOS and Linux form, so on the
  // two platforms this branch added builds for, every rendition, download and event stream
  // resolved to a scheme the webview has no handler for.
  test.each([
    ['macos', 'bowerbird://localhost/image/abc/renditions/grid'],
    ['windows', 'http://bowerbird.localhost/image/abc/renditions/grid'],
    ['android', 'http://bowerbird.localhost/image/abc/renditions/grid'],
  ] as const)('follows the platform: %s', (osName, expected) => {
    shell(osName);
    expect(assetUrl('/image/abc/renditions/grid')).toBe(expected);
  });

  // It is handed the empty string precisely because it percent-encodes what it is given, so
  // a path passed through it would come back with its slashes escaped.
  test('does not let the helper encode our path', () => {
    shell('windows');
    expect(assetUrl('/api/events')).toBe('http://bowerbird.localhost/api/events');
  });

  test('falls back to the bare path where the helper is absent', () => {
    global.__TAURI_INTERNALS__ = {};
    expect(assetUrl('/api/events')).toBe('/api/events');
  });
});
