// `Cargo.cef.toml` is copied over `Cargo.toml` to build the Linux shell on Tauri's `feat/cef`
// branch, so anything only the real manifest carries is absent from a CEF build. That is
// stated in the file's own header and was still not enough: `tokio` was added for the event
// stream and not mirrored, and the CEF build stopped compiling at all - E0433 in six places -
// where nothing in the repo builds it and nothing would have said so.
//
// A mirror maintained by hand needs something that reads both. The differences below are the
// ones the CEF build exists for; everything else has to match, and a new dependency has to be
// added to both or this fails.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const REAL = join(ROOT, 'src-tauri', 'Cargo.toml');
const CEF = join(ROOT, 'src-tauri', 'Cargo.cef.toml');

// Tauri itself is the difference: crates.io on one side, the branch on the other, and split
// across two `[target]` blocks there so Linux alone takes `cef`. The plugins are the other:
// they do not compile against the branch, which is why the two files exist.
const TAURI_FAMILY = /^tauri(-|$)/;

interface Manifest {
  package?: Record<string, unknown>;
  lib?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  'build-dependencies'?: Record<string, unknown>;
  features?: Record<string, unknown>;
  profile?: { release?: Record<string, unknown> };
  target?: Record<string, { dependencies?: Record<string, unknown> }>;
}

async function read(path: string): Promise<Manifest> {
  return (await import(path)) as Manifest;
}

/** Every dependency the crate takes, wherever it is declared, minus the Tauri family. */
function ownDependencies(manifest: Manifest): Record<string, unknown> {
  const all = { ...manifest.dependencies };
  for (const block of Object.values(manifest.target ?? {})) {
    Object.assign(all, block.dependencies);
  }
  for (const name of Object.keys(all)) {
    if (TAURI_FAMILY.test(name)) delete all[name];
  }
  return all;
}

describe('the CEF manifest', () => {
  test('takes the same dependencies as the real one, on the same terms', async () => {
    const real = ownDependencies(await read(REAL));
    const cef = ownDependencies(await read(CEF));

    // Named rather than counted, so a failure says which crate and which way round.
    expect(Object.keys(cef).sort()).toEqual(Object.keys(real).sort());
    // And on the same terms: a mirrored name with different features or a missing
    // `default-features = false` is the same class of divergence, one build deep.
    expect(cef).toEqual(real);
  });

  test('describes the same crate', async () => {
    const real = await read(REAL);
    const cef = await read(CEF);
    expect(cef.package).toEqual(real.package);
    expect(cef.lib).toEqual(real.lib);
    expect(cef.features).toEqual(real.features);
  });

  // Cargo reads profiles from the top-level package only, so this file is the only place a
  // CEF build can get them. Without `overflow-checks` it runs the decode with wrapping
  // arithmetic where every other build does not, which is a picture that comes out wrong
  // rather than a crash - and nothing about the binary would look unusual.
  test('builds on the same release profile', async () => {
    const real = await read(REAL);
    const cef = await read(CEF);
    expect(cef.profile?.release).toEqual(real.profile?.release);
  });
});
