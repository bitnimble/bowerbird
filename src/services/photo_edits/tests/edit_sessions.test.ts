import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { neutralEdits, type EditDoc } from '../../../schemas/photo_edits';
import { linkLibrary, registerPeer } from '../../replication/pairing';
import { encodeStamp } from '../../replication/clock';
import type { Cell, LiveChange } from '../../../schemas/replication';
import { page } from '../../replication/stream';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { listConflicts, resolveConflict } from '../conflicts';
import { MAX_CHAIN_HOPS, descends, parkDivergentEdits, parseChain } from '../edit_sessions';
import { PhotoEditsRepository } from '../photo_edits_repository';
import { PhotoEditsService } from '../photo_edits_service';

// Sessions and the divergence they make visible (docs/replication.md §5.3).

const PHOTO = 'photo';
const LIB = 'lib';
const REMOTE_PEER = 'abcdefgh12345678';

let db: Database;
let repo: PhotoEditsRepository;

function edited(over: Partial<EditDoc>): EditDoc {
  return { ...neutralEdits(), ...over };
}

function saveIn(session: string, over: Partial<EditDoc>): void {
  const { doc, rev } = repo.get(PHOTO);
  repo.save(PHOTO, { ...doc, ...over }, rev, session);
}

function stored(): { session_id: string | null; chain: string | null; stamp: string | null } {
  return db.query('SELECT session_id, chain, stamp FROM photo_edits WHERE photo_id = ?').get(PHOTO) as {
    session_id: string | null;
    chain: string | null;
    stamp: string | null;
  };
}

/** A row as replication would hand it over, from a session this peer has never seen. */
function arriving(
  session: string,
  doc: EditDoc,
  chain: [string, string][] = [],
  sidecar: Record<string, Cell> | null = null,
): LiveChange {
  const stamp = encodeStamp(Date.now() + 1000, 0, REMOTE_PEER);
  return {
    kind: 'photo_edits',
    rowId: PHOTO,
    deleted: false,
    row: { photo_id: PHOTO, doc: JSON.stringify(doc), cursor: 0, chain: JSON.stringify(chain), session_id: session },
    stamps: { photo_edits: stamp },
    sidecar,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Library')`).run(LIB);
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, '{"kind":"file","path":"a.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO, LIB);
  linkLibrary(db, LIB);
  registerPeer(db, LIB, REMOTE_PEER, 'Macbook');
  repo = new PhotoEditsRepository(db);
});

// §11.2: what arrives from a peer is remote input, and a chain arrives inside it.
describe('a chain that arrives', () => {
  const hops = (count: number): string =>
    JSON.stringify(Array.from({ length: count }, (_, i) => [`session${i}`, encodeStamp(i, 0, REMOTE_PEER)]));

  it('is capped however long the peer said it was', () => {
    const parsed = parseChain(hops(MAX_CHAIN_HOPS + 500));

    expect(parsed).toHaveLength(MAX_CHAIN_HOPS);
    // The newest kept, as a locally built chain keeps them: those are the hops a
    // recent divergence is decided against.
    expect(parsed[parsed.length - 1]![0]).toBe(`session${MAX_CHAIN_HOPS + 499}`);
  });

  it('keeps a chain that is already short enough exactly as it was', () => {
    expect(parseChain(hops(3))).toHaveLength(3);
  });

  it.each([
    ['not JSON at all', 'not json'],
    ['not an array', '{"session":"x"}'],
    ['not a string', 42],
    ['absent', null],
  ])('reads %s as no chain rather than throwing', (_what, raw) => {
    expect(parseChain(raw)).toEqual([]);
  });

  it('drops the hops it cannot read and keeps the ones it can', () => {
    const mixed = JSON.stringify([['ok', encodeStamp(1, 0, REMOTE_PEER)], ['short'], 'nope', [1, 2]]);

    expect(parseChain(mixed)).toEqual([['ok', encodeStamp(1, 0, REMOTE_PEER)]]);
  });
});

describe('a session on a save', () => {
  it('stays put while one editor is open, and records the hop when the next one opens', () => {
    saveIn('session1', { exposure: 0.5 });
    saveIn('session1', { exposure: 0.75 });

    expect(stored().session_id).toBe('session1');
    expect(parseChain(stored().chain)).toEqual([]);
    const lastOfSession1 = stored().stamp ?? '';

    saveIn('session2', { exposure: 1 });

    expect(stored().session_id).toBe('session2');
    // The hop carries session1's *last* stamp, which is what tells a merge
    // "built on that state" from "built on an older save of it".
    expect(parseChain(stored().chain)).toEqual([['session1', lastOfSession1]]);
  });

  it('descends from a session it names at that stamp or later, and not from a later save of it', () => {
    const chain: [string, string][] = [['session1', 'bbbb']];
    expect(descends({ session: 'session2', stamp: 'cccc', chain }, { session: 'session1', stamp: 'bbbb' })).toBe(true);
    expect(descends({ session: 'session2', stamp: 'cccc', chain }, { session: 'session1', stamp: 'aaaa' })).toBe(true);
    expect(descends({ session: 'session2', stamp: 'cccc', chain }, { session: 'session1', stamp: 'dddd' })).toBe(false);
  });
});

describe('a divergence', () => {
  it('parks both candidates when neither side descends from the other', () => {
    saveIn('here', { exposure: 0.5 });
    parkDivergentEdits(db, arriving('there', edited({ exposure: -0.5 })));

    const conflicts = listConflicts(db, LIB);
    expect(conflicts.map((c) => c.session_id).sort()).toEqual(['here', 'there']);
    // The candidate the other peer stamped is named by that peer.
    expect(conflicts.find((c) => c.session_id === 'there')?.device).toBe('Macbook');
    expect(conflicts.find((c) => c.session_id === 'there')?.doc.exposure).toBe(-0.5);
  });

  // The card is gone for whoever pressed the button; every other window is still
  // offering a decision that has been made, and nothing here polls for it.
  it('announces the library it ended a divergence in', () => {
    saveIn('here', { exposure: 0.5 });
    parkDivergentEdits(db, arriving('there', edited({ exposure: -0.5 })));
    const announced: string[] = [];
    const service = new PhotoEditsService(
      db,
      repo,
      new PhotoListingRepository(db),
      () => {},
      (libraryId) => announced.push(libraryId),
    );

    service.resolve(PHOTO, 'there');

    expect(listConflicts(db, LIB)).toEqual([]);
    expect(announced).toEqual([LIB]);
  });

  /**
   * §11.2: a session id is remote input, and a conflict's log row id is
   * `photo_id/session_id`.
   *
   * Both sides that read one back split on `/` and require exactly two parts, so a
   * session id carrying one mints a row that neither the stream nor the apply can
   * parse. It sits at a fixed stamp, so every later session throws on it in both
   * directions - one hostile or buggy peer, and that library never replicates
   * again. The edit itself still merges by stamp; only the card is refused.
   */
  it('refuses to park under a session id that cannot be streamed', () => {
    saveIn('here', { exposure: 0.5 });

    parkDivergentEdits(db, arriving('there/and-back', edited({ exposure: -0.5 })));

    expect(listConflicts(db, LIB)).toEqual([]);
    expect(db.query('SELECT row_id FROM replication_log WHERE entity = ?').all('edit_conflict')).toEqual([]);
  });

  /**
   * And a catalogue that already holds one goes on replicating.
   *
   * A conflict's log row id is `photo_id/session_id`, so a slash in one makes an id
   * that will not come apart, and a side that throws reading one back stops replicating
   * for good: a page is rebuilt from the same log position every session, so the throw
   * repeats in both directions over a row no peer could ever have used, and the holder
   * cannot even stream it out.
   */
  it('streams past a parked conflict whose row id will not come apart', () => {
    saveIn('here', { exposure: 0.5 });
    // As one arrived before anything checked: parked, and in the log.
    db.query(
      `INSERT INTO edit_conflicts (photo_id, session_id, doc, cursor, chain, stamp)
         VALUES (?, 'left/right', '{}', 0, '[]', ?)`,
    ).run(PHOTO, encodeStamp(Date.now(), 0, REMOTE_PEER));

    const streamed = page(db, LIB, new Map(), '');

    expect(streamed.changes.some((change) => change.kind === 'edit_conflict')).toBe(false);
    // The rest of the library still travels, which is the whole point.
    expect(streamed.changes.some((change) => change.kind === 'photo_edits')).toBe(true);
  });

  // The grave as well as the row. A tombstone names the same id and the far side
  // takes it apart in the same place, so sending one is asking that peer to fail
  // where this one chose not to.
  it('streams past the grave of one too', () => {
    saveIn('here', { exposure: 0.5 });
    db.query(
      `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted)
         VALUES (?, 'edit_conflict', ?, ?, 1)`,
    ).run(LIB, `${PHOTO}/left/right`, encodeStamp(Date.now(), 0, REMOTE_PEER));

    const streamed = page(db, LIB, new Map(), '');

    expect(streamed.changes.some((change) => change.kind === 'edit_conflict')).toBe(false);
    expect(streamed.changes.some((change) => change.kind === 'photo_edits')).toBe(true);
  });

  // Either side can be the one carrying it. A `photo_edits` row's own id is the
  // photograph alone, so a peer that pushed one before the guard existed left a
  // session id here that nothing had reason to look at - and it is the *held* side
  // that gets parked under it.
  it('refuses just as firmly when the unstreamable id is the one already here', () => {
    saveIn('here/and-there', { exposure: 0.5 });

    parkDivergentEdits(db, arriving('there', edited({ exposure: -0.5 })));

    expect(listConflicts(db, LIB)).toEqual([]);
    expect(db.query('SELECT row_id FROM replication_log WHERE entity = ?').all('edit_conflict')).toEqual([]);
  });

  it('parks nothing when the arriving row was built on what is held here', () => {
    saveIn('here', { exposure: 0.5 });
    const held = stored();
    if (held.stamp == null) throw new Error('no stamp');
    parkDivergentEdits(db, arriving('there', edited({ exposure: -0.5 }), [['here', held.stamp]]));

    expect(listConflicts(db, LIB)).toEqual([]);
  });

  it('resolves by branching from what the row holds now, and tombstones both candidates', () => {
    saveIn('here', { exposure: 0.5 });
    parkDivergentEdits(db, arriving('there', edited({ exposure: -0.5 })));
    // Work continued on the provisional winner while the conflict sat there.
    saveIn('here', { contrast: 0.25 });
    const before = repo.get(PHOTO).rev;

    resolveConflict(db, repo, PHOTO, 'there', 'session-resolve');

    const after = repo.get(PHOTO);
    expect(after.doc.exposure).toBe(-0.5);
    // A save, not an overwrite: the revision moved and the step it replaced is
    // reachable through undo.
    expect(after.rev).toBe(before + 1);
    expect(after.canUndo).toBe(true);
    expect(listConflicts(db, LIB)).toEqual([]);

    const buried = db
      .query("SELECT row_id FROM replication_log WHERE entity = 'edit_conflict' AND deleted = 1")
      .all() as { row_id: string }[];
    expect(buried.map((row) => row.row_id).sort()).toEqual([`${PHOTO}/here`, `${PHOTO}/there`]);
  });
});
