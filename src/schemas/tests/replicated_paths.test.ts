// The validation boundary a replicated row crosses (docs/replication.md §11.2).
//
// Every clause gets a case that ONLY it rejects. The end-to-end poison suite in
// `replication_api.test.ts` proves the boundary is wired up at all; it cannot
// prove which refinement fired, and its inputs are caught by several at once - so
// deleting the drive-letter test, or the NUL, or the "bin cannot be `..`" clause
// leaves it green while a peer lands a path outside the library root.
import { describe, expect, it } from 'bun:test';
import { ChangeSchema, ReplicatedPathSchema } from '../replication';

const NUL = String.fromCharCode(0);

// Reached through a `library` change, which is the only thing carrying one. The
// surrounding change is valid on purpose: built wrong, every case here would be
// refused for the shape rather than the name, and the refusals would pass while
// proving nothing.
function change(row: Record<string, string | null>): { success: boolean } {
  return ChangeSchema.safeParse({
    kind: 'library',
    rowId: 'lib00000000000000',
    deleted: false,
    row,
    stamps: { library: `0000000000000000peeraaaaaaaaaaaa` },
    sidecar: null,
  });
}

function binName(name: string): { success: boolean } {
  return change({ bin_name: name });
}

describe('a replicated path (§11.2)', () => {
  it.each([
    ['an absolute posix path', '/etc/passwd'],
    // Relative, no empty segment, no dot segment: the leading-slash test and the
    // segment test both pass it, and only the drive-letter clause refuses.
    ['a windows drive letter', 'C:/Windows/system32/evil.arw'],
    ['a lowercase drive letter', 'c:/Windows/evil.arw'],
    ['a backslash separator', 'Day1\\evil.arw'],
    // No separator and no dot segment, so this one rests on the NUL clause alone.
    ['an embedded NUL', `Day1${NUL}.arw`],
    ['a parent segment', 'Day1/../../evil.arw'],
    ['a bare parent segment', '../evil.arw'],
    ['a current-directory segment', 'Day1/./evil.arw'],
    ['a doubled separator', 'Day1//evil.arw'],
    ['nothing at all', ''],
  ])('refuses %s', (_what, candidate) => {
    expect(ReplicatedPathSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['an ordinary relative path', 'Day1/alpha.arw'],
    ['a file at the root', 'alpha.arw'],
    // A dot inside a segment is not a dot segment, and a name may hold one.
    ['a dotted file name', 'Day1/alpha.2.arw'],
    ['a name that merely starts with a dot', 'Day1/.hidden.arw'],
    // Not a drive letter: the colon is not at position 1.
    ['a colon later in the name', 'Day1/alpha:2.arw'],
  ])('accepts %s', (_what, candidate) => {
    expect(ReplicatedPathSchema.safeParse(candidate).success).toBe(true);
  });
});

describe('a replicated bin name (§11.2)', () => {
  // The harness itself, so a refusal below is the name's doing and not the
  // change's: this is the same shape with a name nothing objects to.
  it('is reached through a change that is otherwise valid', () => {
    expect(change({ bin_name: 'Bin' }).success).toBe(true);
    expect(change({ bin_name: null }).success).toBe(true);
  });


  it.each([
    ['a separator', 'Bin/inner'],
    ['a backslash', 'Bin\\inner'],
    // The one that moves the bin to the library root's *parent*, so binning a
    // photograph carries it out of the library entirely.
    ['the parent directory', '..'],
    ['the current directory', '.'],
    ['an embedded NUL', `Bin${NUL}x`],
    ['nothing at all', ''],
  ])('refuses %s', (_what, name) => {
    expect(binName(name).success).toBe(false);
  });

  it.each([
    ['an ordinary name', 'Bin'],
    ['a name with a dot in it', 'Bin.old'],
    ['a name with a space', 'Deleted photos'],
  ])('accepts %s', (_what, name) => {
    expect(binName(name).success).toBe(true);
  });
});
