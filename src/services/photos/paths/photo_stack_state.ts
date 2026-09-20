import type { Database } from '../../../db/driver';
import type { StackMembership } from '../../stacks/stack_membership';

export function refreshStackOf(db: Database, stacks: StackMembership, photoId: string): void {
  const row = db.query('SELECT stack_id FROM photos WHERE id = ?').get(photoId) as { stack_id: string | null } | null;
  if (row?.stack_id != null) stacks.refreshRepresentative(row.stack_id);
}
