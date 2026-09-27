import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alreadyPinned, fetchPinned, pin, recordPin } from './pinned';

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
