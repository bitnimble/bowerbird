// Merging a selection into a panorama, with the module replaced by a worker that
// answers a canned recipe. What is pinned here is the loop around it: the stack,
// the recipe on the row, and the copies the stack owes afterwards.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../db/migrate';
import { AssemblyRecipeSchema, type AssemblyRecipe, type Seams } from '../../../schemas/assembly';
import { DEFAULT_SETTINGS, type Settings } from '../../../schemas/settings';
import { dataPathForLibraryId, draftLayerPath, draftVolumePath } from '../../../utils/paths';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoEditsRepository } from '../../photo_edits/photo_edits_repository';
import { PhotoCompositesRepository } from '../../photos/composites/photo_composites_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { withShownRendition } from '../../photos/listing/photo_read_service';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { ProcessingService } from '../../processing/pipeline/processing_service';
import type { CompositeJob, ProcessingResult } from '../../processing/workers/processing_types';
import { RENDITION_EXTENSION } from '../../processing/renditions/renditions';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import type { AssemblyJob, Carved } from '../../../schemas/assembly';
import { CompositesService, layerKeyOf } from '../composites_service';

const LIB = 'panoramas-service-test';

const ASSEMBLY_SAMPLE = path.join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json');

const posted: CompositeJob[] = [];

function recipe(photoIds: readonly string[]): unknown {
  return {
    version: 1,
    sources: photoIds.map((photoId) => ({
      photoId,
      size: [6000, 4000],
      rotation: [1, 0, 0, 0],
      focal: 5200,
      lens: { crop: 1, distortion: [0, -0.01] },
      gain: 1,
    })),
    projection: 'cylindrical',
    canvas: [9000, 4200],
    centre: [4500, 2100],
    radiansPerPixel: 1 / 5200,
    crop: [0.05, 0.1, 0.95, 0.9],
    reference: 0,
    seamRmsPx: null,
  };
}

/** Photographs whose lens the align says nothing has ever fitted, until one is measured. */
let lensless: string[] = [];

/** Fails the next render job rather than the align, since today's insert happens after the align. */
let failNextBuild = false;

/** Where a failed build's own partial file lands, planted by `MockWorker` so the test can assert it is gone. */
let plantedRenditionFile: string | null = null;

/** The tiles a carve answers, over whichever two frames it was handed. */
function analysed(photoIds: readonly string[]): string {
  const sample = AssemblyRecipeSchema.parse(JSON.parse(readFileSync(ASSEMBLY_SAMPLE, 'utf8')));
  return JSON.stringify({
    recipe: {
      ...sample,
      sources: photoIds.map((photoId, at) => ({ ...sample.sources[at % sample.sources.length]!, photoId })),
    },
    unaligned: true,
    warnings: [],
  });
}

/**
 * Seam solves the worker was asked for, which answer `SOLVED` for every pick set they carry but one
 * taking the same frame everywhere, which is refused.
 */
const seamed: Extract<CompositeJob, { want: 'seams' }>[] = [];
const SOLVED: Seams = {
  pick: [1, 0],
  base: 0,
  vertices: [
    [0, 0],
    [10, 0],
    [10, 10],
  ],
  tiles: [[0, 1, 2]],
  source: [1],
  zone: [0],
  corridor: [0.01],
  warp: [[1, 0, 0, 1, 0, 0]],
  exposure: [1],
};

/** How many carves answer that a lens was never measured before one answers tiles. */
let lenslessCarves = 0;

/** Set while a test wants to decide for itself when a carve answers. */
let heldOpen = false;
/** Releases the carve a held test is holding, in the order they were posted. */
const holding: (() => void)[] = [];

/** A worker that aligns whatever it is given and renders nothing. */
class MockWorker {
  onmessage: ((event: { data: ProcessingResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {}
  postMessage(job: CompositeJob): void {
    posted.push(job);
    if (job.want === 'seams') {
      seamed.push(job);
      queueMicrotask(() => {
        const answers = job.picks.map((pick) => (new Set(pick).size === 1 ? null : SOLVED));
        this.onmessage?.({ data: { photoId: job.photoId, success: true, composite: JSON.stringify(answers) } });
      });
      return;
    }
    if (job.want === 'analyse') {
      const answer = (): void => {
        if (lenslessCarves > 0) {
          lenslessCarves -= 1;
          const composite = JSON.stringify({ lensless: [job.sources[0]!.photoId] });
          this.onmessage?.({ data: { photoId: job.photoId, success: true, composite } });
          return;
        }
        writeFileSync(job.volumePath, 'volume');
        this.onmessage?.({
          data: { photoId: job.photoId, success: true, composite: analysed(job.sources.map((s) => s.photoId)) },
        });
      };
      if (heldOpen) holding.push(answer);
      else queueMicrotask(answer);
      return;
    }
    if (job.kind === 'composite' && job.want === 'render' && failNextBuild) {
      failNextBuild = false;
      // A build that fails part way can still have written the file before the error, which is
      // exactly what `deleteGeneratedFilesFor` exists to clean up - so the failure path plants one.
      const dir = path.join(dataPathForLibraryId(LIB), 'renditions', 'grid');
      mkdirSync(dir, { recursive: true });
      plantedRenditionFile = path.join(dir, `${job.photoId}${RENDITION_EXTENSION}`);
      writeFileSync(plantedRenditionFile, '');
      queueMicrotask(() => {
        this.onmessage?.({ data: { photoId: job.photoId, success: false, error: 'the device went away' } });
      });
      return;
    }
    // A render writes its targets, which is what lets a test ask whether the second call built
    // anything or found what the first one left.
    if (job.want === 'render') {
      for (const target of job.targets) {
        mkdirSync(path.dirname(target.outputPath), { recursive: true });
        writeFileSync(target.outputPath, '');
      }
    }
    queueMicrotask(() => {
      const answered =
        job.want === 'align'
          ? JSON.stringify({
              recipe: recipe(job.sources.map((source) => source.photoId)),
              rmsPx: 0.4,
              dropped: [],
              lensless,
              warnings: [],
            })
          : undefined;
      this.onmessage?.({ data: { photoId: job.photoId, success: true, composite: answered } });
    });
  }
  terminate(): void {}
}

const REAL_WORKER = globalThis.Worker;

let db: Database;
let root: string;
let panoramas: CompositesService;
let photoComposites: PhotoCompositesRepository;
let photoListing: PhotoListingRepository;
let photoMetadata: PhotoMetadataRepository;
let photoPaths: PhotoPathsRepository;
let photoProcessing: PhotoProcessingRepository;
let libraries: LibrariesRepository;
let renditions: RenditionsRepository;
let edits: PhotoEditsRepository;

function settings(): SettingsRepository {
  const values: Settings = { ...DEFAULT_SETTINGS };
  return { get: () => values } as SettingsRepository;
}

/** A photograph someone has developed, which is all `sourceFor` reads of one. */
function edited(id: string, stamp = '01a084e624e40000ueee1n2ebb8p7y9r'): void {
  db.query(
    `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp)
       VALUES (?, '{"exposure":0.5}', 0, 1, '2026-01-02T00:00:00.000Z', ?)`,
  ).run(id, stamp);
}

function photo(id: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, date_taken)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 6000, 4000, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, LIB, `${id}.arw`, `2026-01-01T00:00:0${id.slice(-1)}.000Z`);
}

beforeEach(() => {
  posted.length = 0;
  seamed.length = 0;
  lenslessCarves = 0;
  lensless = [];
  failNextBuild = false;
  heldOpen = false;
  holding.length = 0;
  plantedRenditionFile = null;
  (globalThis as { Worker?: unknown }).Worker = MockWorker;
  root = mkdtempSync(path.join(tmpdir(), 'bb-pano-'));
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(LIB, root, 'Trip');
  for (const id of ['photo001', 'photo002', 'photo003']) photo(id);

  libraries = new LibrariesRepository(db);
  renditions = new RenditionsRepository(db);
  const stackMembership = new StackMembership(db);
  photoPaths = new PhotoPathsRepository(db, stackMembership);
  photoProcessing = new PhotoProcessingRepository(db, renditions);
  photoComposites = new PhotoCompositesRepository(db, stackMembership, photoPaths);
  photoListing = new PhotoListingRepository(db);
  photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  edits = new PhotoEditsRepository(db);
  panoramas = new CompositesService(
    photoComposites,
    photoPaths,
    photoMetadata,
    photoProcessing,
    libraries,
    renditions,
    // Told where the documents are, as the server wires it: a composite's framing is one of them,
    // so a render that could not read them would compose the whole canvas.
    new ProcessingService(photoProcessing, photoPaths, photoListing, settings(), (photoId) => edits.docFor(photoId)),
    edits,
  );
});

afterEach(() => {
  globalThis.Worker = REAL_WORKER;
  rmSync(root, { recursive: true, force: true });
  rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
});

describe('CompositesService.merge', () => {
  it('writes the photograph the recipe composes and builds what it owes', async () => {
    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    // A photograph of its own, composed from the frames, with those frames indexed under it.
    const made = photoPaths.getBasicById(photoId);
    expect(made?.recipe.kind).toBe('panorama');
    expect(photoComposites.framesOf(photoId)).toEqual(['photo001', 'photo002']);
    // And it is not a stack: nothing was grouped to make it.
    expect(photoListing.getById(photoId)?.stack_id).toBeNull();
    // The align first, then one job per copy it owes.
    expect(posted.map((job) => job.want)).toEqual(['align', 'render', 'render']);
    expect(posted.slice(1).map((job) => job.targets[0]?.rendition)).toEqual(['grid', 'full']);
    // Both from the sources, this library rendering for its viewer: what a composite's tile is
    // built from is the same question a photograph's is, and a library that has said it wants our
    // rendering does not want the cameras' in its grid (`renditions::sourceFor`).
    expect(posted.slice(1).map((job) => job.targets[0]?.source)).toEqual(['render', 'render']);
    // Every render job names the recipe's sources, in the recipe's own order.
    for (const job of posted.slice(1)) {
      expect(job.sources.map((source) => source.photoId)).toEqual(['photo001', 'photo002']);
      expect(job.want === 'render' && job.recipe).toBeTruthy();
    }
    // HDR by default, as a library is, and the grid tile always SDR - under the photograph's own
    // id, which is what makes every rule about a photograph's copies apply to it.
    expect(Object.keys(renditions.versions(photoId)).sort()).toEqual(['full-hdr', 'grid']);
  });

  /**
   * What the viewer opens the finished panorama at, over the real columns rather than a context
   * built by hand: the framing the merge writes gives every canvas a develop document, and read
   * as an edit the cameras' pictures cannot carry it would send a library that serves those
   * pictures to a render of the RAWs instead - the answer this whole path exists to avoid.
   */
  it('opens at the cameras pictures on a library that serves them, and at the render once a frame is edited', async () => {
    db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run('embedded', LIB);
    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);
    // Through a listing, which is where the columns this turns on are actually selected.
    const shownFor = (id: string): string | undefined =>
      withShownRendition(
        photoListing.listByLibrary(LIB, 'added_desc', 0, 50, { includeDeleted: false }).photos,
        libraries,
        settings(),
      ).find(
        (row) => row.id === id,
      )?.shown_rendition;

    expect(shownFor(photoId)).toBe('embedded');

    // A frame someone developed is an edit no JPEG of that frame holds, so the canvas is shown
    // the render - which is the copy `owedOf` queues for exactly that row.
    edited('photo001');
    expect(shownFor(photoId)).toBe('full');
  });

  /**
   * A recipe is stated in the camera's corrected geometry, so a composite of the photographs
   * themselves reaches each RAW through that lens's ratio table - and the table is the stored
   * camera match, which is only ever fitted inside a render. A library serving the cameras'
   * pictures renders nothing, so without this the RAW composite is stitched uncorrected and
   * doubles every edge at every seam, while the composite of the JPEGs comes out perfect.
   */
  it('fits a lens nothing has measured and aligns again, rather than stitching without one', async () => {
    lensless = ['photo001'];
    const measured: string[] = [];
    const processing = new ProcessingService(photoProcessing, photoPaths, photoListing, settings(), (id) => edits.docFor(id));
    processing.measureCameraMatch = async (_raw: string, photoId: string): Promise<void> => {
      measured.push(photoId);
      lensless = [];
    };
    const service = new CompositesService(
      photoComposites,
      photoPaths,
      photoMetadata,
      photoProcessing,
      libraries,
      renditions,
      processing,
      edits,
    );

    await service.mergePanorama(['photo001', 'photo002']);

    expect(measured).toEqual(['photo001']);
    // Twice: what the first align could not state, the second one can.
    expect(posted.filter((job) => job.want === 'align')).toHaveLength(2);
  });

  // The framing the align found, on the row rather than only in the recipe: every render of a
  // panorama - the renditions here, an export, the editor - trims to it through the field a
  // reader's own crop uses, and the row's shape is what that leaves.
  it('writes the framing the align found as the composites own crop', async () => {
    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    const doc = edits.get(photoId).doc;
    expect([doc.cropLeft, doc.cropTop, doc.cropRight, doc.cropBottom]).toEqual([0.05, 0.1, 0.95, 0.9]);
    // And the renders were told: a job that framed nothing would write the whole canvas.
    expect(posted[1]?.geometry.crop).toEqual([0.05, 0.1, 0.95, 0.9]);
    const made = photoListing.getById(photoId);
    expect([made?.width, made?.height]).toEqual([8100, 3360]);
    // And the grid lays it out at that, not at the crop squared: those two numbers have already
    // had the framing taken off them, so a listing that applied the document to them again would
    // put a 0.9-by-0.8 crop on at 0.81 by 0.64.
    expect([made?.display_width, made?.display_height]).toEqual([8100, 3360]);
  });

  /**
   * And the copies it builds are stamped against that framing.
   *
   * The stamp a copy records is the newest document behind the canvas, its own or a frame's, and
   * its own is the framing written moments earlier - so a copy stamped with the frames' alone
   * reads as older than the row it was built for, which is a rebuild owed the instant the merge
   * ends. The frame here is deliberately the older of the two.
   */
  it('stamps what it builds with the newest document behind the canvas', async () => {
    edited('photo001', '00000000000000000000000000000001');

    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    const framing = edits.docFor(photoId)?.stamp;
    expect(framing).not.toBeNull();
    const built = db
      .query('SELECT built_from FROM renditions WHERE photo_id = ? AND built_at IS NOT NULL')
      .all(photoId) as { built_from: string | null }[];
    expect(built.length).toBeGreaterThan(0);
    for (const row of built) expect(row.built_from).toBe(framing ?? '');
  });

  // **The tile and nothing else.** A library serving the cameras' pictures is shown this canvas
  // composited from them, and that is done when a reader opens it: a merge is over in seconds,
  // and a pan nobody opens costs nothing. The row has to stop owing the copy all the same, or
  // every batch for the life of the library picks it up to build one it will never be queued for.
  it('composites the tile alone where the library serves the cameras own pictures', async () => {
    db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run('embedded', LIB);

    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    expect(posted.map((job) => job.want)).toEqual(['align', 'render']);
    expect(posted[1]?.targets[0]?.source).toBe('embedded');
    expect(Object.keys(renditions.versions(photoId)).sort()).toEqual(['grid']);
    expect(db.query('SELECT variant FROM renditions WHERE photo_id = ? AND needs_build = 1').all(photoId)).toEqual([]);
  });

  // **A frame someone has developed is not the picture its camera wrote.** Composite that camera's
  // JPEG and the reader's own edit is in the editor and nowhere else - the same fault a photograph
  // is kept from by rendering an edited one, one row further out.
  it('renders the tile once a frame carries an edit, whatever the library serves', async () => {
    db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run('embedded', LIB);
    edited('photo002');

    await panoramas.mergePanorama(['photo001', 'photo002']);

    expect(posted.slice(1).map((job) => job.targets[0]?.source)).toEqual(['render', 'render']);
  });

  // The sources are opened by absolute path, since the module has no library.
  it('hands the worker the originals', async () => {
    await panoramas.mergePanorama(['photo001', 'photo002']);

    expect(posted[0]?.sources.map((source) => source.rawFilePath)).toEqual([
      path.join(root, 'photo001.arw'),
      path.join(root, 'photo002.arw'),
    ]);
  });

  it('refuses fewer than two photographs', async () => {
    await expect(panoramas.mergePanorama(['photo001'])).rejects.toThrow(/at least two/);
  });

  // What the export and the queue ask, of the composite itself: it is the row that renders, and
  // its frames are resolved by id so that one renamed or moved is still found.
  it('answers with the frames a composite renders from', async () => {
    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    const renderable = panoramas.renderable(photoId);
    expect(renderable?.sources.map((source) => source.photoId)).toEqual(['photo001', 'photo002']);
    expect(renderable?.recipe.sources).toHaveLength(2);
  });

  // A *frame* is a photograph, and asking for one means the frame. That the composite exists is
  // not a reason to hand back something the caller did not name.
  it('says nothing about a frame of one, nor about a photograph in none', async () => {
    await panoramas.mergePanorama(['photo001', 'photo002']);

    expect(panoramas.renderable('photo002')).toBeNull();
    expect(panoramas.renderable('photo003')).toBeNull();
  });

  it('a merge that fails while building leaves no row, no edits, no rendition rows and no files', async () => {
    // The frames already own rendition rows of their own, so unmoved proves it, not zero.
    const renditionsBefore = (db.query('SELECT COUNT(*) AS n FROM renditions').get() as { n: number }).n;

    failNextBuild = true;
    await expect(panoramas.mergePanorama(['photo001', 'photo002'])).rejects.toThrow();

    const rows = db.query("SELECT id FROM photos WHERE json_extract(recipe, '$.kind') != 'file'").all();
    expect(rows).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS n FROM photo_edits').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM renditions').get()).toEqual({ n: renditionsBefore });
    expect(plantedRenditionFile).not.toBeNull();
    expect(existsSync(plantedRenditionFile as string)).toBe(false);
  });
});

/** A carve started, and every fraction its job reported until it settled. */
async function carve(photoIds: string[]): Promise<AssemblyJob & { fractions: number[] }> {
  return await settled(panoramas.startAssembly(photoIds));
}

async function settled(id: string): Promise<AssemblyJob & { fractions: number[] }> {
  const fractions: number[] = [];
  for (;;) {
    const job = panoramas.assemblyJob(id)!;
    fractions.push(job.fraction);
    if (job.status !== 'analysing') return { ...job, fractions };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function carveReady(photoIds: string[]): Promise<Carved> {
  const job = await carve(photoIds);
  if (job.carved == null) throw new Error(job.error ?? job.status);
  return job.carved;
}

/**
 * §2.1's four refusals and §3.9's one-at-a-time.
 *
 * Unlike a merge, this answers before there is a photograph: the tiles and the picks are the
 * reader's, made on a page that reads the job while the analysis runs.
 */
describe('CompositesService.startAssembly', () => {
  it('refuses fewer than two photographs', () => {
    expect(() => panoramas.startAssembly(['photo001'])).toThrow(/at least two/);
  });

  it('refuses more than twelve frames', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `photo${String(i).padStart(3, '0')}`);
    expect(() => panoramas.startAssembly(ids)).toThrow(/at most 12/);
  });

  it('refuses frames from more than one library', async () => {
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(
      'other',
      path.join(root, 'elsewhere'),
      'Elsewhere',
    );
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('elsewher', 'other', json_object('kind', 'file', 'path', 'x.arw'), 6000, 4000, '2026-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => panoramas.startAssembly(['photo001', 'elsewher'])).toThrow(/one library/);
  });

  it('refuses a photograph that is itself a composite', async () => {
    const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

    expect(() => panoramas.startAssembly([photoId, 'photo003'])).toThrow(/cannot be a frame/);
  });

  it('refuses a binned photograph, and one that is gone', () => {
    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run('photo002');
    expect(() => panoramas.startAssembly(['photo001', 'photo002'])).toThrow(/photo002 is in the bin/);
    expect(() => panoramas.startAssembly(['photo001', 'nothere1'])).toThrow(/nothere1 is gone/);
  });

  it('answers a job at once, which holds the tiles the carve found once it is ready', async () => {
    heldOpen = true;
    const id = panoramas.startAssembly(['photo002', 'photo001']);
    expect(panoramas.assemblyJob(id)).toMatchObject({ status: 'analysing', fraction: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    heldOpen = false;
    holding.shift()?.();

    let job = panoramas.assemblyJob(id)!;
    while (job.status === 'analysing') {
      await new Promise((resolve) => setTimeout(resolve, 1));
      job = panoramas.assemblyJob(id)!;
    }
    expect(job.status).toBe('ready');
    const found = job.carved!.analysed;
    expect(found.recipe.tiles).toHaveLength(2);
    expect(found.recipe.sources.map((source) => source.photoId)).toEqual(['photo001', 'photo002']);
    // The carve, which aligns for itself, then a layer per source - all on the one worker a merge
    // already uses.
    expect(posted.map((job) => job.want)).toEqual(['analyse', 'render', 'render']);
  });

  // A lens nothing has measured is the carve's to find, not an align's run first to look for it.
  it('fits a lens the carve could not reach through, then carves again', async () => {
    lenslessCarves = 1;

    const job = await carve(['photo001', 'photo002']);

    expect(job.carved?.analysed.recipe.tiles).toHaveLength(2);
    expect(posted.filter((sent) => sent.want === 'analyse')).toHaveLength(2);
    expect(job.fractions).toEqual([...job.fractions].sort((a, b) => a - b));
  });

  // §3.9: one at a time. Two carves would hold the device against each other for minutes, and
  // there is one counter behind `jobProgress`, so two at once report each other's progress.
  it('queues a second carve behind the first rather than running both', async () => {
    heldOpen = true;
    const first = carve(['photo001', 'photo002']);
    const second = carve(['photo002', 'photo003']);
    const raced = await Promise.race([
      Promise.all([first, second]).then(() => 'both'),
      new Promise((resolve) => setTimeout(() => resolve('neither'), 10)),
    ]);
    expect(raced).toBe('neither');
    expect(holding).toHaveLength(1);

    holding.shift()?.();
    await first;
    // Only now does the second reach the worker, which is what "behind the first" means.
    await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 10))]);
    expect(holding).toHaveLength(1);
    holding.shift()?.();
    await second;
  });

  // A page is keyed by its job, so the same frames asked for twice are two carves.
  it('carves again for the same frames asked for a second time', async () => {
    await carveReady(['photo001', 'photo002']);
    await carveReady(['photo001', 'photo002']);
    expect(posted.filter((job) => job.want === 'analyse')).toHaveLength(2);
  });

  it('reports how far the carve has got, never backwards, ending at the whole', async () => {
    const job = await carve(['photo001', 'photo002']);

    // Counted in the process's one cell, which only a job that asks may move.
    expect(posted.map((sent) => [sent.want, sent.reportProgress ?? false])).toEqual([
      ['analyse', true],
      ['render', false],
      ['render', false],
    ]);
    expect(job.fraction).toBe(1);
    expect(job.fractions).toEqual([...job.fractions].sort((a, b) => a - b));
  });

  it('holds a failed carve with its reason', async () => {
    failNextBuild = true;
    const job = await carve(['photo001', 'photo002']);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
  });

  /**
   * §4.3: the page draws each source's own picture of the canvas, masked to the tiles picking it,
   * so a carve that answered tiles and no layers is a merge page with nothing on it.
   */
  it('renders a layer per source, each the canvas drawn from that one frame', async () => {
    const { layers, analysed: found } = await carveReady(['photo001', 'photo002']);
    expect(found.unaligned).toBe(true);

    expect(layers).toHaveLength(found.recipe.sources.length);
    const renders = posted.filter((job) => job.want === 'render');
    expect(renders).toHaveLength(2);
    // Each is the recipe's geometry with no tiles over its base: same set, same coding - which is
    // what makes a layer the pixels the finished picture would take from it.
    for (const [at, job] of renders.entries()) {
      const recipe = job.recipe as { kind: string; tiles: number[][]; pick: number[]; base: number; seams?: unknown };
      expect(recipe.kind).toBe('assembly');
      expect(recipe.base).toBe(at);
      expect([recipe.tiles, recipe.pick, recipe.seams]).toEqual([[], [], undefined]);
      expect(job.sources.map((source) => source.photoId)).toEqual(['photo001', 'photo002']);
      // The size a viewer opens a canvas at, which is what this page is. `max` was tried, on the
      // theory that the preview looked soft because `full` caps an assembly at
      // `full_rendition_size`; `synth_raw --grid` then measured the carve losing *less* contrast
      // than an ordinary single-frame render does, so the cap was never what made it soft and the
      // native-resolution encode was minutes bought for nothing.
      expect(job.targets.map((target) => target.rendition)).toEqual(['full']);
    }
    // Under the key the files are named by, which the page fetches them from.
    const key = layerKeyOf(libraries.getById(LIB)!, found.recipe);
    expect(layers).toEqual([`/image/drafts/${LIB}/${key}/0`, `/image/drafts/${LIB}/${key}/1`]);
    expect(existsSync(draftLayerPath(dataPathForLibraryId(LIB), key, 1))).toBe(true);
  });

  // The key is everything the pixels are a function of, so a layer already written is this layer.
  it('finds the layers a first carve left rather than rendering them again', async () => {
    await carveReady(['photo001', 'photo002']);
    posted.length = 0;

    const { layers } = await carveReady(['photo001', 'photo002']);

    expect(layers).toHaveLength(2);
    expect(posted.filter((job) => job.want === 'render')).toEqual([]);
  });

  // What the library serves its pictures from changes what a layer *is*, so it cannot be found
  // under the key the other setting wrote.
  it('keys the layers by the rendition setting they were drawn with', () => {
    const sample = AssemblyRecipeSchema.parse(JSON.parse(readFileSync(ASSEMBLY_SAMPLE, 'utf8')));
    const library = libraries.getById(LIB)!;

    expect(layerKeyOf({ ...library, rendition_source: 'embedded' }, sample)).not.toBe(
      layerKeyOf(library, sample),
    );
  });

  it('cancel stops a carve, and the job says it was cancelled rather than that it failed', async () => {
    const id = panoramas.startAssembly(['photo001', 'photo002']);
    panoramas.cancelAssembly(id);

    let job = panoramas.assemblyJob(id)!;
    while (job.status === 'analysing') {
      await new Promise((resolve) => setTimeout(resolve, 1));
      job = panoramas.assemblyJob(id)!;
    }
    expect(job.status).toBe('cancelled');
    // And nothing was asked of the device at all: the cancel arrived before the carve started.
    expect(posted).toEqual([]);
  });

  it('a cancel landing as the analysis answers stops the carve before its layers, and not the next', async () => {
    heldOpen = true;
    const id = panoramas.startAssembly(['photo001', 'photo002']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    panoramas.cancelAssembly(id);
    heldOpen = false;
    holding.shift()?.();

    expect((await settled(id)).status).toBe('cancelled');
    expect(posted.map((job) => job.want)).toEqual(['analyse']);
    expect((await carve(['photo001', 'photo002'])).status).toBe('ready');
  });

  it('a cancel after a carve is ready leaves it ready', async () => {
    const job = await carve(['photo001', 'photo002']);
    panoramas.cancelAssembly(job.id);
    expect(panoramas.assemblyJob(job.id)!.status).toBe('ready');
  });
});

/** §2.8: seams solved for the reader's picks, over the volume the carve left beside its layers. */
describe('CompositesService seams', () => {
  const carved = async (): Promise<AssemblyRecipe> =>
    (await carveReady(['photo001', 'photo002'])).analysed.recipe;

  it('keeps the carve volume beside its layers, and names it on the recipe', async () => {
    const recipe = await carved();

    expect(recipe.seamVolume).toBe(layerKeyOf(libraries.getById(LIB)!, recipe));
    expect(existsSync(draftVolumePath(dataPathForLibraryId(LIB), recipe.seamVolume!))).toBe(true);
    const analyse = posted.find((job) => job.want === 'analyse');
    expect(analyse?.want === 'analyse' && existsSync(analyse.volumePath)).toBe(false);
  });

  it('solves over that volume for every pick set it is handed, in one job', async () => {
    const recipe = await carved();

    const seams = await panoramas.solveSeams(recipe, [
      [1, 0],
      [1, 1],
    ]);

    expect(seams).toEqual([SOLVED, null]);
    expect(seamed).toHaveLength(1);
    expect(seamed[0]?.volumePath).toBe(draftVolumePath(dataPathForLibraryId(LIB), recipe.seamVolume!));
    expect(seamed[0]?.picks).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(seamed[0]?.recipe).toMatchObject({ vertices: recipe.vertices, seams: undefined });
  });

  it('answers none once the volume is reaped', async () => {
    const recipe = await carved();
    rmSync(draftVolumePath(dataPathForLibraryId(LIB), recipe.seamVolume!));

    expect(await panoramas.solveSeams(recipe, [recipe.pick])).toBeNull();
    expect(seamed).toEqual([]);
  });

  it('commits seams solved afresh, whatever the page sent', async () => {
    const recipe = await carved();
    posted.length = 0;

    const { photoId } = await panoramas.commitAssembly({ ...recipe, pick: [1, 0], seams: undefined });

    const stored = photoPaths.getBasicById(photoId)?.recipe;
    expect(stored?.kind === 'assembly' && stored.seams).toEqual(SOLVED);
    const renders = posted.filter((job) => job.want === 'render');
    expect(renders.every((job) => (job.recipe as AssemblyRecipe).seams != null)).toBe(true);
  });

  it('without the volume, keeps seams solved for these picks and drops stale ones', async () => {
    const recipe = await carved();
    rmSync(draftVolumePath(dataPathForLibraryId(LIB), recipe.seamVolume!));

    const kept = await panoramas.commitAssembly({ ...recipe, pick: [1, 0], seams: SOLVED });
    const dropped = await panoramas.commitAssembly({ ...recipe, pick: [0, 1], seams: SOLVED });

    const seamsOf = (photoId: string): unknown => {
      const stored = photoPaths.getBasicById(photoId)?.recipe;
      return stored?.kind === 'assembly' ? stored.seams : 'not an assembly';
    };
    expect(seamsOf(kept.photoId)).toEqual(SOLVED);
    expect(seamsOf(dropped.photoId)).toBeUndefined();
  });

  it('renders the settled preview under the picks it is a picture of, and finds it again after', async () => {
    const recipe = await carved();
    const asked = { ...recipe, pick: [1, 0], seams: SOLVED };
    posted.length = 0;

    const url = await panoramas.previewOf(asked);
    const again = await panoramas.previewOf(asked);

    expect(again).toBe(url);
    const renders = posted.filter((job) => job.want === 'render');
    expect(renders).toHaveLength(1);
    // The recipe as the page has it, tiles and seams and all: this is the picture Save writes.
    expect(renders[0]?.recipe).toMatchObject({ pick: [1, 0], seams: SOLVED });
    const key = layerKeyOf(libraries.getById(LIB)!, asked);
    expect(url.startsWith(`/image/drafts/${LIB}/${key}/preview-`)).toBe(true);
    expect(existsSync(renders[0]?.targets[0]?.outputPath ?? '')).toBe(true);
    // Nothing was solved for it: the page had already solved these seams and sent them.
    expect(seamed).toEqual([]);
  });

  it('renders a different picture for a different pick set', async () => {
    const recipe = await carved();

    const one = await panoramas.previewOf({ ...recipe, pick: [1, 0], seams: SOLVED });
    const two = await panoramas.previewOf({ ...recipe, pick: [0, 1], seams: SOLVED });

    expect(one).not.toBe(two);
  });

  it('draws each layer from the tiles, never the seams', async () => {
    await carved();

    const layers = posted.filter((job) => job.want === 'render');
    expect(layers.map((job) => (job.recipe as AssemblyRecipe).seams)).toEqual([undefined, undefined]);
  });
});

/** §2.5's Done, and §2.7's reopen: the same insert-then-build a panorama's merge does past its align. */
describe('CompositesService.commitAssembly', () => {
  const finished = (base = 0): AssemblyRecipe => {
    const sample = AssemblyRecipeSchema.parse(JSON.parse(readFileSync(ASSEMBLY_SAMPLE, 'utf8')));
    return {
      ...sample,
      base,
      sources: ['photo001', 'photo002'].map((photoId, at) => ({ ...sample.sources[at]!, photoId })),
    };
  };

  const assemblies = (): string[] =>
    (db.query("SELECT id FROM photos WHERE json_extract(recipe, '$.kind') = 'assembly'").all() as { id: string }[]).map(
      (row) => row.id,
    );

  it('writes the photograph the recipe composes and builds what it owes', async () => {
    const { photoId } = await panoramas.commitAssembly(finished());

    expect(photoPaths.getBasicById(photoId)?.recipe.kind).toBe('assembly');
    expect(photoComposites.framesOf(photoId)).toEqual(['photo001', 'photo002']);
    // No align: the reader made the picks, so there is nothing left to search for.
    expect(posted.map((job) => job.want)).toEqual(['render', 'render']);
    // Watched, so counted.
    expect(posted.map((job) => job.reportProgress)).toEqual([true, true]);
    expect(posted.map((job) => job.targets[0]?.rendition)).toEqual(['grid', 'full']);
    expect(Object.keys(renditions.versions(photoId)).sort()).toEqual(['full-hdr', 'grid']);
    // The framing on the row, so a reader can move it like any other crop.
    expect(edits.get(photoId).doc.cropLeft).toBe(finished().crop[0]);
  });

  // §5.4's rule, reused rather than re-derived: a photograph with nothing to look at is worse
  // than no photograph.
  it('leaves no photograph behind when the build fails', async () => {
    failNextBuild = true;

    await expect(panoramas.commitAssembly(finished())).rejects.toThrow();

    expect(assemblies()).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS n FROM photo_edits').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM renditions WHERE photo_id NOT IN (SELECT id FROM photos)').get()).toEqual({
      n: 0,
    });
    expect(existsSync(plantedRenditionFile as string)).toBe(false);
  });

  // The base is the frame the picture is mostly made of, so it is where the assembly files itself.
  it('files itself under the base frame, whichever one that is', async () => {
    const { photoId } = await panoramas.commitAssembly(finished(1));

    const made = photoListing.getById(photoId);
    expect(made?.date_taken).toBe('2026-01-01T00:00:02.000Z');
  });

  // §2.7, §4.4: the recipe names its frames, and a frame may have gone since the page opened it.
  it('refuses by name when a source has gone or been binned since the page opened it', async () => {
    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run('photo002');
    await expect(panoramas.commitAssembly(finished())).rejects.toThrow(/photo002 is in the bin/);
    db.query('DELETE FROM photos WHERE id = ?').run('photo002');
    await expect(panoramas.commitAssembly(finished())).rejects.toThrow(/photo002 is gone/);
    expect(assemblies()).toEqual([]);
  });

  describe('updateAssembly', () => {
    it('rewrites the rows recipe rather than inserting a second photograph', async () => {
      const { photoId } = await panoramas.commitAssembly(finished(0));
      const before = photoMetadata.allIds().length;

      await panoramas.updateAssembly(photoId, { ...finished(1), pick: [0, 0] });

      expect(photoMetadata.allIds()).toHaveLength(before);
      expect(assemblies()).toEqual([photoId]);
      const stored = photoPaths.getBasicById(photoId)?.recipe;
      expect(stored?.kind).toBe('assembly');
      expect(stored?.kind === 'assembly' && stored.pick).toEqual([0, 0]);
    });

    it('refuses by name when a source has gone since the merge', async () => {
      const { photoId } = await panoramas.commitAssembly(finished());
      db.query('DELETE FROM photo_sources WHERE photo_id = ?').run('photo002');
      db.query('DELETE FROM photos WHERE id = ?').run('photo002');

      await expect(panoramas.updateAssembly(photoId, finished())).rejects.toThrow(/gone/);
    });

    it('refuses a photograph that is not an assembly', async () => {
      const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

      await expect(panoramas.updateAssembly(photoId, finished())).rejects.toThrow(/not an assembly/);
    });
  });

  /** §2.7: reopening one is loading the recipe and rebuilding the layers, not carving again. */
  describe('reopenAssembly', () => {
    it('answers the rows own recipe and its layers, with nothing analysed again', async () => {
      const { photoId } = await panoramas.commitAssembly(finished(1));
      posted.length = 0;

      const reopened = await panoramas.reopenAssembly(photoId);

      expect(reopened.recipe.base).toBe(1);
      expect(reopened.missingSources).toEqual([]);
      expect(reopened.layers).toHaveLength(2);
      expect(posted.map((job) => job.want)).toEqual(['render', 'render']);
    });

    // A source deleted or binned since is what stops this: named, and no canvas, since a composite
    // is drawn from every frame it names or from none.
    it('names a source that has been binned since, and draws nothing', async () => {
      const { photoId } = await panoramas.commitAssembly(finished());
      db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run('photo002');
      posted.length = 0;

      const reopened = await panoramas.reopenAssembly(photoId);

      expect(reopened.missingSources).toEqual(['photo002']);
      expect(reopened.layers).toEqual([]);
      expect(posted).toEqual([]);
    });

    it('refuses a photograph that is not an assembly', async () => {
      const { photoId } = await panoramas.mergePanorama(['photo001', 'photo002']);

      await expect(panoramas.reopenAssembly(photoId)).rejects.toThrow(/not an assembly/);
    });
  });
});
