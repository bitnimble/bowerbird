import type { Database } from '../../db/driver';
import type { Label } from '../../schemas/labels';
import { stamp } from '../replication/stamps';
import { forgetCascade, tombstone } from '../replication/tombstones';

const SELECT = `SELECT l.id, l.library_id, l.name, l.colour, l.position,
  (SELECT COUNT(*) FROM photo_labels pl JOIN photos p ON p.id = pl.photo_id
    WHERE pl.label_id = l.id AND p.is_deleted = 0) AS photo_count
  FROM labels l`;

// Position alone can tie: two peers each adding a label while apart both append at the same place.
const ORDER = 'ORDER BY l.library_id, l.position, l.id';

export interface LabelEdit {
  id: string;
  name: string;
  colour: string;
}

export class LabelsRepository {
  constructor(private readonly db: Database) {}

  list(): Label[] {
    return this.db.query(`${SELECT} ${ORDER}`).all() as Label[];
  }

  listByLibrary(libraryId: string): Label[] {
    return this.db.query(`${SELECT} WHERE l.library_id = ? ${ORDER}`).all(libraryId) as Label[];
  }

  getById(id: string): Label | null {
    return (this.db.query(`${SELECT} WHERE l.id = ?`).get(id) as Label | null) ?? null;
  }

  create(libraryId: string, label: LabelEdit): void {
    const at = stamp(this.db);
    this.db
      .query(
        `INSERT INTO labels (id, library_id, name, colour, position, stamp, stamp_position)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM labels WHERE library_id = ?), ?, ?)`,
      )
      .run(label.id, libraryId, label.name, label.colour, libraryId, at, at);
  }

  /**
   * Writes the edit dialog's list: `ordered` in that order, then any label it did not mention in the
   * order they already had, less `removed`.
   *
   * One stamp for the save, moved only onto the units a label actually changed, so a label the
   * dialog merely showed does not clobber a rename another peer made to it meanwhile.
   */
  save(libraryId: string, ordered: readonly LabelEdit[], removed: readonly string[]): void {
    this.db.transaction(() => {
      this.delete(libraryId, removed);
      const held = new Map(this.listByLibrary(libraryId).map((label) => [label.id, label]));
      const listed = new Set(ordered.map((label) => label.id));
      const unlisted = [...held.values()].filter((label) => !listed.has(label.id));
      const at = stamp(this.db);
      const insert = this.db.query(
        `INSERT INTO labels (id, library_id, name, colour, position, stamp, stamp_position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const rename = this.db.query(
        'UPDATE labels SET name = ?, colour = ?, stamp = ? WHERE id = ?',
      );
      const move = this.db.query('UPDATE labels SET position = ?, stamp_position = ? WHERE id = ?');
      [...ordered, ...unlisted].forEach((label, position) => {
        const before = held.get(label.id);
        if (before == null) {
          insert.run(label.id, libraryId, label.name, label.colour, position, at, at);
          return;
        }
        if (before.name !== label.name || before.colour !== label.colour)
          rename.run(label.name, label.colour, at, label.id);
        if (before.position !== position) move.run(position, at, label.id);
      });
    })();
  }

  /** @returns how many of the photos took the label: only those in its library can. */
  addPhotos(labelId: string, libraryId: string, photoIds: readonly string[]): number {
    const at = stamp(this.db);
    // Nothing for a photo that already has it, so a repeat is not a newer write that would outvote a
    // removal made on another peer meanwhile.
    const add = this.db.query(
      `INSERT INTO photo_labels (library_id, label_id, photo_id, stamp)
         SELECT library_id, ?, id, ? FROM photos WHERE id = ? AND library_id = ?
       ON CONFLICT DO NOTHING`,
    );
    let added = 0;
    this.db.transaction(() => {
      for (const photoId of photoIds) added += add.run(labelId, at, photoId, libraryId).changes;
    })();
    return added;
  }

  removePhotos(labelId: string, libraryId: string, photoIds: readonly string[]): number {
    const at = stamp(this.db);
    const remove = this.db.query(
      'DELETE FROM photo_labels WHERE library_id = ? AND label_id = ? AND photo_id = ?',
    );
    let removed = 0;
    this.db.transaction(() => {
      for (const photoId of photoIds) {
        if (remove.run(libraryId, labelId, photoId).changes === 0) continue;
        tombstone(this.db, libraryId, 'photo_label', `${labelId}/${photoId}`, at);
        removed++;
      }
    })();
    return removed;
  }

  private delete(libraryId: string, labelIds: readonly string[]): void {
    const doomed = labelIds.filter(
      (id) =>
        this.db.query('SELECT 1 FROM labels WHERE id = ? AND library_id = ?').get(id, libraryId) !=
        null,
    );
    if (doomed.length === 0) return;
    forgetCascade(this.db, libraryId, 'label', doomed);
    const at = stamp(this.db);
    for (const id of doomed) {
      this.db.query('DELETE FROM labels WHERE id = ?').run(id);
      tombstone(this.db, libraryId, 'label', id, at);
    }
  }
}
