// An editor over a store and a module that only record what they were told, for the presenters'
// tests to drive.
import { RawEditPresenter } from '../raw_edit_presenter';
import { CropStore } from '../../crop/crop_store';
import { EditStore } from '../../edit/edit_store';
import type { EditAdjust, EditGeometry, Region, SoftProof } from '../../edits';
import { KeystoneStore } from '../../keystone/keystone_store';
import type { LocalPrepare, LocalTileRequest, TileKeep } from '../../local_decode/local_open';
import { LoupeStore } from '../../loupe/loupe_store';
import { RepairStore } from '../../repair/repair_store';
import { PrintStore } from '../../print/print_store';
import type { PrintScene } from '../../print/print_scene';
import { StageStore } from '../stage_store';
import { neutralEdits } from '../../../../../../src/schemas/photo_edits';
import type { Repair } from '../../../../../../src/schemas/stored_grid';
import { MemoryStorage } from '../../../../test_storage';

/** The window a held tile's rectangle sits at inside it, as the module answers `holdTile`. */
export const KEEP: TileKeep = { left: 44, top: 44, width: 512, height: 512 };

/** The library's grade, as an open carries it. */
export const GRADE = { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 };

/**
 * What the presenter tells the module, and nothing else.
 *
 * **Every rule about the picture is the module's**, so what is checkable here is what it was
 * *told*: the exposure in stops, the window, each slider under its own name, the geometry. A
 * transposed pair or a slider wired to its neighbour is a wrong field on this object - and which
 * uniform slot each field lands in is one implementation now, pinned natively by
 * `edit-words.txt`.
 */
export class FakeDecoder {
  constructor(private readonly keystone: KeystoneStore) {}

  geometry: EditGeometry | null = null;
  adjust: EditAdjust | null = null;
  proof: SoftProof | null = null;
  exposure = 0;
  draws = 0;

  /**
   * The backing store the stage is at.
   *
   * Carried on a tick only when it moved, so the last one told stands - which is what the
   * worker does with it.
   */
  stage = { width: 300, height: 150 };
  print: PrintScene | null = null;

  /**
   * Every frame asked for: the window it read, the picture that window is on, and the canvas
   * it landed on. Which is the whole of a draw, geometrically.
   */
  readonly frames: {
    region: Region;
    output: { width: number; height: number };
    stage: { width: number; height: number };
  }[] = [];

  /** What the loupe was last asked to magnify, and how many times it was asked. */
  loupeRegion: Region | null = null;
  loupeDraws = 0;

  /** Every strip written into the frame, and how often the blur was rebuilt for them. */
  readonly bands: { top: number; rows: number; mosaic: LocalPrepare }[] = [];
  detailRebuilds = 0;

  /** Every tile built and kept, and whether one is still held for the glass to draw. */
  readonly tiles: LocalTileRequest[] = [];
  holding = false;

  /** A GPU that answers the instant it is asked, which is what a fake one is. */
  landed: () => Promise<void> = () => Promise.resolve();

  tick(tick: {
    ev: number;
    drawStage: boolean;
    region: Region | null;
    loupe: Region | null;
    adjust: EditAdjust | null;
    geometry: EditGeometry | null;
    proof: SoftProof | null;
    print: PrintScene | null;
    stage: { width: number; height: number } | null;
  }): Promise<void> {
    if (tick.adjust != null) this.adjust = tick.adjust;
    if (tick.geometry != null) this.geometry = tick.geometry;
    if (tick.proof != null) this.proof = tick.proof;
    this.print = tick.print;
    if (tick.stage != null) this.stage = tick.stage;
    if (tick.drawStage && tick.region != null && this.geometry != null) {
      this.exposure = tick.ev;
      this.draws += 1;
      // The module works the output's size out from the geometry it was just handed; the store's
      // own `displaySize` is that same answer, which is what lets a window be checked against it.
      this.frames.push({
        region: tick.region,
        output: { ...this.keystone.output },
        stage: { ...this.stage },
      });
    }
    if (tick.loupe != null) {
      this.loupeRegion = tick.loupe;
      this.loupeDraws += 1;
    }
    return this.landed();
  }

  attach(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * What part of the picture a region reads from, as the module answers it.
   *
   * The identity here, which is what a neutral document makes it: the output *is* the picture, so
   * a fraction of one is a fraction of the other. A test that wants a geometry in the way assigns
   * its own.
   */
  picturePart: (region: Region) => Promise<[number, number, number, number]> = (region) => {
    const { width, height } = this.keystone.output;
    return Promise.resolve([
      region.x / width,
      region.y / height,
      region.width / width,
      region.height / height,
    ]);
  };

  /**
   * What the module says it is short of, in order, and what it was asked about.
   *
   * Queued rather than modelled: what tiles the module holds is the module's own bookkeeping, and
   * a second implementation of it here would be testing this file against itself. What the
   * presenter has to get right is the loop - ask, fetch what it is told to, hand it back, ask
   * again - and an empty queue is the module saying it needs nothing.
   */
  missing: ([number, number, number, number][] | null)[] = [];
  readonly shown: { level: [number, number]; rect: [number, number, number, number] }[] = [];

  showTiles(
    level: [number, number],
    rect: [number, number, number, number],
  ): Promise<{ missing: [number, number, number, number][] | null }> {
    this.shown.push({ level, rect });
    return Promise.resolve({ missing: this.missing.shift() ?? null });
  }

  /** Every set of squares handed back, which is what the module is told to keep. */
  readonly kept: [number, number, number, number][][] = [];

  takeTiles(framed: Uint8Array, asked: [number, number, number, number][]): Promise<string> {
    this.kept.push(asked);
    return this.takePicture(framed);
  }

  /** Every picture handed over after the open, which is what a zoom into a canvas is served. */
  readonly took: Uint8Array[] = [];

  takePicture(framed: Uint8Array): Promise<string> {
    this.took.push(framed);
    // The header the module answers with, which is the one that arrived: the page reads where the
    // window sits out of it, and the module has nothing to add.
    const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
    const length = view.getUint32(0, true);
    return Promise.resolve(new TextDecoder().decode(framed.subarray(4, 4 + length)));
  }

  releaseLoupe(): Promise<void> {
    return Promise.resolve();
  }

  holdTile(request: LocalTileRequest): Promise<TileKeep> {
    this.tiles.push(request);
    this.holding = true;
    return Promise.resolve(KEEP);
  }

  releaseTile(): Promise<void> {
    this.holding = false;
    return Promise.resolve();
  }

  bandInto(mosaic: LocalPrepare, top: number, rows: number): Promise<void> {
    this.bands.push({ top, rows, mosaic });
    this.framed = mosaic.repairs;
    return Promise.resolve();
  }

  /** Every set of repairs the frame that is up was redrawn with. */
  readonly redrawn: Repair[][] = [];

  redrawRepairs(repairs: Repair[]): Promise<void> {
    this.redrawn.push(repairs);
    this.framed = repairs;
    return Promise.resolve();
  }

  /** The repairs the frame last had drawn over it, which is what the search reads. */
  private framed: Repair[] | undefined;

  refreshDetail(): Promise<void> {
    this.detailRebuilds++;
    return Promise.resolve();
  }

  /**
   * Nothing new measured, which is every sweep but the one that first looks for particles.
   *
   * A test that wants the other case assigns its own.
   */
  analysis: () => Promise<number[] | null> = () => Promise.resolve(null);

  /**
   * Every loop the search was handed, with the repairs it was told to keep clear of and the ones
   * the frame carried.
   */
  readonly solved: {
    drawn: [number, number][];
    others: Repair[];
    framed: Repair[] | undefined;
    without: Repair | null;
    donor: [number, number] | null;
  }[] = [];
  /** What the search answers with, which a test sets. */
  offer: unknown = [];

  /** Whether each search was told the seam may grow. */
  readonly grown: boolean[] = [];

  solveRepair(
    drawn: [number, number][],
    others: Repair[],
    grow: boolean,
    without: Repair | null,
    donor: [number, number] | null,
  ): Promise<unknown> {
    this.grown.push(grow);
    this.solved.push({
      drawn,
      others,
      framed: this.framed,
      without,
      donor,
    });
    return Promise.resolve(this.offer);
  }

  /** Every set of repairs a picture prepared elsewhere was told to draw. */
  readonly repairsSet: Repair[][] = [];

  setRepairs(repairs: Repair[]): Promise<{ missing: [number, number, number, number][] | null }> {
    this.repairsSet.push(repairs);
    this.framed = repairs;
    return Promise.resolve({ missing: null });
  }

  /** How many times every held tile was let go. */
  dropped = 0;

  dropTiles(): Promise<void> {
    this.dropped += 1;
    return Promise.resolve();
  }

  /** Every loop a picture prepared elsewhere was told to hold the search of, and every release. */
  readonly searchedAround: ([number, number][] | null)[] = [];

  setSearched(drawn: [number, number][] | null): Promise<{ missing: [number, number, number, number][] | null }> {
    this.searchedAround.push(drawn);
    return Promise.resolve({ missing: null });
  }

  /** The geometry every point was mapped under. */
  readonly mappedUnder: EditGeometry[] = [];

  /**
   * Points of the output onto the picture, as the module maps them: the identity, which a neutral
   * document makes it. A test that wants a geometry in the way assigns its own.
   */
  pictureOfOutput: (geometry: EditGeometry, points: [number, number][]) => Promise<[number, number][]> = (
    geometry,
    points,
  ) => {
    this.mappedUnder.push(geometry);
    return Promise.resolve(points);
  };

  outputOfPicture(geometry: EditGeometry, points: [number, number][]): Promise<[number, number][]> {
    this.mappedUnder.push(geometry);
    return Promise.resolve(points);
  }

  /** Every thumbnail asked for. */
  readonly thumbnails: { side: number; ev: number; region: Region; repair: Repair }[] = [];

  repairThumbnail(side: number, ev: number, region: Region, repair: Repair): Promise<Blob> {
    this.thumbnails.push({ side, ev, region, repair });
    return Promise.resolve(new Blob([new Uint8Array(1)], { type: 'image/png' }));
  }

  /** Every thumbnail of a fill on offer asked for. */
  readonly optionThumbnails: { region: Region; showing: Repair | null; option: Repair }[] = [];

  optionThumbnail(_side: number, _ev: number, region: Region, showing: Repair | null, option: Repair): Promise<Blob> {
    this.optionThumbnails.push({ region, showing, option });
    return Promise.resolve(new Blob([new Uint8Array(1)], { type: 'image/png' }));
  }

  close(): void {
    /* the worker is the thing terminated, and nothing here has one */
  }
}

export type Editor = {
  edit: EditStore;
  stage: StageStore;
  crop: CropStore;
  keystone: KeystoneStore;
  repair: RepairStore;
  loupe: LoupeStore;
  print: PrintStore;
  presenter: RawEditPresenter;
  decoder: FakeDecoder;
};

/** The frames asked for and not yet run. Drained by `runFrames`, which is the display's job. */
let frames: FrameRequestCallback[] = [];

/**
 * A fresh editor on a neutral 4000x3000 photograph, opened as far as its tests need, with the
 * display's frames held for {@link runFrames}.
 */
export function openEditor(): Editor {
  frames = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  // The editor's habits are read from `localStorage` when a presenter is built, and a storage
  // another test file installed would carry one test's `setCropToFit(false)` into the next.
  globalThis.localStorage = new MemoryStorage();

  const edit = new EditStore();
  const stage = new StageStore(edit);
  const crop = new CropStore(stage, edit);
  const keystone = new KeystoneStore(stage, edit, crop);
  const repair = new RepairStore(edit, keystone);
  const loupe = new LoupeStore(crop, keystone, repair);
  const print = new PrintStore();
  edit.doc = neutralEdits();
  stage.width = 4000;
  stage.height = 3000;
  stage.status = 'live';
  // The whole picture, which is what the open leaves the view showing.
  stage.region = { x: 0, y: 0, width: 4000, height: 3000 };
  const editor = {
    edit,
    stage,
    crop,
    keystone,
    repair,
    loupe,
    print,
    presenter: new RawEditPresenter(edit, stage, crop, keystone, repair, loupe, print),
    decoder: new FakeDecoder(keystone),
  };
  // The presenter builds all of this when a photo opens, which needs a worker holding the RAW
  // and a mounted element. The box is the stage's CSS size, which the resize observer would
  // have reported.
  openedWith(editor);
  return editor;
}

/** The open, as the presenter holds it: the worker's handle and the settings it opened with. */
export function openedWith({ presenter, decoder }: Editor, overrides: Record<string, unknown> = {}): void {
  Object.assign(presenter, {
    local: { decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 } },
    drawable: true,
    maxTexture: 8192,
    box: { width: 1000, height: 750 },
    // What the open sees the picture's shape as. Without it the first edit reads a shape that
    // has "changed" from nothing and throws the reader's zoom away.
    shown: { width: 4000, height: 3000 },
    ...overrides,
  });
}

/**
 * Runs the frames the presenter asked for.
 *
 * Queued rather than run where they are asked for: the presenter coalesces onto *one*
 * outstanding frame, so a callback that runs inside `requestAnimationFrame` itself leaves the
 * handle set forever and every later request is dropped as already pending.
 */
export function runFrames(): void {
  for (const frame of frames.splice(0)) frame(0);
}

/**
 * Runs the frames asked for, and answers how many draws the editor has made.
 *
 * Awaited because the presenter waits for the GPU before it asks for another - a tick that has
 * been submitted and not landed is one the next request holds off for.
 */
export async function drawnBy({ decoder }: Editor): Promise<number> {
  runFrames();
  await Promise.resolve();
  return decoder.draws;
}
