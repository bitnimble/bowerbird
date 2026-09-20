import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { AssemblyRecipeSchema } from '../../../../schemas/assembly';
import { renditionCurrent } from '../../../blobs/rendition_fetch_service';
import { StackMembership } from '../../../stacks/stack_membership';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { PhotoListingRepository } from '../../listing/photo_listing_repository';
import { PhotoNavigationRepository } from '../../listing/photo_navigation_repository';
import { PhotoPathsRepository } from '../../paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../renditions/photo_processing_repository';
import { PhotoCompositesRepository } from '../photo_composites_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

const ASSEMBLY_SAMPLE = join(import.meta.dir, '..', '..', '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json');

let db: Database;
let repo: PhotoCompositesRepository;
let listing: PhotoListingRepository;
let navigation: PhotoNavigationRepository;
let paths: PhotoPathsRepository;
let processing: PhotoProcessingRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

function assembleTwoFrames(): string {
  insert('frame001', 'Trip/one.arw');
  insert('frame002', 'Trip/two.arw');
  const recipe = AssemblyRecipeSchema.parse(JSON.parse(readFileSync(ASSEMBLY_SAMPLE, 'utf8')));
  return repo.insertComposite({
    libraryId: LIB,
    kind: 'assembly',
    reference: 'frame001',
    recipe: {
      ...recipe,
      sources: ['frame001', 'frame002'].map((photoId, at) => ({ ...recipe.sources[at]!, photoId })),
    },
  });
}

function mergeTwoFrames(): string {
  insert('frame001', 'Trip/one.arw');
  insert('frame002', 'Trip/two.arw');
  return repo.insertComposite({
    libraryId: LIB,
    kind: 'panorama',
    reference: 'frame001',
    recipe: {
      version: 1,
      sources: ['frame001', 'frame002'].map((photoId) => ({
        photoId,
        size: [6000, 4000] as [number, number],
        rotation: [1, 0, 0, 0] as [number, number, number, number],
        focal: 5200,
        lens: { crop: 1 },
        gain: 1,
      })),
      projection: 'cylindrical' as const,
      canvas: [9000, 4200] as [number, number],
      centre: [4500, 2100] as [number, number],
      radiansPerPixel: 0.0002,
      crop: [0, 0, 1, 1] as [number, number, number, number],
      reference: 0,
    },
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const stacks = new StackMembership(db);
  paths = new PhotoPathsRepository(db, stacks);
  repo = new PhotoCompositesRepository(db, stacks, paths);
  listing = new PhotoListingRepository(db);
  navigation = new PhotoNavigationRepository(db);
  processing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

// An edited photograph is promised a render whatever its library serves, because the camera's
// own JPEG cannot stand in for the picture once there are develop settings on it
// (`resolveShownRendition`). The service reads that off this column, and nothing else does -
// so if the subquery ever came back false, an edited photo in an embedded library would open
// on the unedited JPEG, and the JPEG never 404s, so nothing would heal it.
/**
 * What binning a panorama does to the photographs it was made of.
 *
 * Merging says "these frames are one picture" and the grid stops showing them separately. Binning
 * the panorama takes that back: the frames are photographs again, to be binned themselves, kept,
 * or merged into a new one. The danger this pins is the opposite - frames left hidden behind a row
 * that is itself in the Bin, which is N photographs gone from the library with nothing on screen
 * to say where they went.
 */
describe('a panorama and the frames it stands for', () => {
  const LIVE_IDS = (): string[] =>
    listing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false }).photos.map((p) => p.id).sort();

  it('stands for its frames while it is there', () => {
    const panorama = mergeTwoFrames();

    expect(LIVE_IDS()).toContain(panorama);
    expect(LIVE_IDS()).not.toContain('frame001');
    expect(LIVE_IDS()).not.toContain('frame002');
  });

  // The badge a listing draws, and what opens the band of frames behind it. Read out of the
  // recipe's own kind rather than off the one kind that existed first, or an assembly is a row
  // the grid shows as an ordinary photograph with no way to reach what it was made of.
  it('a listing reads an assembly as composed of other photographs, and says which kind', () => {
    const assembly = assembleTwoFrames();

    const row = listing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false }).photos.find(
      (photo) => photo.id === assembly,
    );
    expect(row?.composite_kind).toBe('assembly');
    expect(row?.frame_count).toBe(2);
  });

  it('a listing reads a panorama as one, and a photograph as no composite at all', () => {
    const panorama = mergeTwoFrames();
    const rows = listing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false }).photos;

    expect(rows.find((photo) => photo.id === panorama)?.composite_kind).toBe('panorama');
    expect(rows.filter((photo) => photo.id !== panorama).every((photo) => photo.composite_kind == null)).toBe(true);
  });

  /**
   * **Only a composite may claim a frame.** A recipe arrives from a peer byte-verbatim - the wire
   * guard refines and never transforms - so a `file` recipe can carry a `sources` array bolted onto
   * it naming any photograph in the library. Indexed, those are edges, and a photograph any live
   * row claims as a frame is hidden: one crafted row per photograph empties somebody's grid.
   */
  it('indexes nothing for a recipe that names sources without being a composite', () => {
    insert('frame001', 'Trip/one.arw');
    insert('victim01', 'Trip/two.arw');
    db.query('UPDATE photos SET recipe = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'file', path: 'Trip/one.arw', sources: [{ photoId: 'victim01' }] }),
      'frame001',
    );

    expect(repo.framesOf('frame001')).toEqual([]);
    expect(LIVE_IDS()).toContain('victim01');
  });

  /**
   * **In a shoot as much as in the library.** A pan is shot inside a shoot far more often than
   * loose, so the shoot is where a reader meets their panorama - and a rule that only held for the
   * library would show the composite beside every frame it was made of, which is the merge looking
   * as though it did nothing.
   */
  it('stands for them in a shoot as well', () => {
    const panorama = mergeTwoFrames();
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('frame001', 'frame002', ?)").run(panorama);

    const inShoot = listing.listByShoot('s1', 'added_asc', 0, 10, { includeDeleted: false }).photos.map((p) => p.id);

    expect(inShoot).toEqual([panorama]);
  });

  /**
   * **"Expand stacks" is not "dismantle my panoramas".**
   *
   * Uncollapsing shows each member of a burst as a row of its own, which is a statement about
   * stacks. A panorama's frames are not stack members - the frames may be in no stack at all - so
   * a composite goes on standing for them either way. This is the setting that made a shoot show
   * every source beside the panorama while the library, with it off, looked right.
   */
  it('stands for them with stacks expanded, which is a rule about stacks and not about it', () => {
    const panorama = mergeTwoFrames();
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('frame001', 'frame002', ?)").run(panorama);

    const expanded = { includeDeleted: false, expandStacks: true };
    expect(listing.listByShoot('s1', 'added_asc', 0, 10, expanded).photos.map((p) => p.id)).toEqual([panorama]);
    expect(listing.listByLibrary(LIB, 'added_asc', 0, 10, expanded).photos.map((p) => p.id).sort()).toEqual([
      'live',
      panorama,
    ].sort());
  });

  /**
   * **The count and the rows have to agree.** The grid reserves a slot per counted entry and
   * fills it from the rows it is handed, so a count that still includes the frames leaves their
   * slots on screen for ever as empty tiles - the composite drawn once, and twenty-six holes
   * beside it that never load.
   *
   * `photo_total` is the readout under the grid, and a frame is out of that too: a stack's members
   * are counted there because the reader can expand the stack and act on each one, where a frame
   * is the composite's and cannot be reached or acted on at all while the composite stands for it.
   * Counted, it reads "27 photos" under a grid holding one.
   */
  it('counts itself as one entry, not as one plus every frame', () => {
    const panorama = mergeTwoFrames();
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('frame001', 'frame002', ?)").run(panorama);

    for (const filters of [{ includeDeleted: false }, { includeDeleted: false, expandStacks: true }]) {
      const listed = listing.listByShoot('s1', 'added_asc', 0, 10, filters);
      expect(listed.total).toBe(listed.photos.length);
      expect(listed.total).toBe(1);
      expect(listed.photoTotal).toBe(1);
    }
  });

  /**
   * **The viewer's own run is a listing too.**
   *
   * `neighboursAt` walks the collection uncollapsed, which drops `representativeFilter` - and a
   * panorama's frames were hidden by it. Left out, stepping off a panorama walked into the two
   * photographs it stands for rather than to the next picture, and the filmstrip opened the band
   * around whichever frame it landed on.
   */
  it('stands for its frames in the run the viewer steps through', () => {
    const panorama = mergeTwoFrames();

    const run = navigation.neighboursInLibrary(LIB, 'added_asc', panorama, 10, { includeDeleted: false }).map((p) => p.id);

    expect(run).toContain(panorama);
    expect(run).not.toContain('frame001');
    expect(run).not.toContain('frame002');
  });

  // A saved merge is opened straight from these, before any listing has loaded it, and the
  // viewer offers "Edit merge" rather than the RAW editor by this.
  it('is read as composed in the viewer run and in the detail too', () => {
    db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/r', 'lib')").run(LIB);
    const panorama = mergeTwoFrames();

    const run = navigation.neighboursInLibrary(LIB, 'added_asc', panorama, 10, { includeDeleted: false });

    expect(run.find((p) => p.id === panorama)?.composite_kind).toBe('panorama');
    expect(run.find((p) => p.id === 'live')?.composite_kind).toBeNull();
    expect(listing.getById(panorama)?.composite_kind).toBe('panorama');
    expect(listing.getById(panorama)?.frame_count).toBe(2);
  });

  it('stands for them in a range read between two photographs', () => {
    const panorama = mergeTwoFrames();

    const between = navigation.rangeInLibrary(LIB, 'added_asc', { from: null, to: null }, { includeDeleted: false });

    expect(between.map((p) => p.id).sort()).toEqual(['live', panorama].sort());
  });

  it('gives the frames back to the readout when it is binned', () => {
    const panorama = mergeTwoFrames();
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('frame001', 'frame002', ?)").run(panorama);

    paths.markDeleted(panorama, null);

    expect(listing.listByShoot('s1', 'added_asc', 0, 10, { includeDeleted: false }).photoTotal).toBe(2);
  });

  it('gives the frames back to the library when it is binned', () => {
    const panorama = mergeTwoFrames();

    paths.markDeleted(panorama, null);

    expect(LIVE_IDS()).not.toContain(panorama);
    expect(LIVE_IDS()).toEqual(['frame001', 'frame002', 'live']);
  });

  // The frames are ordinary photographs again, so binning one is the ordinary thing.
  it('lets a frame be binned on its own once the panorama has gone', () => {
    const panorama = mergeTwoFrames();
    paths.markDeleted(panorama, null);

    paths.markDeleted('frame001', 'Trip/one.arw');

    expect(LIVE_IDS()).toEqual(['frame002', 'live']);
  });

  it('takes them back when the panorama is restored', () => {
    const panorama = mergeTwoFrames();
    paths.markDeleted(panorama, null);

    paths.markRestored(panorama, null);

    expect(LIVE_IDS()).toContain(panorama);
    expect(LIVE_IDS()).not.toContain('frame001');
  });

  // Binning is not what removes a panorama's copies: it is still in the Bin and still has to draw
  // there. The edges go with the row itself, which is what a purge or a rebuilt catalogue does.
  it('drops the edges outright when the row itself goes', () => {
    const panorama = mergeTwoFrames();

    db.query('DELETE FROM photos WHERE id = ?').run(panorama);

    expect(repo.framesOf(panorama)).toEqual([]);
    expect(repo.composedFrom('frame001')).toEqual([]);
    expect(LIVE_IDS()).toEqual(['frame001', 'frame002', 'live']);
  });
});

// What a composite's copies are decided by, which is a question about its frames rather than
// about itself: `renditions::sourceFor` reads both halves, and neither is knowable from the
// composite's own row.
describe('PhotoCompositesRepository, the documents behind a composite', () => {
  const STAMP = '01a084e624e40000ueee1n2ebb8p7y9r';
  const develop = (id: string, stamp: string): void => {
    db.query(
      `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp)
         VALUES (?, '{}', 0, 1, '2026-01-01T00:00:00.000Z', ?)`,
    ).run(id, stamp);
  };
  const pendingRow = (id: string): { inputs_edited: number; built_from: string | null } => {
    const row = processing.listPendingProcessing(LIB).find((pending) => pending.photo_id === id);
    if (row == null) throw new Error(`${id} is not pending`);
    return { inputs_edited: row.inputs_edited, built_from: row.built_from };
  };
  const placedAt = (id: string): string =>
    (db.query('SELECT stamp_placement AS at FROM photos WHERE id = ?').get(id) as { at: string }).at;

  /** A composite of two frames, owing its tile: the pending row is what the queue reads. */
  function composite(): string {
    // A library row, which the pending query joins, and which nothing else in this file needs.
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(LIB, '/tmp/lib', 'Trip');
    const id = mergeTwoFrames();
    // `insertComposite` queues the composite's own; 'live' is inserted here as raw SQL and has
    // none, and both have to be pending for the query below to answer about them.
    for (const photoId of [id, 'live']) {
      db.query(
        `INSERT INTO renditions (photo_id, variant, needs_build) VALUES (?, 'grid', 1)
           ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 1`,
      ).run(photoId);
    }
    return id;
  }

  it('reports a frame someone developed, and is built from the newest of it and the recipe', () => {
    const panorama = composite();
    const placed = placedAt(panorama);
    expect(pendingRow(panorama)).toEqual({ inputs_edited: 0, built_from: placed });

    develop('frame002', STAMP);
    expect(pendingRow(panorama)).toEqual({ inputs_edited: 1, built_from: placed > STAMP ? placed : STAMP });

    const later = `${placed}z`;
    develop('frame001', later);
    expect(pendingRow(panorama)).toEqual({ inputs_edited: 1, built_from: later });
    expect(processing.builtFromOf(panorama)).toBe(later);
    // The composite's own row is unedited either way: this is what the canvas is *composed* of.
    expect(processing.listPendingProcessing(LIB).find((row) => row.photo_id === panorama)?.edits).toBeNull();
  });

  it('builds a photograph from its own document alone, whatever its placement', () => {
    composite();
    db.query("UPDATE photos SET stamp_placement = 'zzzz' WHERE id = 'live'").run();
    develop('live', STAMP);

    expect(pendingRow('live')).toEqual({ inputs_edited: 0, built_from: STAMP });
  });

  // A reopened assembly saved elsewhere arrives as a recipe alone, with no document moving.
  it('owes a composite its copies again once its recipe changes', () => {
    const panorama = composite();
    for (const variant of ['grid', 'full', 'full-hdr', 'max'] as const) {
      processing.markCopyBuilt(panorama, '2026-06-01T00:00:00.000Z', processing.builtFromOf(panorama), variant);
    }
    const current = (): boolean => {
      const stamps = processing.renditionStamps(panorama, 'max');
      return renditionCurrent(stamps?.built_from ?? null, stamps?.edited_from ?? null);
    };
    expect(current()).toBe(true);
    expect(processing.queueEditedSince([panorama])).toBe(0);

    db.query('UPDATE photos SET stamp_placement = ? WHERE id = ?').run(`${placedAt(panorama)}z`, panorama);

    expect(current()).toBe(false);
    expect(processing.queueEditedSince([panorama])).toBe(1);
  });

  it('answers whether any of a set the merge is about to build is developed', () => {
    composite();
    expect(repo.anyEdited(['frame001', 'frame002'])).toBe(false);

    develop('frame002', STAMP);

    expect(repo.anyEdited(['frame001', 'frame002'])).toBe(true);
    expect(repo.anyEdited([])).toBe(false);
  });
});
