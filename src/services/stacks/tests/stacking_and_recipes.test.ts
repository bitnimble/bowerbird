import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { PhotoCompositesRepository } from '../../photos/composites/photo_composites_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { StackMembership } from '../stack_membership';
import { StacksRepository } from '../stacks_repository';
import type { Composition } from '../../../schemas/composition';

// A panorama is a photograph composed out of others; stacking is a grouping of photographs. The
// two are independent, which is what this file holds: what a reader does to a stack cannot reach
// a recipe, and what a recipe names does not have to be stacked at all.

const LIB = 'lib';

let db: Database;
let stacks: StacksRepository;
let photoComposites: PhotoCompositesRepository;
let photoListing: PhotoListingRepository;
let photoPaths: PhotoPathsRepository;

function recipe(photoIds: readonly string[]): Composition {
  return {
    version: 1,
    sources: photoIds.map((photoId) => ({
      photoId,
      size: [6000, 4000] as [number, number],
      rotation: [1, 0, 0, 0] as [number, number, number, number],
      focal: 5200,
      lens: { crop: 1, distortion: [0, -0.01], falloff: null, tca: null },
      gain: 1,
    })),
    projection: 'cylindrical' as const,
    canvas: [9000, 4200] as [number, number],
    centre: [4500, 2100] as [number, number],
    radiansPerPixel: 1 / 5200,
    crop: [0.01, 0.08, 0.99, 0.94] as [number, number, number, number],
    reference: 0,
    seamRmsPx: null,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Trip')").run(LIB);
  stacks = new StacksRepository(db);
  const stackMembership = new StackMembership(db);
  photoPaths = new PhotoPathsRepository(db, stackMembership);
  photoComposites = new PhotoCompositesRepository(db, stackMembership, photoPaths);
  photoListing = new PhotoListingRepository(db);
  for (const id of ['photo001', 'photo002']) {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES (?, ?, json_object('kind', 'file', 'path', ?), 6000, 4000, '2026-01-01T00:00:00.000Z')`,
    ).run(id, LIB, `${id}.arw`);
  }
  stacks.create('s1', LIB, 'manual', '2026-01-01');
  stacks.addPhotos('s1', ['photo001', 'photo002']);
});

describe('a panorama and the stacks its frames are in', () => {
  it('indexes the frames a recipe names, in the order it names them', () => {
    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo002', 'photo001']), reference: 'photo002' });

    expect(photoComposites.framesOf(id)).toEqual(['photo002', 'photo001']);
    expect(photoComposites.composedFrom('photo001')).toEqual([id]);
  });

  it('survives its frames being unstacked', () => {
    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo001', 'photo002']), reference: 'photo001' });

    stacks.dissolve('s1', true);

    expect(photoPaths.getBasicById(id)?.recipe.kind).toBe('panorama');
    expect(photoComposites.framesOf(id)).toEqual(['photo001', 'photo002']);
  });

  it('survives one of its frames leaving a stack', () => {
    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo001', 'photo002']), reference: 'photo001' });

    stacks.removePhotos('s1', ['photo002'], true);

    expect(photoPaths.getBasicById(id)?.recipe.kind).toBe('panorama');
    expect(photoComposites.framesOf(id)).toEqual(['photo001', 'photo002']);
  });

  // Its frames need not be stacked at all, which is the other half: a panorama can be made of a
  // burst, of loose photographs, or of a mixture, and nothing has to be grouped first.
  it('is made of photographs whatever stack they are or are not in', () => {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('loose', ?, '{"kind":"file","path":"loose.arw"}', 6000, 4000, '2026-01-01T00:00:00.000Z')`,
    ).run(LIB);

    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo001', 'loose']), reference: 'photo001' });

    expect(photoComposites.framesOf(id)).toEqual(['photo001', 'loose']);
  });

  // Merging the member a stack stands for hides that member, and the stack has to fall back to
  // one that is still in the listing. Getting this wrong loses the whole stack - every sibling
  // with it - rather than the one frame that was merged.
  it('leaves a stack visible when the member it stood for is merged away', () => {
    photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo002']), reference: 'photo002' });

    const listed = photoListing.listByLibrary(LIB, 'added_desc', 0, 10, { includeDeleted: false });

    expect(listed.photos.map((photo) => photo.id)).toContain('photo001');
  });

  // A composite is composed of rows rather than of files, so it has no filename of its own to be
  // searched by: the frames' names are the only ones it can answer to.
  it('is found by the filename of a frame it holds', () => {
    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo001', 'photo002']), reference: 'photo001' });

    const listed = photoListing.listByLibrary(LIB, 'added_desc', 0, 10, { includeDeleted: false, search: 'photo002' });

    expect(listed.photos.map((photo) => photo.id)).toEqual([id]);
  });

  // Deleting the composite takes the edges with it and leaves the frames alone: they were
  // photographs before it was made of them and they are photographs after.
  it('gives its frames back when it is deleted', () => {
    const id = photoComposites.insertComposite({ libraryId: LIB, kind: 'panorama', recipe: recipe(['photo001', 'photo002']), reference: 'photo001' });

    db.query('DELETE FROM photos WHERE id = ?').run(id);

    expect(photoComposites.composedFrom('photo001')).toEqual([]);
    expect(photoPaths.getBasicById('photo001')).not.toBeNull();
  });
});
