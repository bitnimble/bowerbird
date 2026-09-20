// Where an install looks for updates. The consequence of getting this wrong is an app
// fetching executables from somewhere nobody chose, so each branch is spelled out.
import { expect, test } from 'bun:test';
import { GITHUB_REPO, downloadUrl, updateSource } from '../update_source';

// Against the constant rather than the literal: it is the one place the repository is
// written down, and a fork that changes it should not have to change this too.
test('nothing set is github.com and this repository', () => {
  const source = updateSource({});
  expect(source.releases).toBe(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`);
  expect(source.assetUrl('v0.2.0', 'p.tar.gz')).toBe(
    `https://github.com/${GITHUB_REPO}/releases/download/v0.2.0/p.tar.gz`,
  );
});

test('a repository names a different one on github.com', () => {
  const source = updateSource({ BOWERBIRD_UPDATE_REPO: 'someone/fork' });
  expect(source.releases).toContain('/repos/someone/fork/releases');
  expect(source.assetUrl('v1.0.0', 'p.tar.gz')).toBe(
    'https://github.com/someone/fork/releases/download/v1.0.0/p.tar.gz',
  );
});

// The point of the setting: an endpoint that is not GitHub at all.
test('a URL is taken whole, and wins over a repository', () => {
  const source = updateSource({
    BOWERBIRD_UPDATE_URL: 'https://releases.example.invalid/bowerbird.json',
    BOWERBIRD_UPDATE_REPO: 'someone/fork',
  });
  expect(source.releases).toBe('https://releases.example.invalid/bowerbird.json');
});

// Either one, emptied, means "make no outbound request" - there is no endpoint and no
// repository to ask, and both say the same thing.
test('an empty URL turns checking off', () => {
  expect(updateSource({ BOWERBIRD_UPDATE_URL: '' }).releases).toBeNull();
  expect(updateSource({ BOWERBIRD_UPDATE_URL: '   ' }).releases).toBeNull();
});

test('an empty repository turns checking off', () => {
  expect(updateSource({ BOWERBIRD_UPDATE_REPO: '' }).releases).toBeNull();
});

test('a filename is encoded into the path', () => {
  expect(updateSource({}).assetUrl('v1.0.0', 'Bowerbird 1.0.0.dmg')).toContain('Bowerbird%201.0.0.dmg');
});

// The one that would bite an air-gapped deployment silently: an endpoint somewhere else
// has no relationship to any repository, so a release of its that named no assets used to
// fall back to a guessed URL on the *public* github.com repo - and fetch a checksum and a
// payload from a host the operator had configured this precisely never to talk to.
test('a custom endpoint has no github.com to fall back to', () => {
  const source = updateSource({ BOWERBIRD_UPDATE_URL: 'https://releases.example.invalid/list.json' });
  expect(source.assetUrl('v1.0.0', 'p.tar.gz')).toBeNull();
});

test('a custom endpoint does not borrow the repository setting either', () => {
  const source = updateSource({
    BOWERBIRD_UPDATE_URL: 'https://releases.example.invalid/list.json',
    BOWERBIRD_UPDATE_REPO: 'someone/fork',
  });
  expect(source.assetUrl('v1.0.0', 'p.tar.gz')).toBeNull();
});

// `.env` files, configmaps mounted as files and copy-paste all bring their own whitespace.
// Trimmed only to decide emptiness, a padded value reads as set and then builds a URL with
// a newline in the middle of the path.
test('a repository is trimmed before it is used, not only before it is measured', () => {
  const source = updateSource({ BOWERBIRD_UPDATE_REPO: '  someone/fork\n' });
  expect(source.releases).toBe('https://api.github.com/repos/someone/fork/releases?per_page=30');
  expect(source.assetUrl('v1.0.0', 'p.tar.gz')).toBe(
    'https://github.com/someone/fork/releases/download/v1.0.0/p.tar.gz',
  );
});

test('a repository of whitespace alone turns checking off', () => {
  expect(updateSource({ BOWERBIRD_UPDATE_REPO: '   ' }).releases).toBeNull();
});

const FALLBACK = `https://github.com/${GITHUB_REPO}/releases/download/v1.0.0/p.tar.gz`;

test('a release that reports where its own file is, is believed', () => {
  expect(downloadUrl('https://mirror.example.invalid/p.tar.gz', FALLBACK)).toBe('https://mirror.example.invalid/p.tar.gz');
  expect(downloadUrl('HTTP://mirror.example.invalid/p.tar.gz', FALLBACK)).toBe('HTTP://mirror.example.invalid/p.tar.gz');
});

test('a release that reports nothing gets the constructed URL', () => {
  expect(downloadUrl(undefined, FALLBACK)).toBe(FALLBACK);
});

test('a release that reports nothing, with nothing to construct, is nothing', () => {
  expect(downloadUrl(undefined, null)).toBeNull();
  expect(downloadUrl('file:///etc/passwd', null)).toBeNull();
});

// Bun's `fetch` follows `file://`, so an asset URL that is not http(s) would turn a
// download into a local read. Not a privilege boundary - the same endpoint publishes the
// checksum - but it must not happen by accident and go unnoticed.
test('an asset URL that is not http(s) is not followed', () => {
  expect(downloadUrl('file:///etc/passwd', FALLBACK)).toBe(FALLBACK);
  expect(downloadUrl('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
  expect(downloadUrl('ftp://example.invalid/p.tar.gz', FALLBACK)).toBe(FALLBACK);
  expect(downloadUrl('', FALLBACK)).toBe(FALLBACK);
  expect(downloadUrl('  https://sneaky.invalid/p', FALLBACK)).toBe(FALLBACK);
});
