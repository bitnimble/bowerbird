import type { Database } from '../../db/driver';
import { StackMembership } from '../stacks/stack_membership';
import { stamp } from './stamps';
import { tombstone } from './tombstones';

// Putting back what row-by-row merging cannot see (docs/replication.md §5.6).
//
// Every unit converges on its own, and a set of units that have each converged
// can still describe something impossible: a photograph pointing at a stack that
// was dissolved, or one whose membership rows say it is stacked while the column
// that answers listings says it is loose. So after every batch each peer runs the
// same pass, in the same order, over the state it has just reached.
//
// What is repaired here is **derived**, never replicated: these columns are a
// function of rows every peer already holds, so each computes the same answer
// from the same inputs and nothing about the repair needs to travel. That is also
// why none of it is stamped - a stamp would make one peer's arithmetic beat
// another's, on nothing but which clock ran later.

/**
 * Two peers stacking overlapping sets become one stack holding the union (§5.2).
 *
 * Membership rows merge one at a time, so a photograph both peers stacked ends up
 * in both stacks at once - which is not a state the app has any meaning for. The
 * rule the photographer asked for: the stacks that share a photograph become one,
 * the survivor is the one *created last*, and the members of the others move to it
 * rather than being orphaned, so `[a,b,c]` and `[a,b]` end as `[a,b,c]` everywhere.
 *
 * Every peer computes the same collapse from state they all hold, but what it
 * writes is stamped **here**, not derived from the surviving stack. A stamp
 * carrying another peer's origin cannot be sent to that peer - its coverage of
 * itself is total - so a peer that collapsed first could never tell the others,
 * and they would keep the stack it dissolved. That is the same trap the cascade
 * fell into (§5.1), and the answer is the same: an ordinary write, which travels
 * like one, and peers disagreeing about *when* the collapse happened settle it by
 * exchanging the tombstones like any other row.
 */
function collapseOverlappingStacks(db: Database, libraryId: string): void {
  const overlaps = db
    .query(
      `SELECT DISTINCT a.stack_id AS one, b.stack_id AS other
         FROM stack_members a JOIN stack_members b
           ON a.photo_id = b.photo_id AND a.stack_id < b.stack_id
        WHERE a.library_id = ?`,
    )
    .all(libraryId) as { one: string; other: string }[];
  if (overlaps.length === 0) return;

  // Every stack reachable from another through a shared photograph goes into one
  // group: three stacks can be chained by two photographs without either pair
  // holding all three.
  const groupOf = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (groupOf.get(root) != null && groupOf.get(root) !== root) root = groupOf.get(root)!;
    return root;
  };
  for (const { one, other } of overlaps) {
    groupOf.set(one, groupOf.get(one) ?? one);
    groupOf.set(other, groupOf.get(other) ?? other);
    const a = find(one);
    const b = find(other);
    if (a !== b) groupOf.set(b, a);
  }

  const grouped = new Map<string, string[]>();
  for (const id of groupOf.keys()) {
    const root = find(id);
    grouped.set(root, [...(grouped.get(root) ?? []), id]);
  }

  for (const members of grouped.values()) {
    const stacks = db
      .query(
        `SELECT id, created_stamp FROM stacks WHERE id IN (${members.map(() => '?').join(', ')})
          ORDER BY created_stamp DESC, id DESC`,
      )
      .all(...members) as { id: string; created_stamp: string | null }[];
    const winner = stacks[0];
    if (winner == null || stacks.length < 2) continue;
    const losing = stacks.slice(1);
    const moving = new Map(
      losing.map((stack) => [
        stack.id,
        db
          .query('SELECT photo_id, stamp FROM stack_members WHERE library_id = ? AND stack_id = ?')
          .all(libraryId, stack.id) as { photo_id: string; stamp: string | null }[],
      ]),
    );
    /*
     * An ordinary mint, and §5.4's "a pure function of its inputs" cannot be
     * followed here. Both alternatives are worse, and one of them is silent.
     *
     * A stamp carrying the *input's* origin is never delivered to the peer that
     * origin names: its coverage of itself is total by construction, so the row
     * is never selected to send. That is §5.1's trap and it is why this mints
     * locally at all.
     *
     * A stamp carrying this peer's origin but the inputs' *time* looks safe and
     * is not: a version vector's promise is "everything this origin wrote below
     * this stamp is applied here", which holds only because `mint` never goes
     * backwards. A derived stamp is minted in the past, so a peer that has
     * already sent later work under this origin advances the receiver's vector
     * past a row it never sent - and never sends it again. Measured, not
     * reasoned: 2 seeds in 1500 diverged exactly that way, a stack alive on one
     * peer and buried on another with the grave below the receiver's coverage.
     *
     * So the collapse sits at "now", and what keeps it from beating a deliberate
     * unstack is `removedFromWinner` asking outright rather than the ordering.
     */
    const at = stamp(db);
    for (const stack of losing) {
      for (const row of moving.get(stack.id) ?? []) {
        // Not into a place the photographer took it out of. A membership the
        // winner once had and lost was a deliberate unstacking, and the stamp
        // above only keeps this write *below* removals made after the rows it
        // moved - a grave already here has to be asked about outright (§5.4).
        if (!removedFromWinner(db, libraryId, winner.id, row)) {
          db.query(
            `INSERT INTO stack_members (library_id, stack_id, photo_id, stamp) VALUES (?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          ).run(libraryId, winner.id, row.photo_id, at);
        }
        db.query('DELETE FROM stack_members WHERE library_id = ? AND stack_id = ? AND photo_id = ?').run(
          libraryId,
          stack.id,
          row.photo_id,
        );
        tombstone(db, libraryId, 'stack_member', `${stack.id}/${row.photo_id}`, at);
      }
      db.query('DELETE FROM stacks WHERE id = ?').run(stack.id);
      tombstone(db, libraryId, 'stack', stack.id, at);
    }
  }
}

/** Whether the surviving stack has a grave for this photograph newer than the membership moving. */
function removedFromWinner(
  db: Database,
  libraryId: string,
  winnerId: string,
  member: { photo_id: string; stamp: string | null },
): boolean {
  const grave = db
    .query(
      `SELECT stamp FROM replication_log
        WHERE library_id = ? AND entity = 'stack_member' AND row_id = ? AND deleted = 1`,
    )
    .get(libraryId, `${winnerId}/${member.photo_id}`) as { stamp: string } | null;
  return grave != null && (member.stamp == null || grave.stamp >= member.stamp);
}

export function repair(db: Database, libraryId: string): void {
  collapseOverlappingStacks(db, libraryId);

  // Nothing stands for a stack while the columns are being rebuilt. Only one
  // member of a stack may carry the flag, and two loose photographs joining one
  // stack both arrive carrying it - so the flag has to be put down before the
  // column that makes them members is written, not after.
  db.query(
    `UPDATE photos SET is_representative = 0
       WHERE library_id = ? AND is_representative = 1
         AND id IN (SELECT photo_id FROM stack_members WHERE library_id = ?)`,
  ).run(libraryId, libraryId);

  // The membership rows are the truth and `stack_id` is their materialised view,
  // so the column follows them rather than the other way about. By here a
  // photograph is in one stack at most, the collapse above having seen to it; the
  // ordering is a tie-break for nothing and is kept only so the statement is total.
  db.query(
    `UPDATE photos SET stack_id = (
       SELECT m.stack_id FROM stack_members m WHERE m.photo_id = photos.id ORDER BY m.stack_id LIMIT 1)
     WHERE library_id = ?
       AND stack_id IS NOT (
         SELECT m.stack_id FROM stack_members m WHERE m.photo_id = photos.id ORDER BY m.stack_id LIMIT 1)`,
  ).run(libraryId);

  // 'unstacked' is a photographer saying no and outranks the rows: detection is
  // never allowed to claim such a photograph again, so a membership that arrived
  // from elsewhere must not quietly turn the verdict back into 'stacked'.
  db.query(
    `UPDATE photos SET stack_state = CASE WHEN stack_id IS NULL THEN 'none' ELSE 'stacked' END
       WHERE library_id = ? AND stack_state <> 'unstacked'
         AND stack_state <> CASE WHEN stack_id IS NULL THEN 'none' ELSE 'stacked' END`,
  ).run(libraryId);

  // Out of a stack a photograph stands for itself, and the listing shows it on
  // that flag alone: left at 0 it would vanish from every listing while the total
  // went on counting it.
  db.query('UPDATE photos SET is_representative = 1 WHERE library_id = ? AND stack_id IS NULL AND is_representative = 0').run(
    libraryId,
  );
  const stacks = db
    .query('SELECT DISTINCT stack_id AS id FROM photos WHERE library_id = ? AND stack_id IS NOT NULL')
    .all(libraryId) as { id: string }[];
  const members = new StackMembership(db);
  for (const stack of stacks) members.refreshRepresentative(stack.id);
}
