import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alreadyPinned, pin, recordPin } from './pinned';

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
