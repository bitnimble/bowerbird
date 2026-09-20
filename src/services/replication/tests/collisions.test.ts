// A change this peer cannot write because another row here already holds the value, as opposed to one
// it cannot write yet (docs/replication.md §5.1, which `references.test.ts` covers).
//
// `shoots` is unique on `(library_id, folder_path)` and this is the collision that reaches it: two
// peers each rename a different folder to the same name while apart, and no peer can hold both. There
// is no order of arrival that makes it fit, so what is being pinned is that it costs one rename rather
// than the library.
import { describe, expect, it } from 'bun:test';
import { ShootsRepository } from '../../shoots/shoots_repository';
import { pull } from '../session';
import { stamp } from '../stamps';
import { LIB, makePeer, type Peer } from './peers';

function shoot(peer: Peer, id: string, folder: string): void {
  peer.db
    .query('INSERT INTO shoots (id, library_id, name, folder_path, stamp) VALUES (?, ?, ?, ?, ?)')
    .run(id, LIB, folder, folder, stamp(peer.db));
}

function photo(peer: Peer, id: string): void {
  peer.db
    .query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported)
         VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, LIB, `${id}.arw`, stamp(peer.db));
}

function folderOf(peer: Peer, shootId: string): string {
  return (peer.db.query('SELECT folder_path FROM shoots WHERE id = ?').get(shootId) as { folder_path: string })
    .folder_path;
}

/**
 * Both peers hold both shoots, then each renames a different one onto the same folder.
 *
 * The rename is what the scan does when it finds a folder moved on disk (§9.4.1), so this is two
 * machines whose trees have genuinely diverged rather than a request anybody made twice. `first` is the
 * peer whose rename happens earlier, which is the whole of what decides the outcome.
 */
function bothRenamedOnto(folder: string, first: 'server' | 'laptop' = 'server'): { server: Peer; laptop: Peer } {
  const server = makePeer('server');
  const laptop = makePeer('laptop');
  for (const peer of [server, laptop]) {
    shoot(peer, 's1', 'One');
    shoot(peer, 's2', 'Two');
  }
  pull(laptop, server, 50);
  pull(server, laptop, 50);

  // Each peer keeps its own clock, so "first" is not the order these lines run in - it is whose stamp
  // is lower. Only the later renamer is advanced, which is what puts its rename after the other's
  // rather than alongside it, where nothing but the peer id would separate them.
  const [early, late] =
    first === 'server' ?
      ([
        { peer: server, id: 's1', from: 'One' },
        { peer: laptop, id: 's2', from: 'Two' },
      ] as const)
    : ([
        { peer: laptop, id: 's2', from: 'Two' },
        { peer: server, id: 's1', from: 'One' },
      ] as const);
  new ShootsRepository(early.peer.db).relocate(early.id, early.from, folder);
  late.peer.advance(1000);
  new ShootsRepository(late.peer.db).relocate(late.id, late.from, folder);
  return { server, laptop };
}

/**
 * Sessions until there is nothing left to say, in both directions.
 *
 * Rather than a hand-counted sequence: settling this costs more than one session by design. The peer
 * that rejects a rename is the one that still knows where the folder came from, so its re-assertion has
 * to reach the other peer before the winning rename has anywhere to land - and which peer that is
 * depends on which renamed first, not on who pulled.
 */
function settle(server: Peer, laptop: Peer): void {
  for (let round = 0; round < 3; round++) {
    pull(laptop, server, 50);
    pull(server, laptop, 50);
  }
}

describe('two peers renaming different folders onto one name', () => {
  /**
   * The failure this exists for: the write throws, the page is refused, and because the page is
   * refused nothing in it is claimed - so it arrives again next session and throws again. One
   * contested folder name stops that library replicating anything at all, in both directions, for
   * good, and what is in those pages is photographs.
   */
  it('costs the rename and not the rest of the page', () => {
    const { server, laptop } = bothRenamedOnto('Contested');
    // Something else in the same pages, minted after the rename so it cannot page ahead of it.
    server.advance();
    photo(server, 'p1');

    expect(() => pull(laptop, server, 50)).not.toThrow();

    expect(laptop.db.query('SELECT COUNT(*) AS n FROM photos WHERE id = ?').get('p1')).toEqual({ n: 1 });
  });

  /**
   * The rule: the earlier rename keeps the folder, and the later one gives it up.
   *
   * The loser lands on the contested name suffixed rather than back where it came from, and that is the
   * fallback doing its job rather than the preference being ignored: the peer applying the *winning*
   * rename is the one that has to free the folder, and it is the only peer that cannot say where the
   * loser came from - that is the other peer's row. So it takes `Contested_2` under a stamp of its own,
   * which is what both peers then agree on.
   */
  it('gives the folder to the shoot that was renamed first', () => {
    const { server, laptop } = bothRenamedOnto('Contested', 'server');

    settle(server, laptop);

    expect([folderOf(server, 's1'), folderOf(server, 's2')]).toEqual(['Contested', 'Contested_2']);
    expect([folderOf(laptop, 's1'), folderOf(laptop, 's2')]).toEqual(['Contested', 'Contested_2']);
  });

  // The same pair with the renames the other way round, which has to reach the other answer: what
  // decides it is which rename came first, not which shoot or which peer.
  it('gives it the other way when the other rename came first', () => {
    const { server, laptop } = bothRenamedOnto('Contested', 'laptop');

    settle(server, laptop);

    expect([folderOf(server, 's1'), folderOf(server, 's2')]).toEqual(['Contested_2', 'Contested']);
    expect([folderOf(laptop, 's1'), folderOf(laptop, 's2')]).toEqual(['Contested_2', 'Contested']);
  });

  /**
   * A folder held by a shoot with no stamp, which is what a payload carrying no `shoot` unit inserts:
   * the folder comes off the identity columns and the stamp stays NULL.
   *
   * No peer has been told where that one sits, so it has the weaker claim of the two rather than an
   * unrankable one - it is the row that moves, and the arriving rename lands.
   */
  it('moves a folder held by a shoot no peer has been told about', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'One');
    shoot(laptop, 's1', 'One');
    pull(laptop, server, 50);
    server.advance();
    new ShootsRepository(server.db).relocate('s1', 'One', 'Contested');
    // Standing on the folder with no stamp of its own, as an identity-only insert leaves one.
    laptop.db
      .query('INSERT INTO shoots (id, library_id, name, folder_path) VALUES (?, ?, ?, ?)')
      .run('s9', LIB, 'Contested', 'Contested');

    expect(() => pull(laptop, server, 50)).not.toThrow();

    expect(folderOf(laptop, 's1')).toBe('Contested');
    expect(folderOf(laptop, 's9')).toBe('Contested_2');
  });

  // The suffix counts past what is already spent rather than reusing it, or the shoot moved aside would
  // land on top of the last one moved aside.
  it('counts past a suffix already taken', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'One');
    shoot(laptop, 's1', 'One');
    pull(laptop, server, 50);
    server.advance();
    new ShootsRepository(server.db).relocate('s1', 'One', 'Contested');
    for (const [id, folder] of [
      ['s9', 'Contested'],
      ['s8', 'Contested_2'],
      ['s7', 'Contested_3'],
    ] as const) {
      laptop.db
        .query('INSERT INTO shoots (id, library_id, name, folder_path) VALUES (?, ?, ?, ?)')
        .run(id, LIB, folder, folder);
    }

    pull(laptop, server, 50);

    expect(folderOf(laptop, 's1')).toBe('Contested');
    expect(folderOf(laptop, 's9')).toBe('Contested_4');
  });

  /**
   * **Settling a folder must not swallow an edit that had nothing to do with it.**
   *
   * Resolving a collision writes a stamp of this peer's own, and `mint()` takes the wall clock - so it
   * outranks every stamp minted earlier anywhere. On one stamp covering the whole shoot that would
   * make the label look freshly written too, and a real rename of the label still in flight from a
   * third peer would arrive looking stale: skipped, its coverage claimed, never sent again, and then
   * overwritten on every other peer from here. Silent and permanent, which is why `folder_path` has a
   * stamp of its own (§3.2).
   */
  it('does not swallow a label edited elsewhere while the folder was being settled', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    const tablet = makePeer('tablet');
    for (const peer of [server, laptop, tablet]) {
      shoot(peer, 's1', 'One');
      shoot(peer, 's2', 'Two');
    }
    for (const [into, from] of [
      [laptop, server],
      [server, laptop],
      [tablet, server],
    ] as const) {
      pull(into, from, 50);
    }

    // The two contending renames, the server's first.
    new ShootsRepository(server.db).relocate('s1', 'One', 'Contested');
    laptop.advance(1000);
    new ShootsRepository(laptop.db).relocate('s2', 'Two', 'Contested');
    // And a third peer renaming the *label* of the shoot that is about to lose, which is nobody's
    // business but its own. Still on the tablet: it has not been sent anywhere yet.
    tablet.advance(2000);
    new ShootsRepository(tablet.db).updateFields('s2', { name: 'Harbour' });

    // The laptop settles the folder, moving its `s2` aside under a stamp minted now - later than the
    // tablet's edit, which it has never seen.
    laptop.advance(3000);
    pull(laptop, server, 50);
    // Only now does the label arrive.
    pull(laptop, tablet, 50);

    expect(laptop.db.query('SELECT name FROM shoots WHERE id = ?').get('s2')).toEqual({ name: 'Harbour' });
  });

  // A name changed in the same breath as the folder is not what was contested, so refusing the rename
  // must not take it back as well.
  it('keeps what else the rejected change carried', () => {
    const { server, laptop } = bothRenamedOnto('Contested');
    new ShootsRepository(laptop.db).updateFields('s2', { name: 'Harbour' });

    pull(server, laptop, 50);

    // The server refuses the arriving rename, so its own `s2` stays where it is - and the name lands.
    expect(folderOf(server, 's2')).toBe('Two');
    expect(server.db.query('SELECT name FROM shoots WHERE id = ?').get('s2')).toEqual({ name: 'Harbour' });
  });
});
