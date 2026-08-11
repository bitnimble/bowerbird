// The order the guided filter runs in, held to the other host's answer.
//
// `detail.wgsl` is one file and both hosts compile it, so what the passes *do* has one
// implementation. What is written twice is the sequence: `EditPipeline.buildDetail` walks it
// and `gpu.rs`'s `build_detail` walks its own copy, and a host that reordered it - or ran one
// box mean where the other ran two - would build a different neighbourhood from the same
// frame. The clarity a reader sets in the editor and the clarity in the rendition that follows
// would then be different pictures.
//
// **Nothing else can see that.** The graded parity fixtures are pinned at every slider zero,
// where `adjusted` returns before it samples this texture, so a divergence here changes not one
// committed byte of them.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETAIL_PASSES } from '../shaders';

const TABLE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'gpu',
  'detail-passes.txt',
);

test('the editor filters detail in the order the native host does', () => {
  const committed = readFileSync(TABLE, 'utf8').trim().split('\n');

  expect(committed.length).toBeGreaterThan(0);
  // Widened to `string[]`, so a name this side has and the file does not is a failing
  // comparison rather than a type error nobody reading the diff would connect to the fixture.
  expect(DETAIL_PASSES.map(String)).toEqual(committed);
});
