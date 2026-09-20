// Values written down twice, on two sides of a boundary a compiler cannot see across.
//
// Each of these is a comment saying "this is that", with nothing behind the claim. They are
// not import-able: one is a private Rust const the FFI does not carry, and the others are
// string literals matched by hand in TypeScript against string literals emitted by Rust. So
// the files are read and the values compared, which is the same thing
// `manifest_parity.integration.test.ts` does for the two Cargo manifests and for the same
// reason - a rename on one side is silent, and stays silent until somebody notices the
// symptom weeks later.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The first capture of `pattern`, or a failure that says which file was being read. */
function only(path: string, pattern: RegExp): string {
  const found = pattern.exec(read(path));
  expect(found, `${path} no longer contains ${pattern}`).not.toBeNull();
  return found?.[1] ?? '';
}

// The peak quantile's population used to be pinned here: `tone::QUANTILE_SAMPLES` against a
// `PEAK_SAMPLES` the client kept, because the two taking their rank over different populations
// is a different picture at the top of every frame bright enough to roll off.
//
// There is one copy now. The client stopped computing the peak's sampling at all - the stride
// and the population arrive in `PreparedHeader.tick`, built by `gpu::uniform_words`, which is
// also where the shader reads them - so `PEAK_SAMPLES` is gone and there is no second value to
// hold this one to. Recorded rather than silently dropped, because "this pin disappeared" and
// "this pin was deleted because the duplication it guarded went away" look identical in a diff.

describe('the library event channel', () => {
  // The shell emits on a Tauri channel and the page listens on one, by name, in two files.
  // Rename it on the Rust side and nothing fails: `events_following` still reports connected
  // because it reads its own static, so the desktop suite passes while no event ever reaches
  // a view again - the grid simply stops noticing renditions being written.
  test('is the one the page listens on', () => {
    const rust = only('src-tauri/src/events.rs', /const CHANNEL: &str = "([^"]+)";/);
    const web = read('web/src/api/transport.ts');
    expect(web).toContain(`listen('${rust}'`);
  });

  // Same for the vocabulary inside it. `kind` is a string the Rust writes and the TypeScript
  // matches on, so a third kind added to one side and not the other is dropped in silence.
  test('carries the kinds the page knows how to read', () => {
    const rust = read('src-tauri/src/events.rs');
    const web = read('web/src/api/transport.ts');
    const written = [...rust.matchAll(/kind: "([a-z]+)"\.to_string\(\)/g)];
    // Or the sweep below runs over nothing and passes by finding no work, which is how a
    // parse-based check rots: the shell changes how it builds `Emitted` and this quietly
    // becomes an assertion about the one kind hand-added underneath.
    expect(written.length, 'events.rs no longer writes any kind this can see').toBeGreaterThan(0);
    const emitted = new Set(written.map((match) => match[1] ?? ''));
    // `rendition` is the SSE event's own name, forwarded rather than written here, so it is
    // named where the reader picks it up rather than where the shell emits it.
    emitted.add('rendition');
    for (const kind of emitted) {
      expect(web, `transport.ts does not handle the "${kind}" event`).toContain(`'${kind}'`);
    }
  });
});
