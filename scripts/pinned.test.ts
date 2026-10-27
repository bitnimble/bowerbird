import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alreadyPinned, fetchPinned, linkPinned, pin, pinnedLink, recordPin } from './pinned';

test('a download is tried again after a 503 and not after a 404', async () => {
  const answers = [503, 200, 404];
  let asked = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('weights', { status: answers[asked++] }),
  });
  try {
    const url = `http://localhost:${server.port}/`;
    expect(await (await fetchPinned(url)).text()).toBe('weights');
    expect(asked).toBe(2);
    await expect(fetchPinned(url)).rejects.toThrow('404');
    expect(asked).toBe(3);
  } finally {
    server.stop(true);
  }
}, 10_000);

test('a tree built from other flags is not the pinned one', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bb-pin-'));
  try {
    const recipe = pin('1.4.2', ['-DAVIF_LIBSHARPYUV=SYSTEM']);
    // Nothing recorded: a tree an older getter left behind reads as stale rather than as current.
    expect(alreadyPinned(home, recipe)).toBe(false);

    recordPin(home, recipe);
    expect(alreadyPinned(home, recipe)).toBe(true);

    // The two ways a pin moves, and the failure that started this: a flag changed and the tree
    // built without it stayed exactly where the new one goes.
    expect(alreadyPinned(home, pin('1.4.3', ['-DAVIF_LIBSHARPYUV=SYSTEM']))).toBe(false);
    expect(alreadyPinned(home, pin('1.4.2', []))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('re-pointing a link at an existing tree makes its files newer than the last build', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-relink-'));
  const name = `relink-test-${process.pid}`;
  const LONG_AGO = new Date('2020-01-01T00:00:00Z');
  const tree = (label: string): string => {
    const home = path.join(root, label);
    mkdirSync(home);
    writeFileSync(path.join(home, 'bowerbird-pin.json'), label);
    utimesSync(path.join(home, 'bowerbird-pin.json'), LONG_AGO, LONG_AGO);
    return home;
  };
  const touched = (home: string): boolean =>
    statSync(path.join(home, 'bowerbird-pin.json')).mtimeMs > LONG_AGO.getTime();
  try {
    const older = tree('older');
    const newer = tree('newer');

    linkPinned(name, newer);
    expect(touched(newer)).toBe(false);

    linkPinned(name, newer);
    expect(touched(newer)).toBe(false);

    linkPinned(name, older);
    expect(touched(older)).toBe(true);
  } finally {
    rmSync(pinnedLink(name), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
