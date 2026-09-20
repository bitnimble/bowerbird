// A recipe kind this build has never heard of still composes: it names sources, not bytes of its
// own, so it must not land as `is_missing` with nothing left to ever clear the flag (docs/replication.md §5.1).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssemblyRecipeSchema } from '../../../schemas/assembly';
import { RecipeSchema } from '../../../schemas/recipes';
import { PhotoCompositesRepository } from '../../photos/composites/photo_composites_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { applyChanges, rebuildCandidates } from '../apply';
import { LIB, makePeer, type Peer } from './peers';
import { stamp } from '../stamps';

function applyRecipeCellAs(peer: Peer, rowId: string, recipe: string): string[] {
  const arriving = stamp(peer.db);
  const applied = applyChanges(peer.db, LIB, [
    {
      kind: 'photo' as const,
      rowId,
      deleted: false as const,
      sidecar: null,
      row: {
        id: rowId,
        library_id: LIB,
        recipe,
        width: 6000,
        height: 4000,
        date_added: '2026-01-01T00:00:00.000Z',
      },
      stamps: { 'photo.placement': arriving },
    },
  ]);
  return rebuildCandidates(applied.taken);
}

describe('a composite kind this build has never heard of', () => {
  it('is not marked missing', () => {
    const peer = makePeer('a');
    applyRecipeCellAs(peer, 'p1', JSON.stringify({ kind: 'mosaic', sources: [{ photoId: 'f1' }] }));
    const row = peer.db.query('SELECT is_missing FROM photos WHERE id = ?').get('p1') as { is_missing: number };
    expect(row.is_missing).toBe(0);
  });
});

const SAMPLE = AssemblyRecipeSchema.parse(
  JSON.parse(
    readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json'), 'utf8'),
  ),
);

/** What the repository actually writes, rather than a cell built by hand beside it. */
function assembled(peer: Peer): { id: string; recipe: string } {
  for (const source of SAMPLE.sources) {
    peer.db
      .query(
        `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
           VALUES (?, ?, json_object('kind', 'file', 'path', ?), 6000, 4000, '2026-01-01T00:00:00.000Z')`,
      )
      .run(source.photoId, LIB, `${source.photoId}.arw`);
  }
  const stacks = new StackMembership(peer.db);
  const id = new PhotoCompositesRepository(peer.db, stacks, new PhotoPathsRepository(peer.db, stacks)).insertComposite({
    libraryId: LIB,
    kind: 'assembly',
    recipe: SAMPLE,
    reference: SAMPLE.sources[SAMPLE.base]!.photoId,
  });
  const row = peer.db.query('SELECT recipe FROM photos WHERE id = ?').get(id) as { recipe: string };
  return { id, recipe: row.recipe };
}

/**
 * The service layer's own output, round-tripped.
 *
 * A hand-built cell can only fail one way - the trigger or the guard - where this also fails when
 * the repository forgets a field, writes the kind it used to write, or stops stamping the unit the
 * recipe travels in.
 */
describe('an assembly this build made', () => {
  it('reaches a peer whole, tiles and all, with its frames indexed', () => {
    const made = assembled(makePeer('made'));
    const peer = makePeer('told');

    applyRecipeCellAs(peer, made.id, made.recipe);

    const row = peer.db.query('SELECT recipe, is_missing FROM photos WHERE id = ?').get(made.id) as {
      recipe: string;
      is_missing: number;
    };
    const arrived = RecipeSchema.parse(JSON.parse(row.recipe));
    expect(arrived.kind).toBe('assembly');
    expect(arrived.kind === 'assembly' && arrived.tiles).toEqual(SAMPLE.tiles);
    expect(arrived.kind === 'assembly' && arrived.pick).toEqual(SAMPLE.pick);
    // A composite has no original to arrive, so nothing would ever clear the flag.
    expect(row.is_missing).toBe(0);
    const frames = peer.db
      .query('SELECT photo_id FROM photo_sources WHERE composed_id = ? ORDER BY at')
      .all(made.id) as { photo_id: string }[];
    expect(frames.map((frame) => frame.photo_id)).toEqual(SAMPLE.sources.map((source) => source.photoId));
  });

  // §2.7's reopen is the one thing that changes a recipe after insertion, so it is the one thing
  // that can leave a peer holding picks the reader has replaced.
  it('carries a reopen, the recipe travelling in the unit that was stamped for it', () => {
    const maker = makePeer('made');
    const made = assembled(maker);
    maker.advance();
    const before = (maker.db.query('SELECT stamp_placement AS at FROM photos WHERE id = ?').get(made.id) as {
      at: string;
    }).at;

    const stacks = new StackMembership(maker.db);
    new PhotoCompositesRepository(maker.db, stacks, new PhotoPathsRepository(maker.db, stacks)).updateRecipe(made.id, {
      ...SAMPLE,
      pick: [0, 0],
    });

    const after = maker.db.query('SELECT recipe, stamp_placement AS at FROM photos WHERE id = ?').get(made.id) as {
      recipe: string;
      at: string;
    };
    expect(after.at > before).toBe(true);

    const peer = makePeer('told');
    applyRecipeCellAs(peer, made.id, after.recipe);
    const arrived = RecipeSchema.parse(
      JSON.parse((peer.db.query('SELECT recipe FROM photos WHERE id = ?').get(made.id) as { recipe: string }).recipe),
    );
    expect(arrived.kind === 'assembly' && arrived.pick).toEqual([0, 0]);
  });

  // No document moves on a reopen, so the recipe is the only thing that can say the copies are behind.
  it('leaves a peer that built the old picks owing its copies again', () => {
    const made = assembled(makePeer('made'));
    const peer = makePeer('told');
    peer.db.query("UPDATE libraries SET rendition_hdr = 0 WHERE id = ?").run(LIB);
    const photos = new PhotoProcessingRepository(peer.db, new RenditionsRepository(peer.db));
    applyRecipeCellAs(peer, made.id, made.recipe);
    for (const variant of ['grid', 'full'] as const) {
      photos.markCopyBuilt(made.id, '2026-06-01T00:00:00.000Z', photos.builtFromOf(made.id), variant);
    }
    expect(photos.queueEditedSince([made.id])).toBe(0);

    const reopened = JSON.stringify({ ...JSON.parse(made.recipe), pick: [0, 0] });
    const candidates = applyRecipeCellAs(peer, made.id, reopened);

    expect(candidates).toEqual([made.id]);
    expect(photos.queueEditedSince(candidates)).toBe(1);
  });
});
