import { expect, test } from 'bun:test';
import { type Cache, family, stale } from './prune-caches';

const cache = (id: number, key: string, ref: string, created_at: string): Cache => ({
  id,
  key,
  ref,
  created_at,
});

test('a family is the key without the hashes a save moves', () => {
  expect(family('v0-rust-desktop-Darwin-arm64-2eab217e-9b650547')).toBe(
    'v0-rust-desktop-Darwin-arm64',
  );
  expect(
    family('pinned-Linux-wasm-857f755b56b5f65362e783cbcf1dd52772f0c9dc42fd8386d2010065c31c237a'),
  ).toBe('pinned-Linux-wasm');
});

test('only the newest of each family on main survives', () => {
  const caches = [
    cache(
      1,
      'v0-rust-desktop-Darwin-arm64-2eab217e-38b7ccbf',
      'refs/heads/main',
      '2026-09-26T12:16:24Z',
    ),
    cache(
      2,
      'v0-rust-desktop-Darwin-arm64-2eab217e-9b650547',
      'refs/heads/main',
      '2026-09-27T04:59:39Z',
    ),
    cache(
      3,
      'v0-rust-desktop-Darwin-arm64-2eab217e-9b650547',
      'refs/heads/refs/tags/v0.1.6',
      '2026-09-28T00:00:00Z',
    ),
    cache(
      4,
      'pinned-macOS-93bcb0c816137675fb47d3216db1efc1d1300c9c5c4331cd0b6e62956dcd8e86',
      'refs/heads/main',
      '2026-09-24T11:37:15Z',
    ),
    cache(
      5,
      'buildkit-blob-1-sha256:b504ff945610def2fb187b87406d47a500198ce5338cf6d566d72e51166e6729',
      'refs/heads/refs/tags/v0.1.5',
      '2026-09-26T15:06:27Z',
    ),
  ];
  expect(stale(caches).map(({ id }) => id)).toEqual([1, 3, 5]);
});
