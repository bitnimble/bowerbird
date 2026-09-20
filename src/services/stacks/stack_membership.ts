import type { Database } from '../../db/driver';
import { stamp } from '../replication/stamps';
import { tombstone } from '../replication/tombstones';

/**
 * Which photographs are in which stack, and the three columns on `photos` that
 * follow from it.
 *
 * **The one writer of both.** `stack_members` is what replicates and
 * `photos.stack_id` is its materialised view - the column the listing's stack
 * filter reads on every row an index walk visits, where a join would be a b-tree
 * probe per row (docs/replication.md §3.3). Two places holding one fact drift the
 * moment a second caller writes only one of them, so nothing outside this class
 * touches either, and every path that changes membership goes through here.
 *
 * `stack_state` and `is_representative` come along because they are answers to
 * the same question: the first is whether a human has had an opinion about this
 * photograph's stacking, the second is which member the stack's tile stands for.
 */
export class StackMembership {
  constructor(private readonly db: Database) {}

  /**
   * Puts photographs into a stack, taking them out of any stack they were in.
   *
   * One stamp for the whole call: joining a stack is one gesture, and stamping
   * each row separately would let a merge take half of it.
   */
  add(stackId: string, photoIds: readonly string[]): void {
    const at = stamp(this.db);
    const join = this.db.query(
      `INSERT INTO stack_members (library_id, stack_id, photo_id, stamp)
         SELECT library_id, ?, id, ? FROM photos WHERE id = ?
       ON CONFLICT (library_id, stack_id, photo_id) DO UPDATE SET stamp = excluded.stamp`,
    );
    // Clearing the flag is not tidiness: only one member of a stack may carry it,
    // and each of these was standing for itself a moment ago.
    const point = this.db.query(
      `UPDATE photos SET stack_id = ?, stack_state = 'stacked', is_representative = 0, stamp_stack = ?
         WHERE id = ?`,
    );
    const emptied = new Set<string>();
    for (const photoId of photoIds) {
      for (const left of this.leave(photoId, stackId, at)) emptied.add(left);
      join.run(stackId, at, photoId);
      point.run(stackId, at, photoId);
    }
    // After the column has moved, never before. Ranked while it still named the
    // old stack, the photograph on its way out can be the one chosen to stand for
    // it, and then has the flag cleared as it leaves - which leaves that stack
    // with no member standing for it and absent from every listing.
    for (const left of emptied) this.refreshRepresentative(left);
    this.refreshRepresentative(stackId);
  }

  /**
   * Takes photographs out of one stack.
   *
   * `released` is the difference between detection tidying up after itself and a
   * human saying no: a released photograph is marked 'unstacked' and is never
   * claimed again, where one merely re-sorted by a detection pass goes back to
   * 'none' and stays available (§19.4.4).
   *
   * @returns how many actually left, which may be none of them.
   */
  remove(stackId: string, photoIds: readonly string[], released: boolean): number {
    const at = stamp(this.db);
    let removed = 0;
    for (const photoId of photoIds) removed += this.release(photoId, stackId, released, at);
    if (removed > 0) this.refreshRepresentative(stackId);
    return removed;
  }

  /** Empties a stack, for a caller that is about to delete it. */
  clear(stackId: string, released: boolean, at: string): void {
    const members = this.db.query('SELECT photo_id FROM stack_members WHERE stack_id = ?').all(stackId) as {
      photo_id: string;
    }[];
    for (const member of members) this.release(member.photo_id, stackId, released, at);
  }

  /**
   * Points a stack's representative flag at the member its tile should stand for
   * (§19.5.1).
   *
   * Cleared before it is set, and both inside whatever transaction the caller is
   * running: the partial unique index allows only one flagged member per stack, so
   * setting the new one first would collide with the old.
   *
   * **A member that is rejected, binned or merged into a live panorama is chosen last.** The
   * flag is a hint the listing can override - its second arm promotes the newest *visible*
   * member when the flagged one is filtered out - but that arm is a correlated subquery per
   * row, and the flag exists to make the common case an equality test. Rejecting the
   * member a stack stands for is not rare: it is what every triage session does, and
   * without this the stack paid for the slow arm from then on.
   *
   * Deprioritised rather than excluded, so a stack whose members are all rejected
   * still has exactly one flagged member and the invariant holds everywhere.
   *
   * Derived from membership rather than replicated: every peer computes the same
   * answer from the same rows, so sending it would be sending arithmetic.
   */
  refreshRepresentative(stackId: string): void {
    this.db.query('UPDATE photos SET is_representative = 0 WHERE stack_id = ?').run(stackId);
    this.db
      .query(
        `UPDATE photos SET is_representative = 1 WHERE id = (
           SELECT id FROM photos WHERE stack_id = ?
           -- COALESCE, not a bare comparison: 'untriaged' is stored as NULL, and
           -- NULL = 'rejected' is NULL, which SQLite sorts before 0 - so an
           -- untriaged member would outrank a picked one on nothing but its NULL.
           -- is_hidden deprioritises for the same reason the other three do: a flagged member no
           -- listing shows leaves every query for this stack falling through to the promotion arm,
           -- which is the correlated subquery the flag exists to avoid (§12.4).
           ORDER BY (is_deleted = 1 OR is_hidden = 1 OR COALESCE(triage, '') = 'rejected'
                     OR EXISTS (SELECT 1 FROM photo_sources s
                                  JOIN photos composite ON composite.id = s.composed_id
                                 WHERE s.photo_id = photos.id AND composite.is_deleted = 0)),
                    COALESCE(date_taken, date_added) DESC, id DESC
           LIMIT 1)`,
      )
      .run(stackId);
  }

  /**
   * Drops a photograph's other memberships, so the view column has one row to
   * reflect.
   *
   * @returns the stacks it just left, for the caller to re-rank once the column
   * has caught up.
   */
  private leave(photoId: string, joining: string, at: string): string[] {
    const left = this.db
      .query('SELECT library_id, stack_id FROM stack_members WHERE photo_id = ? AND stack_id <> ?')
      .all(photoId, joining) as { library_id: string; stack_id: string }[];
    if (left.length === 0) return [];
    this.db.query('DELETE FROM stack_members WHERE photo_id = ? AND stack_id <> ?').run(photoId, joining);
    for (const row of left) {
      tombstone(this.db, row.library_id, 'stack_member', `${row.stack_id}/${photoId}`, at);
    }
    return left.map((row) => row.stack_id);
  }

  /**
   * One photograph out of one stack.
   *
   * Constrained to the stack being left, so a request naming a photograph that
   * belongs to some other stack changes nothing rather than quietly pulling it
   * out of that one.
   */
  private release(photoId: string, stackId: string, released: boolean, at: string): number {
    const row = this.db
      .query('SELECT library_id FROM stack_members WHERE stack_id = ? AND photo_id = ?')
      .get(stackId, photoId) as { library_id: string } | null;
    const gone = this.db
      .query('DELETE FROM stack_members WHERE stack_id = ? AND photo_id = ?')
      .run(stackId, photoId).changes;
    if (gone === 0) return 0;
    if (row != null) tombstone(this.db, row.library_id, 'stack_member', `${stackId}/${photoId}`, at);
    // `is_representative = 1`: out of a stack a photograph stands for itself, and
    // the listing shows a row with no stack on that flag alone. Left at 0 - which
    // is what every member but one carries - the photograph vanishes from every
    // listing while `total` goes on counting it, for good, with nothing on screen
    // to say where it went.
    this.db
      .query(
        `UPDATE photos SET stack_id = NULL, stack_state = ?, is_representative = 1, stamp_stack = ?
           WHERE id = ? AND stack_id = ?`,
      )
      .run(released ? 'unstacked' : 'none', at, photoId, stackId);
    return 1;
  }
}
