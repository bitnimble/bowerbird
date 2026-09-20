// `stack_members` is what replicates and `photos.stack_id` is its materialised
// view (docs/replication.md §3.3). Two places holding one fact is a bug waiting
// for a second writer, so what these pin is that the pair cannot come apart -
// whichever way membership was changed.
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { stamp } from '../../replication/stamps';
import { StackMembership } from '../stack_membership';

const LIB = 'lib';

let db: Database;
let members: StackMembership;

function photo(id: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(id, LIB, `${id}.arw`);
}

function stack(id: string): void {
  db.query("INSERT INTO stacks (id, library_id, origin, date_created) VALUES (?, ?, 'manual', '2026-01-01')").run(
    id,
    LIB,
  );
}

/** Every disagreement between the view column and the rows behind it. */
function drift(): string[] {
  const rows = db
    .query(
      `SELECT p.id, p.stack_id AS view, (SELECT m.stack_id FROM stack_members m WHERE m.photo_id = p.id) AS truth
         FROM photos p
        WHERE p.stack_id IS NOT (SELECT m.stack_id FROM stack_members m WHERE m.photo_id = p.id)`,
    )
    .all() as { id: string; view: string | null; truth: string | null }[];
  return rows.map((row) => `${row.id}: column ${row.view} vs rows ${row.truth}`);
}

function stateOf(id: string): { stack_id: string | null; stack_state: string; is_representative: number; stamp_stack: string | null } {
  return db.query('SELECT stack_id, stack_state, is_representative, stamp_stack FROM photos WHERE id = ?').get(id) as never;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Trip')").run(LIB);
  members = new StackMembership(db);
  for (const id of ['p1', 'p2', 'p3']) photo(id);
  stack('s1');
  stack('s2');
});

describe('StackMembership', () => {
  it('writes the rows and the column together', () => {
    members.add('s1', ['p1', 'p2']);

    expect(drift()).toEqual([]);
    expect(stateOf('p1').stack_id).toBe('s1');
    expect(stateOf('p1').stack_state).toBe('stacked');
  });

  // The column can hold one stack, so joining a second has to be a move rather
  // than an addition, or the two would disagree about which one it is.
  it('takes a photograph out of the stack it was in when it joins another', () => {
    members.add('s1', ['p1']);
    members.add('s2', ['p1']);

    expect(drift()).toEqual([]);
    expect(stateOf('p1').stack_id).toBe('s2');
    expect(db.query('SELECT COUNT(*) AS n FROM stack_members WHERE photo_id = ?').get('p1')).toEqual({ n: 1 });
  });

  // The stack it left has to be re-ranked *after* it has gone, not before: ranked
  // while the column still names the old stack, the leaver can be chosen to stand
  // for it and then have the flag cleared on its way out, leaving that stack with
  // no member standing for it at all - which is a stack absent from every listing.
  it('leaves the stack it came from with a member still standing for it', () => {
    members.add('s1', ['p1', 'p3']);
    // p3 is the one the ranking would choose, which is what makes this the
    // adversarial case rather than a lucky one.
    members.add('s2', ['p3']);

    expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_representative = 1').get('s1')).toEqual(
      { n: 1 },
    );
    expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_representative = 1').get('s2')).toEqual(
      { n: 1 },
    );
  });

  it('clears both when a photograph leaves', () => {
    members.add('s1', ['p1', 'p2']);
    expect(members.remove('s1', ['p1'], false)).toBe(1);

    expect(drift()).toEqual([]);
    expect(stateOf('p1').stack_id).toBeNull();
    expect(stateOf('p1').stack_state).toBe('none');
  });

  // 'unstacked' is a human saying no, and detection never claims such a
  // photograph again; 'none' is detection tidying up after itself (§19.4.4).
  it('records whether a human released the photograph or a pass merely re-sorted it', () => {
    members.add('s1', ['p1', 'p2']);
    members.remove('s1', ['p1'], true);

    expect(stateOf('p1').stack_state).toBe('unstacked');
  });

  it('leaves a photograph alone when the stack named is not the one it is in', () => {
    members.add('s1', ['p1']);
    expect(members.remove('s2', ['p1'], true)).toBe(0);

    expect(stateOf('p1').stack_id).toBe('s1');
    expect(stateOf('p1').stack_state).toBe('stacked');
  });

  it('empties both when a stack is cleared', () => {
    members.add('s1', ['p1', 'p2', 'p3']);
    members.clear('s1', false, stamp(db));

    expect(drift()).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS n FROM stack_members').get()).toEqual({ n: 0 });
  });

  // Out of a stack a photograph stands for itself, and the listing shows a row
  // with no stack on that flag alone: left at 0 it would vanish from every
  // listing while the total went on counting it.
  it('leaves exactly one member standing for the stack, and every loose photograph standing for itself', () => {
    members.add('s1', ['p1', 'p2', 'p3']);
    expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_representative = 1').get('s1')).toEqual(
      { n: 1 },
    );

    members.remove('s1', ['p1'], false);
    expect(stateOf('p1').is_representative).toBe(1);
    expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_representative = 1').get('s1')).toEqual(
      { n: 1 },
    );
  });

  // The human verdict is what replicates; which stack a photograph landed in is
  // derived from the membership rows, so it needs no stamp of its own.
  it('stamps the verdict a membership change carries', () => {
    members.add('s1', ['p1']);
    const stacked = stateOf('p1').stamp_stack;
    expect(stacked).not.toBeNull();

    members.remove('s1', ['p1'], true);
    expect(stateOf('p1').stamp_stack! > stacked!).toBe(true);
  });

  // One gesture, one stamp: stamping each row separately would let a merge take
  // half of a stack somebody made.
  it('stamps one gesture once, however many photographs it moved', () => {
    members.add('s1', ['p1', 'p2', 'p3']);

    const stamps = (db.query('SELECT DISTINCT stamp_stack FROM photos WHERE stack_id = ?').all('s1') as {
      stamp_stack: string;
    }[]).map((row) => row.stamp_stack);
    expect(stamps).toHaveLength(1);
  });
});
