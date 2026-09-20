import type { Database } from '../../../db/driver';
import type { AssemblyRecipe } from '../../../schemas/assembly';
import type { Composition } from '../../../schemas/composition';
import { displaySize } from '../../../schemas/display_size';
import { withNewId } from '../../../db/constraints';
import { framingEdits } from '../../../schemas/recipes';
import { stamp } from '../../replication/stamps';
import type { StackMembership } from '../../stacks/stack_membership';
import { inChunks } from '../photo_batches';
import type { BasicPhoto, PhotoPathsRepository } from '../paths/photo_paths_repository';

export class PhotoCompositesRepository {
  constructor(private readonly db: Database, private readonly stacks: StackMembership, private readonly paths: PhotoPathsRepository) {}

  /**
     * Mints the photograph a recipe composes, and hands back its id.
     *
     * **Its size is what it looks like, not the canvas.** A composite is framed to the rectangle its
     * frames actually cover, so the canvas is an internal of the recipe and `width`/`height` are the
     * picture - which is what lets the grid lay a panorama out with the same two numbers as
     * everything else. Its date and its shoot are the reference frame's, so it files itself where
     * the pan was shot rather than at the top of the library.
     *
     * The rendition rows come from the insert trigger, exactly as a photograph's do, so what has
     * just been made owes a tile and a picture and the queue will build them if nothing else does.
     */
    insertComposite(made: {
      libraryId: string;
      recipe: Composition | AssemblyRecipe;
      kind: 'panorama' | 'assembly';
      reference: string;
    }): string {
      const shape = displaySize(made.recipe.canvas[0], made.recipe.canvas[1], framingEdits(made.recipe));
      const now = new Date().toISOString();
      return withNewId((id) => {
        const at = stamp(this.db);
        this.db
          .query(
            `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_taken, date_taken_offset,
                                 date_added, stamp_imported, stamp_placement)
               SELECT ?, ?, reference.shoot_id, ?, ?, ?, reference.date_taken, reference.date_taken_offset, ?, ?, ?
                 FROM photos reference WHERE reference.id = ?`,
          )
          .run(
            id,
            made.libraryId,
            JSON.stringify({ kind: made.kind, ...made.recipe }),
            shape.width,
            shape.height,
            now,
            at,
            at,
            made.reference,
          );
        // A frame is out of the listing from here, so a stack that stood for itself through one of
        // them has to pick again - otherwise its flag sits on a hidden row and the listing pays the
        // promotion subquery for that stack from now on.
        const stacks = this.db
          .query(
            `SELECT DISTINCT stack_id FROM photos
              WHERE id IN (${made.recipe.sources.map(() => '?').join(',')}) AND stack_id IS NOT NULL`,
          )
          .all(...made.recipe.sources.map((source) => source.photoId)) as { stack_id: string }[];
        for (const stack of stacks) this.stacks.refreshRepresentative(stack.stack_id);
        return id;
      });
    }
  /**
     * Rewrites an assembly's recipe in place - §2.7 of the take-best-parts design, the one case where
     * a recipe changes after insertion.
     *
     * The row's shape is recomputed as `insertComposite` computes it, a re-edit being free to move the
     * canvas, and `stamp_placement` moves because the recipe travels in that unit
     * (`replication/entities.ts`): left alone, a peer would keep the picks the reader just replaced.
     */
    updateRecipe(photoId: string, recipe: AssemblyRecipe): void {
      const shape = displaySize(recipe.canvas[0], recipe.canvas[1], framingEdits(recipe));
      this.db
        .query('UPDATE photos SET recipe = ?, width = ?, height = ?, stamp_placement = ? WHERE id = ?')
        .run(JSON.stringify({ kind: 'assembly', ...recipe }), shape.width, shape.height, stamp(this.db), photoId);
    }
  /** The frames a merge was offered, oldest first, which is how a pan is shot. */
    orderedForComposite(photoIds: readonly string[]): BasicPhoto[] {
      const found = this.paths.getBasicByIds([...photoIds]);
      const order = new Map(
        (
          this.db
            .query(
              `SELECT id FROM photos WHERE id IN (${found.map(() => '?').join(', ')})
                ORDER BY date_taken IS NULL, date_taken, id`,
            )
            .all(...found.map((photo) => photo.id)) as { id: string }[]
        ).map((row, at) => [row.id, at]),
      );
      return [...found].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
  /** The frames a composite is made of, in the order its recipe names them (§19.4). */
    framesOf(composedId: string): string[] {
      const rows = this.db
        .query('SELECT photo_id FROM photo_sources WHERE composed_id = ? ORDER BY at')
        .all(composedId) as { photo_id: string }[];
      return rows.map((row) => row.photo_id);
    }
  /**
     * Whether any of these photographs carries a develop document.
     *
     * What a merge asks about its frames, where the queue reads the same thing off the pending row:
     * a composite of a developed frame cannot be built from that frame's camera JPEG
     * (`renditions::sourceFor`).
     */
    anyEdited(photoIds: readonly string[]): boolean {
      for (const batch of inChunks(photoIds)) {
        const placeholders = batch.map(() => '?').join(', ');
        const row = this.db
          .query(`SELECT 1 FROM photo_edits WHERE photo_id IN (${placeholders}) LIMIT 1`)
          .get(...batch);
        if (row != null) return true;
      }
      return false;
    }
  /** Every composite this photograph is a frame of, which losing it would break. */
    composedFrom(photoId: string): string[] {
      const rows = this.db
        .query('SELECT composed_id FROM photo_sources WHERE photo_id = ? ORDER BY composed_id')
        .all(photoId) as { composed_id: string }[];
      return rows.map((row) => row.composed_id);
    }
}
