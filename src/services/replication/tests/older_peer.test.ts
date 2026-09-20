import { describe, expect, it } from 'bun:test';
import { applyChanges } from '../apply';
import { LIB, makePeer } from './peers';
import { stamp } from '../stamps';

// What a peer does with a payload from a build older than its own schema
// (docs/replication.md §8.5).
//
// §8.5 covers one direction: a column this peer does not know is preserved rather than dropped.
// This is the other, and it is the one that breaks a session rather than losing a field. A peer
// selects the columns *it* knows, so a column added since is simply absent from what it sends -
// and a receiver that reads absent as NULL either clears a field nobody touched or, where the
// column is NOT NULL, fails a constraint. A NOT NULL failure is not a missing reference, so it is
// not deferred: it throws out of the whole page, and the same page arrives again next session.

describe('a change from a peer that predates a column', () => {
  it('keeps this peer’s own value rather than writing NULL over it', () => {
    const peer = makePeer('older');
    peer.db.query('UPDATE libraries SET include_non_raw = 1, name = ?, stamp = ? WHERE id = ?')
      .run('Trip', stamp(peer.db), LIB);

    // The payload an older build sends: every column of the `library` unit except the one it has
    // never heard of.
    const arriving = stamp(peer.db);
    applyChanges(peer.db, LIB, [
      {
        kind: 'library' as const,
        rowId: LIB,
        deleted: false as const,
        sidecar: null,
        row: {
          id: LIB,
          name: 'Renamed elsewhere',
          ordering: 'taken_asc',
          include_subfolders: 1,
          bin_name: 'Bin',
          auto_stack: 1,
          auto_stack_similarity: 0.78,
          auto_stack_window_seconds: 60,
        },
        stamps: { library: arriving },
      },
    ]);

    const row = peer.db.query('SELECT name, include_non_raw FROM libraries WHERE id = ?').get(LIB) as {
      name: string;
      include_non_raw: number;
    };
    // The rename landed, which is the whole point of accepting the change...
    expect(row.name).toBe('Renamed elsewhere');
    // ...and the column the sender had never heard of is this peer's own, not a NULL and not a
    // rejected page.
    expect(row.include_non_raw).toBe(1);
  });

  // The distinction the guard turns on: a sender that *did* send null means null.
  it('still writes a null the sender actually sent', () => {
    const peer = makePeer('current');
    const arriving = stamp(peer.db);
    applyChanges(peer.db, LIB, [
      {
        kind: 'library' as const,
        rowId: LIB,
        deleted: false as const,
        sidecar: null,
        row: { id: LIB, name: 'Trip', bin_name: null },
        stamps: { library: arriving },
      },
    ]);

    const row = peer.db.query('SELECT bin_name FROM libraries WHERE id = ?').get(LIB) as {
      bin_name: string | null;
    };
    expect(row.bin_name).toBeNull();
  });
});
