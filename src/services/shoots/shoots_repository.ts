import type { Database } from '../../db/driver';
import type { Ordering } from '../../schemas/common';
import type { Shoot } from '../../schemas/shoots';
import { firstPhotoOrderBy, hiddenIs, hiddenShootsSql } from '../photos/listing/photo_query';
import { stamp } from '../replication/stamps';
import { forgetCascade, shootsBelow, tombstone } from '../replication/tombstones';

interface ShootRow {
  id: string;
  parent_id: string | null;
  library_id: string;
  folder_path: string;
  name: string;
  description: string | null;
  ordering: string;
  banner_photo_id: string | null;
  photo_count: number;
  is_hidden: number;
  hidden_directly: number;
}

// Whether this shoot is out of sight: put away itself, or sitting under one that was (§12.4). The
// derived answer, so a client greys and filters on one field and never walks the tree to work it out.
const IS_HIDDEN = `(s.id IN (${hiddenShootsSql()}))`;

// The count and the thumbnail are what this shoot's own page lists, so they read hiding the way
// that page does (`ownShoot`): a photograph put away by hand is out, and a hidden shoot still
// reports what it holds rather than zero - a row that said nothing would be a row nobody can judge
// whether to bring back (§12.4). The exemption is `s.id` rather than a bound parameter because the
// outer query has the shoot right there, being the row these two subqueries hang off.
const VISIBLE_HERE = hiddenIs('p.', false, 's.id');

// A shoot with no banner of its own shows its first photo, in the shoot's own
// ordering. Derived rather than written at import: the first photo moves as
// photos are added, binned or re-dated, and a stored default would go stale and
// then have to be told apart from a deliberate choice. `shoot_banners` therefore
// only ever holds a choice, and a chosen banner still wins here.
// The shoot is joined in rather than read off the outer query: an ORDER BY inside a correlated
// subquery may not reach the enclosing alias, so `so` is the same row `s` is and is in scope here.
const FIRST_PHOTO = `SELECT p.id FROM photos p
  JOIN shoots so ON so.id = p.shoot_id
  WHERE p.shoot_id = s.id AND p.is_deleted = 0 AND ${VISIBLE_HERE}
  ORDER BY ${firstPhotoOrderBy('so.ordering')}
  LIMIT 1`;

// `hidden_directly` beside the derived answer, because only it is undoable: unhiding a shoot whose
// ancestor is the hidden one would write a flag that is already clear and change nothing on screen,
// so the row that offers it has to know which of the two it is looking at.
const SELECT = `SELECT s.id, s.parent_id, s.library_id, s.folder_path, s.name, s.description, s.ordering,
  ${IS_HIDDEN} AS is_hidden, s.is_hidden AS hidden_directly,
  COALESCE(b.photo_id, (${FIRST_PHOTO})) AS banner_photo_id,
  (SELECT COUNT(*) FROM photos p WHERE p.shoot_id = s.id AND p.is_deleted = 0 AND ${VISIBLE_HERE}) AS photo_count
  FROM shoots s LEFT JOIN shoot_banners b ON b.shoot_id = s.id`;

function mapRow(row: ShootRow): Shoot {
  return {
    id: row.id,
    parent_id: row.parent_id,
    library_id: row.library_id,
    folder_path: row.folder_path,
    name: row.name,
    description: row.description,
    banner_photo_id: row.banner_photo_id,
    ordering: row.ordering as Ordering,
    photo_count: row.photo_count,
    is_hidden: row.is_hidden === 1,
    hidden_directly: row.hidden_directly === 1,
  };
}

export interface NewShoot {
  id: string;
  parent_id: string | null;
  library_id: string;
  folder_path: string;
  name: string;
  description: string | null;
  ordering: Ordering;
  folder_dev: number | null;
  folder_ino: number | null;
  folder_birthtime: number | null;
}

// A shoot's folder as the filesystem knows it, which is what survives the folder
// being renamed (§9.4.1).
export interface ShootIdentity {
  id: string;
  folder_path: string;
  folder_dev: number | null;
  folder_ino: number | null;
  folder_birthtime: number | null;
}

/** Just the columns the sync needs, without the banner subquery `SELECT` carries. */
export interface ShootFolder {
  id: string;
  folder_path: string;
  photo_count: number;
}

export class ShootsRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insert(shoot: NewShoot): void {
    this.db
      .query(
        `INSERT INTO shoots (id, parent_id, library_id, folder_path, name, description, ordering,
                             folder_dev, folder_ino, folder_birthtime, stamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        shoot.id,
        shoot.parent_id,
        shoot.library_id,
        shoot.folder_path,
        shoot.name,
        shoot.description,
        shoot.ordering,
        shoot.folder_dev,
        shoot.folder_ino,
        shoot.folder_birthtime,
        stamp(this.db),
      );
  }

  getById(id: string): Shoot | null {
    const row = this.db.query(`${SELECT} WHERE s.id = ?`).get(id) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  getByFolderPath(libraryId: string, folderPath: string): Shoot | null {
    const row = this.db
      .query(`${SELECT} WHERE s.library_id = ? AND s.folder_path = ?`)
      .get(libraryId, folderPath) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  listIdentities(libraryId: string): ShootIdentity[] {
    return this.db
      .query('SELECT id, folder_path, folder_dev, folder_ino, folder_birthtime FROM shoots WHERE library_id = ?')
      .all(libraryId) as ShootIdentity[];
  }

  // What sync reads to decide membership and mirroring. Deliberately not the full
  // `SELECT`: that resolves a banner per shoot through a correlated subquery with
  // an unindexable ORDER BY, which costs more than everything else here put
  // together once a library has a shoot per folder, and no caller reads it.
  listFolders(libraryId: string): ShootFolder[] {
    return this.db
      .query(
        `SELECT s.id, s.folder_path,
           (SELECT COUNT(*) FROM photos p WHERE p.shoot_id = s.id AND p.is_deleted = 0) AS photo_count
           FROM shoots s WHERE s.library_id = ? ORDER BY s.folder_path`,
      )
      .all(libraryId) as ShootFolder[];
  }

  setIdentity(id: string, dev: number, ino: number, birthtimeMs: number): void {
    this.db
      .query('UPDATE shoots SET folder_dev = ?, folder_ino = ?, folder_birthtime = ? WHERE id = ?')
      .run(dev, ino, birthtimeMs, id);
  }

  /**
   * Every shoot of a library, hidden ones included.
   *
   * The default is everything because that is what the catalogue's own questions need: which shoot
   * encloses a folder, and which shoots a newly adopted folder's photographs fall under, are facts
   * about the tree rather than about what a reader is looking at, and a hidden shoot is still a
   * shoot. What a client is *served* is `ShootsService.list`, which excludes by default.
   */
  listByLibrary(libraryId: string, includeHidden = true): Shoot[] {
    // The derived answer, not `s.is_hidden`: a shoot under a hidden one is out of sight without
    // carrying a flag of its own, so filtering on the column would leave it on the page.
    const away = includeHidden ? '' : ` AND NOT ${IS_HIDDEN}`;
    const rows = this.db
      .query(`${SELECT} WHERE s.library_id = ?${away} ORDER BY s.folder_path`)
      .all(libraryId) as ShootRow[];
    return rows.map(mapRow);
  }

  /**
   * The folders of the shoots put away, for a caller that has to keep their contents out of a tree
   * it read off the disk (§12.4).
   *
   * Only the shoots put away themselves, which is all this caller needs: it drops every path at or
   * under one, so a descendant's folders go with its ancestor's rather than being named twice.
   *
   * Deliberately not `listByLibrary` filtered: that resolves a banner per shoot through a correlated
   * subquery with an unindexable ORDER BY, which is the whole cost of the listing, and this caller
   * wants nothing but the paths.
   */
  hiddenFolders(libraryId: string): string[] {
    const rows = this.db
      .query('SELECT folder_path FROM shoots WHERE library_id = ? AND is_hidden = 1')
      .all(libraryId) as { folder_path: string }[];
    return rows.map((row) => row.folder_path);
  }

  // No `folder_path`: where a shoot's folder is follows the disk, and `relocate` is the one writer -
  // which is also what keeps this write off the folder's own stamp (§3.2).
  updateFields(id: string, fields: { name?: string; description?: string | null; ordering?: Ordering }): void {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val == null) continue;
      sets.push(`${col} = ?`);
      params.push(val as string | null);
    }
    if (sets.length === 0) return;
    sets.push('stamp = ?');
    params.push(stamp(this.db));
    params.push(id);
    this.db.query(`UPDATE shoots SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Puts one shoot away, or brings it back (§12.4).
   *
   * **This row and no other.** The subtree goes out of sight with it, but by derivation
   * (`hiddenShootIds`) rather than by a flag written down it: a cascade cannot tell a shoot hidden by
   * its parent from one hidden on its own, so unhiding the parent would silently discard the child's
   * own hiding, with no record of it left to restore. Its own stamp, so a folder rename arriving from
   * a peer cannot carry a stale flag over it.
   */
  setHidden(id: string, hidden: boolean): void {
    this.db
      .query('UPDATE shoots SET is_hidden = ?, stamp_hidden = ? WHERE id = ?')
      .run(hidden ? 1 : 0, stamp(this.db), id);
  }

  // Points a shoot at the folder it was found at, taking its descendants with it:
  // a descendant's folder_path is this one's plus a suffix, so the whole subtree
  // shifts by the same prefix swap (§9.4.1). The name is untouched; only where the
  // shoot lives on disk changed.
  //
  // `parent_id` is re-derived afterwards because it carries `ON DELETE CASCADE`:
  // a shoot moved out from under its old parent that still points at it would be
  // destroyed, along with its label and its photos' membership, the next time
  // that unrelated parent was deleted.
  // `stamp_folder` and not `stamp`: where a folder sits is its own unit (§3.2), so a rename says
  // nothing about the shoot's label or its ordering and cannot arrive over an edit to either.
  relocate(shootId: string, oldFolderPath: string, newFolderPath: string): void {
    const moved = stamp(this.db);
    this.db
      .query(
        `UPDATE shoots SET folder_path = ? || substr(folder_path, ?), stamp_folder = ?
           WHERE library_id = (SELECT library_id FROM shoots WHERE id = ?)
             AND folder_path >= ? AND folder_path < ?`,
      )
      .run(newFolderPath, oldFolderPath.length + 1, moved, shootId, `${oldFolderPath}/`, `${oldFolderPath}0`);
    this.db
      .query('UPDATE shoots SET folder_path = ?, stamp_folder = ? WHERE id = ?')
      .run(newFolderPath, moved, shootId);
    // `parent_id` is the shoot's own unit, so it moves that stamp rather than the folder's.
    this.rederiveParents(shootId, moved);
  }

  // The enclosing shoot is a fact about where a folder sits, so it is read back
  // off the paths rather than tracked: the deepest other shoot in the library
  // whose folder is a prefix of this one's. Applied to the moved shoot and its
  // descendants, which are the only ones whose enclosing folder can have changed.
  // Range comparisons rather than LIKE: folder_path is the user's own folder
  // names, and `_` is a LIKE wildcard, so `2024_Japan` would match `2024xJapan`
  // and adopt an unrelated shoot - which `parent_id`'s ON DELETE CASCADE would
  // then destroy along with its subtree. '/' is 0x2F and '0' is 0x30, so
  // [P || '/', P || '0') is exactly the set of paths under P.
  private rederiveParents(shootId: string, moved: string): void {
    this.db
      .query(
        `UPDATE shoots AS s SET parent_id = (
           SELECT p.id FROM shoots p
            WHERE p.library_id = s.library_id AND p.id <> s.id
              AND s.folder_path >= p.folder_path || '/' AND s.folder_path < p.folder_path || '0'
            ORDER BY length(p.folder_path) DESC LIMIT 1),
           stamp = ?
         WHERE s.library_id = (SELECT library_id FROM shoots WHERE id = ?)
           AND (s.id = ?
                OR (s.folder_path >= (SELECT folder_path FROM shoots WHERE id = ?) || '/'
                    AND s.folder_path < (SELECT folder_path FROM shoots WHERE id = ?) || '0'))`,
      )
      .run(moved, shootId, shootId, shootId, shootId);
  }

  // Hands this shoot's children to its own parent, so deleting it takes only
  // itself. Without this, `parent_id`'s ON DELETE CASCADE takes the whole subtree
  // - and mirroring then rebuilds those folders as new shoots with default names,
  // losing every label, description, banner and ordering the user had given them.
  reparentChildren(shootId: string): void {
    this.db
      .query('UPDATE shoots SET parent_id = (SELECT parent_id FROM shoots WHERE id = ?), stamp = ? WHERE parent_id = ?')
      .run(shootId, stamp(this.db), shootId);
  }

  delete(id: string): boolean {
    const row = this.db.query('SELECT library_id FROM shoots WHERE id = ?').get(id) as { library_id: string } | null;
    if (row == null) return this.db.query('DELETE FROM shoots WHERE id = ?').run(id).changes > 0;
    // The subtree goes with it, because `parent_id` cascades; each of those is a
    // shoot other peers hold and would otherwise send back.
    const doomed = shootsBelow(this.db, [id]);
    const at = stamp(this.db);
    forgetCascade(this.db, row.library_id, 'shoot', doomed);
    const gone = this.db.query('DELETE FROM shoots WHERE id = ?').run(id).changes > 0;
    if (gone) {
      for (const shootId of doomed) tombstone(this.db, row.library_id, 'shoot', shootId, at);
    }
    return gone;
  }

  setBanner(shootId: string, photoId: string | null): void {
    if (photoId == null) {
      const row = this.db.query('SELECT library_id FROM shoots WHERE id = ?').get(shootId) as
        | { library_id: string }
        | null;
      const gone = this.db.query('DELETE FROM shoot_banners WHERE shoot_id = ?').run(shootId).changes > 0;
      if (gone && row != null) tombstone(this.db, row.library_id, 'shoot_banner', shootId, stamp(this.db));
      return;
    }
    this.db
      .query(
        `INSERT INTO shoot_banners (shoot_id, photo_id, stamp) VALUES (?, ?, ?)
           ON CONFLICT(shoot_id) DO UPDATE SET photo_id = excluded.photo_id, stamp = excluded.stamp`,
      )
      .run(shootId, photoId, stamp(this.db));
  }
}
