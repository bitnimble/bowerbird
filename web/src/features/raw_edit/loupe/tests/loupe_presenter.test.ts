import { beforeEach, describe, expect, test } from 'bun:test';
import { neutralEdits } from '../../../../../../src/schemas/photo_edits';
import type { CropStore } from '../../crop/crop_store';
import type { EditStore } from '../../edit/edit_store';
import type { KeystoneStore } from '../../keystone/keystone_store';
import { RawEditPresenter } from '../../stage/raw_edit_presenter';
import type { StageStore } from '../../stage/stage_store';
import {
  drawnBy,
  FakeDecoder,
  KEEP,
  openEditor,
  openedWith,
  type Editor,
} from '../../stage/tests/raw_edit_harness';
import { TILE_QUIET_MS } from '../loupe_presenter';
import type { LoupeStore } from '../loupe_store';

let editor: Editor;
let stage: StageStore;
let edit: EditStore;
let crop: CropStore;
let keystone: KeystoneStore;
let loupe: LoupeStore;
let presenter: RawEditPresenter;
let decoder: FakeDecoder;

beforeEach(() => {
  editor = openEditor();
  ({ edit, stage, crop, keystone, loupe, presenter, decoder } = editor);
});

const drawn = (): Promise<number> => drawnBy(editor);

function opened(overrides: Record<string, unknown> = {}): void {
  openedWith(editor, overrides);
}

/**
 * The loupe, which is arithmetic on a region and so belongs here.
 *
 * What a Playwright test would add is that a pointer really moved and a canvas really drew;
 * what it could not say is *which pixels* the reader is looking at, and that is the whole of
 * what a magnifier is for.
 */
describe('the loupe', () => {
  const BOX = { width: 1000, height: 750 };

  /** The view the loupe is held over: the whole 4000x3000 picture, fitted. */
  async function fitted(): Promise<void> {
    presenter.showRegion({ x: 0, y: 0, width: 4000, height: 3000 });
    await drawn();
  }

  test('magnifies the point under the pointer, not the middle of the picture', async () => {
    await fitted();
    presenter.setLoupe(true);
    // A quarter across and a quarter down the stage is a quarter into the region.
    presenter.moveLoupe({ x: 250, y: 187.5 }, BOX);
    await drawn();

    const region = decoder.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(1000, 0);
    expect(region.y + region.height / 2).toBeCloseTo(750, 0);
  });

  test('shows a square of source pixels the magnification decides', async () => {
    await fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    await drawn();

    // 400 screen pixels at 2x is 200 of the photograph's own, and the box is square whatever
    // shape the stage is.
    const region = decoder.loupeRegion!;
    expect(region.width).toBeCloseTo(200, 5);
    expect(region.height).toBeCloseTo(200, 5);
  });

  test('a wheel notch narrows the window, and the ends hold', async () => {
    await fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    await drawn();
    const before = decoder.loupeRegion!.width;

    // Away from the reader is more magnification, which is fewer source pixels.
    presenter.zoomLoupe(-1, BOX);
    await drawn();
    expect(decoder.loupeRegion!.width).toBeLessThan(before);

    for (let notch = 0; notch < 40; notch++) presenter.zoomLoupe(-1, BOX);
    expect(loupe.loupeMagnification).toBe(16);
    for (let notch = 0; notch < 80; notch++) presenter.zoomLoupe(1, BOX);
    expect(loupe.loupeMagnification).toBe(1);
  });

  test('magnifies what the reader is already zoomed into', async () => {
    // Half the picture on the stage, so one stage pixel is half a source pixel - and the loupe
    // still answers in the photograph's own pixels rather than the view's.
    presenter.showRegion({ x: 1000, y: 750, width: 2000, height: 1500 });
    await drawn();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    await drawn();

    const region = decoder.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(2000, 0);
    expect(region.y + region.height / 2).toBeCloseTo(1500, 0);
    expect(region.width).toBeCloseTo(200, 5);
  });

  test('draws nothing once the pointer has left, and forgets where it was on close', async () => {
    await fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    await drawn();
    const drew = decoder.loupeDraws;

    presenter.moveLoupe(null, BOX);
    await drawn();
    expect(decoder.loupeDraws).toBe(drew);
    expect(loupe.loupeAt).toBeNull();

    // And a glass put away takes the draw it was owed with it, rather than magnifying one
    // last window onto a canvas nobody is looking at.
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    presenter.setLoupe(false);
    await drawn();
    expect(decoder.loupeDraws).toBe(drew);
    expect(loupe.loupeAt).toBeNull();
  });

  test('parks against the edge rather than magnifying past it', async () => {
    await fitted();
    presenter.setLoupe(true);
    // A drag that ran off the corner: the glass stops on the picture, which is all there is to
    // magnify.
    presenter.moveLoupe({ x: -300, y: 2000 }, BOX);
    await drawn();

    expect(loupe.loupeAt).toEqual({ x: 0, y: 750 });
    const region = decoder.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(0, 0);
    expect(region.y + region.height / 2).toBeCloseTo(3000, 0);
  });

  test('is one tool among the others, so opening it puts the geometry tools away', () => {
    presenter.setTool('crop');
    expect(loupe.tool).toBe('crop');

    presenter.setTool('loupe');
    expect(loupe.tool).toBe('loupe');
    expect(crop.cropping).toBe(false);
    expect(keystone.keystoning).toBe(false);
  });

  /**
   * A tile decoded in the tab is handed the *photograph's* numbers, not left to measure a crop's.
   *
   * The fit is the one this exists to pin. `galosh::Fit::Given` is what the request carries it as,
   * and a tile that fits its own is denoised between 0.49 and 1.51 times the frame's strength -
   * which is a magnifier that disagrees with the export it predicts and moves as the reader pans.
   * The levels are the same argument about the grade, and the frame's size is what makes the
   * rectangle mean anything at all: everything the window is grown by is measured against it.
   *
   * No server: this is the arm that has one and does not use it, so the tile route being untouched
   * is half the claim (`e2e/local_decode.spec.ts` makes the other half in a browser).
   */
  test('builds a local tile against the frame, not against the crop', async () => {
    void fitted();
    const noiseFit = {
      alpha: 0.0001,
      sigmaSq: 0.000001,
      unifiedSigma: 1.19,
      darkRef: [0, 0, 0, 0] as [number, number, number, number],
    };
    stage.noiseFit = noiseFit;
    stage.levels = { white: 8133, peak: 13783, floor: 141 };
    edit.doc = {
      ...neutralEdits(),
      luminanceNoise: 55,
      colourNoise: 65,
      sharpening: 70,
      clarity: 40,
    };

    opened({
      photoId: 'a-photo-id',
      local: {
        decoder,
        open: {
          longEdge: 0,
          grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
          defringe: 0.5,
        },
        photoAnalysis: [7, 7, 7],
      },
    });
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);

    await Bun.sleep(TILE_QUIET_MS + 50);
    expect(decoder.tiles).toHaveLength(1);
    const request = decoder.tiles[0]!;
    expect(request.noiseFit).toEqual(noiseFit);
    expect(request.levels).toEqual({ white: 8133, peak: 13783, floor: 141 });
    expect(request.frame).toEqual([4000, 3000]);
    expect(request.denoiseLuminance).toBe(55);
    expect(request.denoiseColour).toBe(65);
    // The sharpen comes off the document rather than the open, since the reader can move it
    // between the two; the defringe is the library's and rides through untouched.
    expect(request.strengths).toEqual({ sharpen: 0.7, defringe: 0.5 });
    expect(request.photoAnalysis).toEqual([7, 7, 7]);
    // The presence sliders, which decide how far past the rectangle the window has to reach.
    expect(request.adjust.clarity).toBe(40);
    const rect = request.tile;
    expect(rect[2]).toBeGreaterThan(0);
    expect(rect[0] + rect[2]).toBeLessThanOrEqual(4000);
  });

  /**
   * A tile is built once and drawn from where it was built.
   *
   * Both halves matter. **Once**, because a pointer sweep inside one tile is dozens of draws and
   * rebuilding a window per move would put the tile's cost on every one of them; and **the glass
   * draws from it**, in the window's own coordinates rather than the frame's, which is where a
   * tile drawn at the frame's origin would magnify the wrong place entirely.
   */
  test('builds a local tile once and magnifies the window it holds', async () => {
    void fitted();
    Object.assign(presenter, { photoId: 'a-photo-id' });
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    await Bun.sleep(TILE_QUIET_MS + 50);

    await drawn();

    expect(loupe.loupeSharp).toBe(true);
    expect(decoder.tiles).toHaveLength(1);
    expect(decoder.holding).toBe(true);

    // The window's own coordinates: the rectangle asked for begins `keep` inside it, so what the
    // glass reads is the pointer's window less the window's origin in the frame.
    const magnified = decoder.loupeRegion;
    expect(magnified?.x).toBeGreaterThanOrEqual(0);
    expect((magnified?.x ?? 0) + (magnified?.width ?? 0)).toBeLessThanOrEqual(KEEP.width);

    const built = decoder.tiles.length;
    presenter.moveLoupe({ x: 502, y: 377 }, BOX);
    await drawn();
    expect(decoder.tiles).toHaveLength(built);
  });
});
