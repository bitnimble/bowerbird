import type { Database } from 'bun:sqlite';

/**
 * Points a stack's representative flag at the member its tile should stand for
 * (§19.5.1).
 *
 * Cleared before it is set, and both inside whatever transaction the caller is
 * running: the partial unique index allows only one flagged member per stack, so
 * setting the new one first would collide with the old.
 *
 * **A member that is rejected or binned is chosen last.** The flag is a hint the
 * listing can override - its second arm promotes the newest *visible* member when
 * the flagged one is filtered out - but that arm is a correlated subquery per row,
 * and the flag exists to make the common case an equality test. Rejecting the
 * member a stack stands for is not rare: it is what every triage session does, and
 * without this the stack paid for the slow arm from then on.
 *
 * Deprioritised rather than excluded, so a stack whose members are all rejected
 * still has exactly one flagged member and the invariant holds everywhere.
 *
 * Its own module because both repositories need it and neither owns the other:
 * `stacks` on a membership change, `photos` on a verdict.
 */
export function refreshRepresentative(db: Database, stackId: string): void {
  db.query('UPDATE photos SET is_representative = 0 WHERE stack_id = ?').run(stackId);
  db.query(
    `UPDATE photos SET is_representative = 1 WHERE id = (
       SELECT id FROM photos WHERE stack_id = ?
       -- COALESCE, not a bare comparison: 'untriaged' is stored as NULL, and
       -- NULL = 'rejected' is NULL, which SQLite sorts before 0 - so an
       -- untriaged member would outrank a picked one on nothing but its NULL.
       ORDER BY (is_deleted = 1 OR COALESCE(triage, '') = 'rejected'),
                COALESCE(date_taken, date_added) DESC, id DESC
       LIMIT 1)`,
  ).run(stackId);
}
