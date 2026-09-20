import type { Database } from '../../../db/driver';
import type { Triage } from '../../../schemas/photos';
import type { ViewerRendition } from '../../../schemas/settings';
import { stamp } from '../../replication/stamps';
import type { StackMembership } from '../../stacks/stack_membership';
import { inChunks } from '../photo_batches';
import { refreshStackOf } from '../paths/photo_stack_state';

export class PhotoStateRepository {
  constructor(private readonly db: Database, private readonly stacks: StackMembership) {}

  update(id: string, fields: { rating?: number; triage?: Triage; notes?: string | null; viewer_rendition?: ViewerRendition }): boolean {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (fields.rating != null) {
        sets.push('rating = ?');
        params.push(fields.rating);
      }
      if (fields.triage != null) {
        sets.push('triage = ?');
        // 'untriaged' is stored as NULL, so clearing a verdict is a real update.
        params.push(fields.triage === 'untriaged' ? null : fields.triage);
      }
      if (fields.notes != null) {
        sets.push('notes = ?');
        params.push(fields.notes);
      }
      if (fields.viewer_rendition != null) {
        sets.push('viewer_rendition = ?');
        params.push(fields.viewer_rendition);
      }
      if (sets.length === 0) return this.db.query('SELECT 1 FROM photos WHERE id = ?').get(id) != null;
      // Which rendition this photograph opens at is a choice about this device, so
      // it is the one field here that moves no stamp: a peer that likes the camera's
      // JPEG on a laptop has said nothing about the verdict.
      if (fields.rating != null || fields.triage != null || fields.notes != null) {
        sets.push('stamp_triage = ?');
        params.push(stamp(this.db));
      }
      params.push(id);
      // One transaction, so one commit. A verdict on a stacked photo is four
      // statements, and in autocommit that is four durable writes for one verdict -
      // measured at 3.65ms against 1.19ms, per keypress, which is more than the
      // correlated subquery it exists to save. Wrapped, it is 1.18ms.
      // It also closes the window in which a crash between the clear and the set
      // would leave a stack with no flagged member at all.
      return this.db.transaction(() => {
        const changed = this.db.query(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
        // A verdict can make the member a stack's tile stands for the wrong one to
        // stand for it. The listing would cope - its second arm promotes the newest
        // visible member - but that arm is a correlated subquery per row and the
        // flag exists to keep the common case an equality test. Rejecting the
        // representative is not an edge case: it is what a triage session does.
        if (changed && fields.triage != null) refreshStackOf(this.db, this.stacks, id);
        return changed;
      })();
    }
  /**
     * The two fields a cull sets, over a whole selection.
     *
     * One stamp for the batch, as a folder leaving the library takes one: rating a
     * burst is one thing the photographer did, and a merge that took half of it
     * would leave the burst half-rated. The stacks are collected before the write
     * and refreshed once each afterwards - per member, a stack of forty rejected
     * frames would recompute its representative forty times.
     */
    updateMany(ids: readonly string[], fields: { rating?: number; triage?: Triage }): number {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (fields.rating != null) {
        sets.push('rating = ?');
        params.push(fields.rating);
      }
      if (fields.triage != null) {
        sets.push('triage = ?');
        params.push(fields.triage === 'untriaged' ? null : fields.triage);
      }
      if (sets.length === 0 || ids.length === 0) return 0;
      sets.push('stamp_triage = ?');
      params.push(stamp(this.db));
  
      return this.db.transaction(() => {
        const stacks = new Set<string>();
        let changed = 0;
        for (const batch of inChunks(ids)) {
          const placeholders = batch.map(() => '?').join(', ');
          if (fields.triage != null) {
            const rows = this.db
              .query(`SELECT DISTINCT stack_id FROM photos WHERE id IN (${placeholders}) AND stack_id IS NOT NULL`)
              .all(...batch) as { stack_id: string }[];
            for (const row of rows) stacks.add(row.stack_id);
          }
          changed += this.db.query(`UPDATE photos SET ${sets.join(', ')} WHERE id IN (${placeholders})`).run(...params, ...batch)
            .changes;
        }
        for (const stackId of stacks) this.stacks.refreshRepresentative(stackId);
        return changed;
      })();
    }
  /**
     * Puts a selection away, or brings it back (§12.4).
     *
     * Its own statement rather than a field of `updateMany`: hiding carries its own stamp, so a
     * batch that set a rating too would have to move two of them - and one stamp for the batch is
     * right here for the reason it is right there, a photographer putting a shoot's worth of frames
     * away having done one thing.
     *
     * The stacks are re-ranked afterwards, as a binning and a verdict both do: hiding is a third way the
     * member a stack's tile stands for stops being one any listing shows, and left flagged it sends every
     * later query for that stack through the promotion subquery the flag exists to avoid. Collected first
     * and refreshed once each, so a stack of forty hidden frames is one recompute rather than forty.
     */
    setHidden(ids: readonly string[], hidden: boolean): number {
      if (ids.length === 0) return 0;
      const at = stamp(this.db);
      return this.db.transaction(() => {
        const stacks = new Set<string>();
        let changed = 0;
        for (const batch of inChunks(ids)) {
          const placeholders = batch.map(() => '?').join(', ');
          const rows = this.db
            .query(`SELECT DISTINCT stack_id FROM photos WHERE id IN (${placeholders}) AND stack_id IS NOT NULL`)
            .all(...batch) as { stack_id: string }[];
          for (const row of rows) stacks.add(row.stack_id);
          changed += this.db
            .query(`UPDATE photos SET is_hidden = ?, stamp_hidden = ? WHERE id IN (${placeholders})`)
            .run(hidden ? 1 : 0, at, ...batch).changes;
        }
        for (const stackId of stacks) this.stacks.refreshRepresentative(stackId);
        return changed;
      })();
    }
  /**
     * Re-ranks every stack holding a photograph in this shoot or one beneath it (§12.4).
     *
     * Hiding a shoot writes nothing onto its photographs, so their `is_representative` survives it -
     * pointing, for any stack whose flagged member is in there, at a row no listing will show again
     * until somebody unhides it. Same cost as the flag left stale by a hidden photograph, one shoot's
     * worth at a time, so it is paid here rather than by every later listing.
     */
    refreshStacksUnderShoot(shootId: string): void {
      const rows = this.db
        .query(
          `SELECT DISTINCT p.stack_id FROM photos p JOIN shoots s ON s.id = p.shoot_id
            WHERE p.stack_id IS NOT NULL
              AND (s.id = ?
                   OR (s.library_id = (SELECT library_id FROM shoots WHERE id = ?)
                       AND s.folder_path >= (SELECT folder_path FROM shoots WHERE id = ?) || '/'
                       AND s.folder_path < (SELECT folder_path FROM shoots WHERE id = ?) || '0'))`,
        )
        .all(shootId, shootId, shootId, shootId) as { stack_id: string }[];
      for (const row of rows) this.stacks.refreshRepresentative(row.stack_id);
    }
}
