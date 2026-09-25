// The editor's actions, against a store and a module that only record what they were told.
//
// This is the seam the architecture exists for: every mutation is on the presenter, so what a
// button does is answerable without a GPU, a server or a browser. An end-to-end run opening a
// real RAW answers the same questions slowly, and only ever says that *something* changed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  RawEditPresenter,
  REWINDOW_QUIET_MS,
} from '../raw_edit_presenter';
import { prepareOf } from '../../local_decode/open_photo';
import type { CropStore } from '../../crop/crop_store';
import { EditStore } from '../../edit/edit_store';
import type { KeystoneStore } from '../../keystone/keystone_store';
import type { LoupeStore } from '../../loupe/loupe_store';
import { StageStore } from '../stage_store';
import type { LocalPrepare } from '../../local_decode/local_open';
import type { Region } from '../../edits';
import type { PreparedHeader } from '../../../../../../src/schemas/prepared';
import { neutralEdits } from '../../../../../../src/schemas/photo_edits';
import { type EditCheckpoint, type EditState } from '../../../../../../src/schemas/photo_edits';
import { photoEditsApi } from '../../../../api/photo_edits';
import { ApiError } from '../../../../api/request';
import { pictureLevel } from '../../../../../../src/services/processing/workers/prepare_pool';
import {
  drawnBy,
  FakeDecoder,
  GRADE,
  openEditor,
  openedWith,
  runFrames,
  type Editor,
} from './raw_edit_harness';

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
 * Every slider, from the presenter's method to what the module is told.
 *
 * **This is what a Playwright run was for**, and it could say less: it moved a control, watched
 * the canvas change, and left the value unexamined. What a tick carries is a pure function of the
 * document, so the value is checkable here - and a slider wired to its neighbour or a scale
 * applied twice is a *wrong value*, not a canvas that failed to change.
 */
describe('a slider reaching the picture', () => {
  test('carries the exposure in stops, and asks for a frame', async () => {
    const before = await drawn();

    presenter.settleExposure(1.25);
    expect(await drawn()).toBeGreaterThan(before);

    // Stops rather than a gain: `colour.slang` is what raises it, so a host that converted here
    // would be applying the exposure twice.
    expect(decoder.exposure).toBeCloseTo(1.25, 6);
  });

  test('puts each tone and presence slider under its own name', async () => {
    // All at once and all different, because the failure being guarded against is two of them
    // swapped - which no single-slider check can see.
    presenter.settle({
      contrast: 11,
      highlights: -22,
      shadows: 33,
      whites: -44,
      blacks: 55,
      texture: -66,
      clarity: 77,
      dehaze: -88.5,
      vibrance: 99,
      saturation: -12,
    });
    await drawn();

    expect(decoder.adjust).toEqual({
      contrast: 11,
      highlights: -22,
      shadows: 33,
      whites: -44,
      blacks: 55,
      texture: -66,
      clarity: 77,
      dehaze: -88.5,
      vibrance: 99,
      saturation: -12,
      temperature: null,
      tint: null,
      colourProfile: 'matched',
    });
  });

  test('draws the neutral grade when the colour profile is none', async () => {
    presenter.setColourProfile('none');
    await drawn();

    expect(decoder.adjust?.colourProfile).toBe('none');
    expect(edit.doc?.colourProfile).toBe('none');
  });

  // A panel hands these to its controls as bare references, which call them with no `this`.
  test('keeps its presenter in every method a control holds on its own', () => {
    const {
      setDenoiser, setColourProfile, setCropAspect, previewStraighten, settleStraighten, setGuideKind, clearKeystone,
    } = presenter;
    setDenoiser('pmrid');
    setColourProfile('none');
    setCropAspect('original');
    previewStraighten(2);
    settleStraighten(3);
    setGuideKind('horizontal');
    clearKeystone();

    expect(edit.doc?.denoiser).toBe('pmrid');
    expect(edit.doc?.colourProfile).toBe('none');
    expect(edit.doc?.cropAngle).toBe(3);
  });

  test('leaves the white balance as the frame own until the reader moves it', async () => {
    edit.asShot = { temperature: 5487.3, tint: 11.4 };

    await drawn();
    // Nothing set, so the module is left to use the illuminant the camera recorded.
    expect(decoder.adjust?.temperature ?? null).toBeNull();

    presenter.settleBalance({ temperature: 6000 });
    await drawn();

    // Both halves, because half a white balance reads as a colour cast.
    expect(decoder.adjust?.temperature).toBe(6000);
    expect(decoder.adjust?.tint).toBe(11);
  });

  /**
   * The page spells the Detail defaults rather than reading them, and this is what holds the two
   * together.
   *
   * `prepareOf` cannot ask the schema for them: that module imports zod, which the page keeps out
   * of its bundle. So the numbers are written twice by necessity, and a default moved in
   * `EditDocSchema` alone would open every unedited photograph at a Detail nobody chose - silently,
   * since the editor and the rendition would each be internally consistent and disagree with each
   * other. A test can import zod, so the second copy is checked here.
   */
  test("opens an unedited photograph at the document schema's own Detail defaults", () => {
    const neutral = neutralEdits();

    expect(prepareOf(undefined)).toEqual({
      luminance: neutral.luminanceNoise,
      colour: neutral.colourNoise,
      denoiser: neutral.denoiser,
      sharpen: neutral.sharpening / 100,
      dust: {
        enabled: neutral.dustRemoval,
        sensitivity: neutral.dustSensitivity / 100,
        intensity: neutral.dustIntensity / 100,
      },
      repairs: neutral.repairs,
    });
  });

  test('holds the mosaic controls while the slider moves, and settles them on release', async () => {
    // Neither of these is a dispatch over the frame: the denoise and the dust correction both run
    // on the mosaic, inside the open, so a settled slider re-prepares the photograph off the mosaic
    // the worker is holding and the frame arrives a band at a time. What this asks is which
    // settings were sent, and how often - one entry per *sweep*, not per strip.
    const asked = (): LocalPrepare[] =>
      decoder.bands.filter((band) => band.top === 0).map((band) => band.mosaic);
    /** Long enough for a whole sweep of bands to resolve, each one a turn of its own. */
    const settled = async (): Promise<void> => {
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    };

    // **Nothing while the pointer is down.** A prepare is a decode from the mosaic down, so
    // running one per position spends it on pictures nobody sees and makes the control sticky.
    presenter.preview({ luminanceNoise: 55 });
    presenter.preview({ luminanceNoise: 58 });
    presenter.preview({ luminanceNoise: 60 });
    expect(asked()).toEqual([]);

    // The release is the reader looking at it, so it runs then - once, at where they stopped.
    presenter.settle({ luminanceNoise: 60, colourNoise: 20 });
    await settled();
    // The sharpen and the dust three ride along at what a photograph opens with, which is on and
    // conservative.
    expect(asked()).toEqual([
      {
        luminance: 60,
        colour: 20,
        denoiser: 'galosh',
        sharpen: 0.5,
        dust: { enabled: true, sensitivity: 0.25, intensity: 1 },
        repairs: [],
      },
    ]);

    // Every other slider goes through the same `preview`, so the guard against re-running it
    // has to be the *value*, not the call.
    const ran = asked().length;
    presenter.settle({ exposure: 1.2 });
    presenter.settle({ contrast: 40 });
    presenter.settleStraighten(3);
    await settled();
    expect(asked().length).toBe(ran);

    presenter.settle({ colourNoise: 21 });
    await settled();
    expect(asked().length).toBe(ran + 1);
    expect(asked().at(-1)?.colour).toBe(21);

    // **The dust three ride the same path, and have to.** They act on the mosaic exactly as the
    // denoise does, so a switch or a slider that reached the picture through the tick's adjust
    // instead would be a control that changed nothing - the frame the tick grades was corrected
    // before it arrived. The positions are documented 0-100 and the module reads fractions.
    presenter.settle({ dustRemoval: true, dustSensitivity: 80, dustIntensity: 60 });
    await settled();
    expect(asked().length).toBe(ran + 2);
    expect(asked().at(-1)?.dust).toEqual({ enabled: true, sensitivity: 0.8, intensity: 0.6 });

    // **The sharpening is on this path too, and the assertion above cannot see it.** Its 0.5 there
    // is the schema's own default arriving by coincidence, so a `prepareOf` that ignored the
    // document, or a `samePrepare` that stopped comparing the field, would still read 0.5 and still
    // pass. Moving it is what says the slider is wired to the deconvolution.
    presenter.settle({ sharpening: 90 });
    await settled();
    expect(asked().length).toBe(ran + 3);
    expect(asked().at(-1)?.sharpen).toBe(0.9);

    // Which filter runs is a re-prepare like the amounts are, and not a word in the tick's uniform.
    presenter.setDenoiser('pmrid');
    await settled();
    expect(asked().length).toBe(ran + 4);
    expect(asked().at(-1)?.denoiser).toBe('pmrid');

    // And nothing is asked for twice: settling the same positions again is the picture the frame
    // already holds, which must not cost a second re-prepare.
    presenter.settle({ dustRemoval: true, dustSensitivity: 80, dustIntensity: 60 });
    await settled();
    expect(asked().length).toBe(ran + 4);
  });

  /**
   * A sweep covers the frame in strips, and the blur is built once for it.
   *
   * The strips are what a reader watches arrive. Rebuilding the presence blur per strip would fit
   * it to a frame that is half at the old denoise and half at the new, which is a Clarity nobody
   * asked for on whichever half is drawn next.
   */
  test('fills the frame in bands and rebuilds the blur once', async () => {
    presenter.settle({ luminanceNoise: 44, colourNoise: 12 });
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();

    // 3000 rows at 1024 to a band, and the strips meet without a gap, an overlap or a run past
    // the end of the frame.
    expect(decoder.bands.map(({ top, rows }) => ({ top, rows }))).toEqual([
      { top: 0, rows: 1024 },
      { top: 1024, rows: 1024 },
      { top: 2048, rows: 952 },
    ]);
    expect(decoder.detailRebuilds).toBe(1);
  });

  test('sends the geometry the reader chose, not the one the tool is showing', async () => {
    presenter.settleStraighten(6);
    presenter.settleCrop({ left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 });
    await drawn();

    // `image::Geometry`'s own order, which is what `serde` reads it back as: left, top, right,
    // bottom. A pair transposed here is a crop taken out of the wrong side of the picture.
    expect(decoder.geometry?.crop[0]).toBeCloseTo(0.2, 6);
    expect(decoder.geometry?.crop[1]).toBeCloseTo(0.1, 6);
    expect(decoder.geometry?.crop[2]).toBeCloseTo(0.8, 6);
    expect(decoder.geometry?.crop[3]).toBeCloseTo(0.9, 6);
    expect(decoder.geometry?.angleDegrees).toBeCloseTo(6, 6);
  });

  test('proofs against HDR until the reader asks for sRGB, and redraws when they do', async () => {
    // Off an ordinary edit, so what this reads is the proof every tick already carries rather
    // than one the setter has just been handed.
    presenter.settle({ exposure: 0.25 });
    const drew = await drawn();
    expect(decoder.proof).toEqual({ output: 'hdr', intent: 'perceptual', displayHdr: false });

    presenter.setSoftProof('srgb');
    await drawn();

    expect(decoder.proof).toEqual({ output: 'srgb', intent: 'perceptual', displayHdr: false });
    // The picture is what moved, so a tick has to have been asked for: the edits are untouched
    // and nothing else on this path would go and get one.
    expect(decoder.draws).toBeGreaterThan(drew);
  });

  test('tells the module whether the display shows past SDR white, asked on every tick', async () => {
    const asked: string[] = [];
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => {
      asked.push(query);
      return { matches: query === '(dynamic-range: high)' };
    }) as typeof matchMedia;
    try {
      presenter.settle({ exposure: 0.25 });
      await drawn();
    } finally {
      globalThis.matchMedia = original;
    }
    expect(asked).toContain('(dynamic-range: high)');
    expect(decoder.proof?.displayHdr).toBe(true);
  });

  test('sends the perspective correction the guides produced', async () => {
    presenter.setGuides(
      [
        { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
        { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
      ],
      true,
    );
    await drawn();

    expect(decoder.geometry?.keystone).toEqual(edit.doc!.keystone!);
  });
});

/**
 * Every frame is drawn at a window on the picture it is a window *on*, onto a canvas of that
 * window's shape.
 *
 * A region is in the picture's own pixels, so anything that changes the picture's shape
 * invalidates it. A straighten does, on every move of the slider: the frame grows to a new
 * bounding box, and a draw still carrying the last one reads a sub-rectangle of the new
 * picture.
 *
 * The canvas is the other half, and the sharper one, because the shader scales the region onto
 * it axis by axis: a backing store left at the previous picture's shape does not letterbox the
 * new one, it stretches it. Fixing either from a React effect, which runs *after* the paint,
 * makes a drag alternate between the photograph and a distorted copy of it for as long as it
 * lasts.
 */
describe('the window each frame is drawn at', () => {
  test('never reads a window bigger than the picture it is on', async () => {
    for (const angle of [1, 2, 3, 4, 5, 6, 7, 8]) {
      presenter.previewStraighten(angle);
      await drawn();
    }

    expect(decoder.frames.length).toBeGreaterThan(4);
    for (const { region, output } of decoder.frames) {
      expect(region.width, `${region.width} of ${output.width}`).toBeLessThanOrEqual(output.width);
      expect(region.height, `${region.height} of ${output.height}`).toBeLessThanOrEqual(output.height);
    }
  });

  test('lands on a canvas of its own shape, on every frame of a drag', async () => {
    const shapes: string[] = [];
    for (const angle of [0.5, 1, 2, 3, 4, 5, 6, 7]) {
      presenter.previewStraighten(angle);
      await drawn();
      shapes.push(`${decoder.stage.width}x${decoder.stage.height}`);
    }

    // The stage really is following the picture, or the check below passes on a canvas that
    // never moved.
    expect(new Set(shapes).size).toBeGreaterThan(4);
    for (const { region, stage } of decoder.frames) {
      expect(stage.width / stage.height, `${stage.width}x${stage.height} for ${region.width}x${region.height}`).toBeCloseTo(
        region.width / region.height,
        2,
      );
    }
  });

  test('lands on a canvas of its own shape when the zoom moves too', async () => {
    presenter.showRegion({ x: 100, y: 100, width: 1200, height: 675 });
    await drawn();

    const last = decoder.frames.at(-1)!;
    expect(last.stage.width / last.stage.height).toBeCloseTo(1200 / 675, 2);
  });

  test('follows a shape that changed, and leaves a zoom that did not alone', async () => {
    presenter.showRegion({ x: 100, y: 100, width: 1000, height: 750 });
    await drawn();

    // A slider that leaves the picture the size it was must not throw the reader's zoom away.
    presenter.previewExposure(1);
    await drawn();
    expect(stage.region).toEqual({ x: 100, y: 100, width: 1000, height: 750 });

    // One that changes the shape has to, or the window is measured against a picture that is
    // no longer there.
    presenter.previewStraighten(6);
    await drawn();
    expect(stage.region).toEqual({ x: 0, y: 0, ...keystone.output });
  });

  /**
   * The lag this exists for: `getCurrentTexture` blocks the main thread once the swapchain is
   * full, so a drag that asks for a frame faster than the GPU returns them stalls inside the
   * draw call - and the slider under the hand freezes for as long as the picture takes.
   */
  test('never has two ticks on the GPU at once, however fast the slider moves', async () => {
    let landed: (() => void) | null = null;
    decoder.landed = () =>
      new Promise<void>((resolve) => {
        landed = resolve;
      });

    presenter.previewExposure(0.5);
    runFrames();
    expect(decoder.draws).toBe(1);

    // A whole drag's worth of positions while the first one is still drawing.
    for (const ev of [0.6, 0.7, 0.8, 0.9]) presenter.previewExposure(ev);
    runFrames();
    expect(decoder.draws).toBe(1);

    // And the last of them - not the four - the moment the GPU comes back.
    landed!();
    await Promise.resolve();
    await Promise.resolve();
    runFrames();
    expect(decoder.draws).toBe(2);
    expect(decoder.exposure).toBe(0.9);
  });

  /**
   * A command the GPU refused reaches the reader, rather than a black stage that says `live`.
   *
   * **This is the whole of what `gpu::refusal` is for.** A validation error rejects nothing on the
   * device: the offending dispatch is dropped, everything after it filters whatever the pass
   * before left, and what comes back is a photograph rather than a failure. The module keeps the
   * first one and hands it to the page on the next tick; this is the page's half of that, and
   * without it the tick's rejection is swallowed by the pump.
   */
  test('reports a tick the module refused', async () => {
    decoder.landed = () => Promise.reject(new Error('rawshim gpu: the browser refused a command'));

    presenter.previewExposure(0.5);
    runFrames();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();

    expect(stage.status).toBe('failed');
    expect(stage.message).toContain('refused a command');
  });

  /**
   * Closing is itself a source of rejections, and none of them is a failure worth reporting.
   *
   * The decoder refuses everything in flight as its worker goes down, so the tick that was on the
   * GPU when the reader pressed Done comes back as an error. Announcing that would be the editor
   * reporting a fault at the moment it stopped existing - and it would land on a store the panel
   * may still be reading.
   */
  test('says nothing about a tick that was in flight when the editor closed', async () => {
    decoder.landed = () => Promise.reject(new Error('this decoder was closed'));

    presenter.previewExposure(0.5);
    runFrames();
    presenter.close();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();

    expect(stage.status).not.toBe('failed');
  });
});

// The shape the stage is laid out on, which is `displaySize` - the server's own function - read
// through the store. It was a Playwright test that opened a RAW and compared the canvas's
// backing store, for a claim that is three numbers.
describe('the shape the picture takes', () => {
  test('is the frame until something changes it', () => {
    expect(keystone.output).toEqual({ width: 4000, height: 3000 });
  });

  test('inverts under a quarter turn, and comes back', async () => {
    presenter.turn(90);
    await drawn();
    expect(keystone.output).toEqual({ width: 3000, height: 4000 });
    expect(decoder.geometry?.rotate).toBe(90);

    presenter.turn(-90);
    expect(keystone.output).toEqual({ width: 4000, height: 3000 });
  });

  test('follows the crop, and the crop is of the straightened frame', () => {
    presenter.settleCrop({ left: 0.25, top: 0, right: 0.75, bottom: 1 });
    expect(keystone.output.width).toBe(2000);
    expect(keystone.output.height).toBe(3000);
  });

  test('grows with a straighten, because the frame does', () => {
    presenter.settleStraighten(45);
    // A 45-degree straighten on 4000x3000 needs a box of 4950 either way, which is the frame
    // the crop tool shows - the picture left over is the largest rectangle inside it, the
    // straighten having cropped to fit as it moved.
    presenter.setCropping(true);
    expect(keystone.output).toEqual({ width: 4950, height: 4950 });

    presenter.setCropping(false);
    expect(keystone.output.width).toBeLessThan(4950);
    expect(keystone.output.width).toBeGreaterThan(0);
  });

  test('shows the whole frame while the crop tool is open, cropped when it closes', async () => {
    presenter.settleCrop({ left: 0.25, top: 0, right: 0.75, bottom: 1 });

    presenter.setCropping(true);
    await drawn();
    expect(keystone.output).toEqual({ width: 4000, height: 3000 });
    expect(decoder.geometry?.crop[0]).toBe(0);

    presenter.setCropping(false);
    await drawn();
    expect(keystone.output.width).toBe(2000);
    expect(decoder.geometry?.crop[0]).toBe(0.25);
  });
});

// The header's selector, which is the two modes and the absence of both. One at a time is the
// rule it exists to make visible: each tool shows the frame with different things taken off it,
// so an overlay laid out under one is naming a different picture from the one under the other.
describe('the tool the pointer is in', () => {
  test('is whichever the selector names, and only ever one', () => {
    expect(loupe.tool).toBe('cursor');

    presenter.setTool('crop');
    expect(loupe.tool).toBe('crop');
    expect(keystone.keystoning).toBe(false);

    presenter.setTool('perspective');
    expect(loupe.tool).toBe('perspective');
    expect(crop.cropping).toBe(false);

    presenter.setTool('cursor');
    expect(crop.cropping).toBe(false);
    expect(keystone.keystoning).toBe(false);
  });
});

// The one pair whose slider position is not what the document holds. What a browser has to say
// about it is only that the frame's illuminant crossed from the server; the rules below are
// arithmetic over that number and a nullable pair.
describe('the white balance pair', () => {
  beforeEach(() => {
    edit.asShot = { temperature: 5487.3, tint: 11.4 };
  });

  test('sits at the frame own illuminant until the reader moves it', () => {
    expect(edit.doc?.temperature).toBeNull();
    // Rounded for the panel, because a solved illuminant arrives at 5487.3K.
    expect(edit.balance).toEqual({ temperature: 5487, tint: 11 });
  });

  test('stores both halves the moment either one moves', () => {
    presenter.settleBalance({ temperature: 6000 });

    // A temperature beside a null tint is not a white balance, it is half of one - and the
    // half that is missing reads as a colour cast.
    expect(edit.doc?.temperature).toBe(6000);
    expect(edit.doc?.tint).toBe(11);
  });

  test('has no pair at all where the camera recorded no neutral', () => {
    edit.asShot = null;
    expect(edit.balance).toBeNull();
  });

  // A drag back onto the snap is the reader undoing their balance, and "Custom" over the
  // camera's own numbers would carry this frame's illuminant onto the next photo pasted onto.
  test('gives the null pair back when the reader drags to the camera own', () => {
    presenter.settleBalance({ temperature: 6000 });
    presenter.settleBalance({ temperature: 5487 });

    expect(edit.doc?.temperature).toBeNull();
    expect(edit.doc?.tint).toBeNull();
    expect(edit.doc?.whiteBalanceMode).toBe('As Shot');
  });
});

describe('a picture prepared on the server', () => {
  // What the open tells the store about where the picture came from, and what the panels read off
  // it. The open itself is a fetch and a worker, which is the one part of this seam a unit test
  // cannot reach; what it decides is checkable, and this is it.
  test('closes the glass and the mosaic panels, and an ordinary open leaves both', () => {
    // As `opened` reports a backend arm: the header says there is a mosaic behind the picture -
    // a pan of RAWs does - and the arm says this side does not have it.
    const backend = new StageStore(new EditStore());
    Object.assign(backend, { preparedElsewhere: true, mosaic: false });
    expect(backend.preparedElsewhere).toBe(true);
    expect(backend.mosaic).toBe(false);

    // And the default is the local arm, so the panel's shape does not flicker on the way in.
    const fresh = new StageStore(new EditStore());
    expect(fresh.preparedElsewhere).toBe(false);
    expect(fresh.mosaic).toBe(true);
  });

  /**
   * The levels are held whole or not at all, because a tile handed two of the three is refused.
   *
   * `tone::Levels::usable` wants a floor as well as a white and a peak, and a set it refuses is a
   * set the tile re-measures **off its own crop** - which is a few hundred thousand photosites of
   * one corner rather than the photograph, and grades the loupe differently from the render it is
   * meant to be a window on. So a header with no floor has to leave nothing behind rather than a
   * pair the tile will hand back and have thrown away.
   */
  test('holds the levels only when the open measured a floor', () => {
    const header = {
      width: 4000,
      height: 3000,
      asShot: null,
      white: 8133,
      peak: 13783,
      floor: 141,
      matched: true,
      cameraMatch: 'lensAndColour',
      mosaic: true,
      defocus: [0, 0],
    } as unknown as PreparedHeader;
    const applied = (floor: number | null) =>
      (presenter as unknown as {
        describe(header: PreparedHeader, elsewhere: boolean): void;
      }).describe({ ...header, floor }, false);

    applied(141);
    expect(stage.levels).toEqual({ white: 8133, peak: 13783, floor: 141 });

    applied(null);
    expect(stage.levels).toBeNull();
  });

  test('the grade still ticks without asking the server for anything', async () => {
    opened({ local: { decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true } });
    stage.preparedElsewhere = true;

    // The whole point of handing over a coded frame: every slider the reader drags is a uniform
    // and a draw on their own device, whatever prepared the picture.
    presenter.settleExposure(1.25);
    await drawn();
    expect(decoder.exposure).toBeCloseTo(1.25);

    presenter.preview({ clarity: 40 });
    await drawn();
    expect(decoder.adjust?.clarity).toBe(40);
  });
});

/**
 * A canvas past what any adapter holds a whole level of, which is what makes levels exist.
 *
 * Over the 4096px ceiling on purpose: the coarsest level of it is a halving, so the picture an
 * open is handed is genuinely coarser than the canvas and the two sets of pixels are told apart.
 */
const PAN = {
  kind: 'panorama',
  canvas: [8000, 6000],
} as unknown as Parameters<typeof pictureLevel>[0];

/** The row's own dimensions, which for this canvas the align framed to nothing. */
const PAN_ROW = { width: 8000, height: 6000 };

describe('the level a zoom is served at', () => {
  /** Every prepare the presenter asked the server for, as the query stated it. */
  let asked: URL[];
  let realFetch: typeof globalThis.fetch;

  afterEach(() => {
    // Restored, because this runner shares a global with every other suite in the file: a `fetch`
    // left behind answers somebody else's request with a picture header.
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    asked = [];
    realFetch = globalThis.fetch;
    // **Answered through the server's own arithmetic, not a fixed header.** Which window a region
    // comes back as is the other side's decision, and a test that invented one would pass while
    // the two sides disagreed about what was in hand.
    globalThis.fetch = ((input: string | URL) => {
      const url = new URL(String(input), 'http://library.test');
      asked.push(url);
      const parts = (url.searchParams.get('region') ?? '0,0,1,1').split(',').map(Number);
      const [x = 0, y = 0, width = 1, height = 1] = parts;
      const at = pictureLevel(PAN, PAN_ROW, {
        region: { x, y, width, height },
        stage: Number(url.searchParams.get('stage') ?? 0),
      });
      const scale = 1 / 2 ** (at?.level ?? 0);
      const canvas = [
        Math.floor(PAN_ROW.width * scale),
        Math.floor(PAN_ROW.height * scale),
      ];
      const [left = 0, top = 0, wide = canvas[0] ?? 1, deep = canvas[1] ?? 1] = at?.window ?? [];
      // Framed as the library frames it: a `u32` header length, the header, then no samples. The
      // decoder here never reads them, and what is under test is what was asked for and what the
      // page did with the answer.
      const header = JSON.stringify({
        width: wide,
        height: deep,
        window: at?.window == null ? undefined : { canvas, origin: [left, top] },
        picture: [PAN_ROW.width, PAN_ROW.height],
        // What the page names back when it asks for the tiles of this level it is missing.
        level: at?.level ?? 0,
        finest: (at?.level ?? 0) === 0,
        white: 0.18,
        peak: 1,
        floor: null,
        grade: GRADE,
        strengths: { sharpen: 40, defringe: 0.5 },
        matched: true,
        cameraMatch: 'lensAndColour',
        mosaic: false,
        asShot: null,
        detail: [0, 0],
        defocus: [0, 0],
      });
      const text = new TextEncoder().encode(header);
      const body = new Uint8Array(4 + text.length);
      new DataView(body.buffer).setUint32(0, text.length, true);
      body.set(text, 4);
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof globalThis.fetch;

    // The store as the open leaves it: the picture at scale 1, which is what the page measures
    // everything against however coarse the samples behind it are.
    stage.width = PAN_ROW.width;
    stage.height = PAN_ROW.height;
    stage.region = { x: 0, y: 0, width: PAN_ROW.width, height: PAN_ROW.height };
    opened({
      photoId: 'pan001',
      local: { decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true },
      shown: { width: PAN_ROW.width, height: PAN_ROW.height },
      // The whole picture at the coarsest level it has, which is what an open is handed: 4000
      // canvas pixels across a picture of 8000, so the page's own pixels are twice the samples'.
      level: { number: 1, canvas: [4000, 3000] },
      levelScale: 0.5,
    });
    stage.preparedElsewhere = true;
    stage.stage = { width: 1600, height: 900 };
    decoder.pictureSize = { width: 4000, height: 3000 };
  });

  /** Runs whatever the pan or zoom left owed, which the presenter debounces. */
  async function settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, REWINDOW_QUIET_MS + 30));
  }

  /** A quarter of the picture, off-centre, which the coarse level can only magnify. */
  const QUARTER = { x: 2000, y: 1500, width: 2000, height: 1500 };

  test('maps a framed zoom into the held level before asking for picture coverage', async () => {
    opened({
      photoId: 'pan001',
      local: { decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true },
      level: { number: 2, canvas: [2000, 1500] },
      levelScale: 0.25,
    });
    const mapped: Region[] = [];
    decoder.picturePart = (region) => {
      mapped.push(region);
      return Promise.resolve([0.25, 0.2, 0.2, 0.2]);
    };
    presenter.print.setTouch(true);
    presenter.print.setFramed(true);
    presenter.setSoftProof('print3d');
    presenter.showRegion({ x: 2750, y: 1950, width: 1600, height: 1200 });
    await drawn();
    await settled();

    expect(mapped).toEqual([{ x: 687.5, y: 487.5, width: 400, height: 300 }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.searchParams.get('region')?.split(',').map(Number)).toEqual([0.25, 0.2, 0.2, 0.2]);
  });

  test('a zoom past what the held picture resolves asks for a window of it', async () => {
    presenter.showRegion(QUARTER);
    await settled();

    expect(asked.length).toBe(1);
    const query = asked[0]?.searchParams;
    // Fractions of the picture, so this side never has to know the canvas.
    expect(query?.get('region')?.split(',').map(Number)).toEqual([0.25, 0.25, 0.25, 0.25]);
    // And what it has to draw them on, so the other side can pick the level.
    expect(Number(query?.get('stage'))).toBe(1600);
  });

  test('a Detail setting is prepared again where the picture was, and every later ask carries it', async () => {
    presenter.prepare.seed(prepareOf(edit.doc!));
    presenter.settle({ sharpening: 80 });
    await settled();

    // Nothing here to re-run it on: the tiles at the old setting go, and the picture on screen is
    // asked for again at the new one.
    expect(decoder.bands).toEqual([]);
    expect(decoder.dropped).toBe(1);
    expect(asked.length).toBeGreaterThan(0);
    const develop = (url: URL | undefined): unknown => JSON.parse(url?.searchParams.get('develop') ?? 'null');
    expect(develop(asked.at(-1))).toMatchObject({ sharpening: 80, dustRemoval: true });

    decoder.missing = [[[1024, 2048, 1024, 1024]]];
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 900 });
    await settled();
    expect(develop(asked.at(-1))).toMatchObject({ sharpening: 80 });
  });

  test('an open of the rendition asks for the rendition on every window and tile after it', async () => {
    Object.assign(presenter, { fromRendition: true });
    presenter.showRegion(QUARTER);
    await settled();
    decoder.missing = [[[1024, 2048, 1024, 1024]]];
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 900 });
    await settled();

    expect(asked.map((url) => url.searchParams.get('from'))).toEqual(['rendition', 'rendition']);
    expect(asked.map((url) => url.searchParams.get('develop'))).toEqual([null, null]);
  });

  test('a small pan inside what is held asks for nothing', async () => {
    presenter.showRegion(QUARTER);
    await settled();
    expect(asked.length).toBe(1);

    // Inside the window that just arrived, and no more magnified: the picture on screen already
    // answers it, and a hundred megabytes for a pixel of pan is the failure this avoids.
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 20, y: QUARTER.y + 20 });
    await settled();
    expect(asked.length).toBe(1);
  });

  test('a pan fetches the tiles it is short of, not a window', async () => {
    // **The whole of why tiles exist.** A window refetched for a pan is mostly content already on
    // the device; a tile request is the part that is new. So the second ask names a level and a
    // rectangle of it - the module's own answer about what it is missing - where the first named a
    // region and a stage and let the server pick.
    presenter.showRegion(QUARTER);
    await settled();
    expect(asked.length).toBe(1);
    expect(asked[0]?.searchParams.get('region')).not.toBeNull();

    decoder.missing = [[[1024, 2048, 1024, 1024]]];
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 900 });
    await settled();

    expect(asked.length).toBe(2);
    const query = asked[1]?.searchParams;
    expect(query?.get('region'), 'a pan asked for a window again').toBeNull();
    expect(Number(query?.get('level'))).toBe(0);
    expect(query?.get('at')).toBe('1024,2048,1024,1024');
    expect(query?.get('parts')).toBe('1024,2048,1024,1024');
  });

  test('an L of missing tiles travels as its squares, not only as the box', async () => {
    // **What lets the backend open one source once and decode only its own share.** The box
    // bounding an L holds a corner nobody asked about; sent the squares, each source is decoded
    // for the box bounding *its* squares and a source only the corner reaches is never opened.
    presenter.showRegion(QUARTER);
    await settled();

    decoder.missing = [
      [
        [0, 0, 1024, 1024],
        [1024, 0, 1024, 1024],
        [0, 1024, 1024, 1024],
      ],
    ];
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 900 });
    await settled();

    const query = asked[asked.length - 1]?.searchParams;
    // The box spans both columns and both rows, where the squares are three of the four.
    expect(query?.get('at')).toBe('0,0,2048,2048');
    expect(query?.get('parts')?.split(';')).toEqual([
      '0,0,1024,1024',
      '1024,0,1024,1024',
      '0,1024,1024,1024',
    ]);
    // And the module is told to keep those three, so the corner the reply happens to cover is not
    // stored as though it were its own picture.
    expect(decoder.kept.at(-1)).toHaveLength(3);
  });

  test('the module is asked about more of the level than the reader can see', async () => {
    // "As we approach" is a dilation and nothing else: the tiles a reader is nearing are the tiles
    // inside a larger rectangle, so the reach is applied here and the module's own answer about
    // what is missing does the rest.
    presenter.showRegion(QUARTER);
    await settled();

    const [asked_] = decoder.shown.slice(-1);
    const [x = 0, y = 0, width = 0, height = 0] = asked_?.rect ?? [];
    // A quarter of the picture, at a level whose canvas is 8000 across, dilated a quarter of the
    // viewport on each side - so half the level's width rather than a quarter of it.
    expect(width).toBeGreaterThan(0.25 * 8000);
    expect(width).toBeLessThanOrEqual(0.5 * 8000 + 2);
    expect(x).toBeLessThan(0.25 * 8000);
    expect(y).toBeLessThan(0.25 * 6000);
    expect(height).toBeGreaterThan(0.25 * 6000);
  });

  test('a pan the module already holds tiles for costs no request', async () => {
    presenter.showRegion(QUARTER);
    await settled();
    expect(asked.length).toBe(1);

    // The module says it needs nothing, which is what holding the tiles means. A window would
    // have refetched here the moment the reader crossed its margin.
    decoder.missing = [];
    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 40 });
    await settled();
    expect(asked.length).toBe(1);
    // And it still assembled, so the reader sees the pan rather than the frame before it.
    expect(decoder.shown.length).toBeGreaterThan(1);
  });

  test('the reader keeps their zoom, and the draw reads it at the level it arrived at', async () => {
    presenter.showRegion(QUARTER);
    await settled();

    // The rectangle they are looking at still means what it meant: it is stated against the
    // picture at scale 1, which a finer level does not move.
    expect(stage.region).toEqual(QUARTER);
    expect([stage.width, stage.height]).toEqual([PAN_ROW.width, PAN_ROW.height]);

    // And the draw gets it in the level's own pixels. Level 0 arrived, so the page's numbers and
    // the samples' are the same here - where the coarse level the open held was half of them.
    await drawn();
    const last = decoder.frames.at(-1);
    expect(last?.region.x).toBeCloseTo(QUARTER.x, 0);
    expect(last?.region.width).toBeCloseTo(QUARTER.width, 0);
  });

  test('the open draws the coarse level at the coarse level, not at the picture', async () => {
    // Before any window arrives: the page says the picture is 8000 across and the samples are
    // 4000, so a region naming the whole picture has to reach the module as the whole *level*.
    // Handed the page's own numbers, the draw would index twice the buffer it holds.
    presenter.settleExposure(0.5);
    await drawn();
    const last = decoder.frames.at(-1);
    expect(last?.region.width).toBeCloseTo(PAN_ROW.width / 2, 0);
  });

  test('a level change is one window and the pan after it is tiles', async () => {
    // Zoomed out to the whole picture, which the level in hand over-resolves, then back in. The
    // level fetch is a region-and-stage ask because only the server knows which level that is;
    // everything after it is the module naming rectangles of the level it now holds.
    presenter.showRegion({ x: 0, y: 0, width: PAN_ROW.width, height: PAN_ROW.height });
    await settled();
    presenter.showRegion(QUARTER);
    await settled();

    const regions = asked.filter((url) => url.searchParams.get('region') != null);
    const tiles = asked.filter((url) => url.searchParams.get('at') != null);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.length + tiles.length).toBe(asked.length);
  });

  test('the part asked for is what the module answered, not a fraction of the output', async () => {
    // **What the geometry does between the two spaces.** A region is in output pixels and a window
    // is cut from the picture, so under a crop a fraction of one is not a fraction of the other -
    // and a panorama framed off-centre by its own align has exactly that crop from the moment it
    // is merged. The module is what maps them, so what the page must do is ask and send the answer
    // through unchanged.
    decoder.picturePart = () => Promise.resolve([0.6, 0.1, 0.08, 0.09]);
    presenter.showRegion(QUARTER);
    await settled();

    expect(asked.length).toBe(1);
    expect(asked[0]?.searchParams.get('region')?.split(',').map(Number)).toEqual([
      0.6, 0.1, 0.08, 0.09,
    ]);
  });

  test('a pass the reader has moved past asks for nothing when it wakes', async () => {
    // **The one race this flow has.** A pass waits on the module and then on the server, and a
    // reader who zooms, waits and zooms again has two of them alive over those waits. Whichever
    // resolves last is the window that would be drawn, so the older pass has to find that its turn
    // is over rather than fetch and hand over a picture of where the reader used to be.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mapping = decoder.picturePart;
    let mapped = 0;
    decoder.picturePart = async (region): Promise<[number, number, number, number]> => {
      mapped += 1;
      if (mapped === 1) await held;
      return mapping(region);
    };

    presenter.showRegion(QUARTER);
    await settled();
    expect(asked.length, 'the first pass got past the module').toBe(0);

    presenter.showRegion({ ...QUARTER, x: QUARTER.x + 900 });
    await settled();
    expect(asked.length).toBe(1);

    release!();
    await settled();
    expect(asked.length, 'the superseded pass fetched its own window as well').toBe(1);
  });

  test('a tab that opened the RAW itself never asks', async () => {
    stage.preparedElsewhere = false;
    presenter.showRegion({ x: 2000, y: 1500, width: 1000, height: 750 });
    await settled();
    // Every zoom is already answered from the whole photograph this side holds.
    expect(asked.length).toBe(0);
  });
});

describe('leaving the editor', () => {
  let finished: string[] = [];
  let finishedFrom: (Pick<EditCheckpoint, 'doc' | 'stamp'> | undefined)[] = [];
  let restored: { rev: number; checkpoint: EditCheckpoint }[] = [];
  const saveEdits = photoEditsApi.save;
  const restoreEdits = photoEditsApi.restore;
  const finishEdits = photoEditsApi.finish;
  const history = [{ from: { contrast: 0 }, to: { contrast: 20 } }];

  beforeEach(() => {
    finished = [];
    finishedFrom = [];
    restored = [];
    photoEditsApi.save = (_photoId, doc): Promise<EditState> =>
      Promise.resolve({ doc, rev: ++edit.rev, canUndo: true, canRedo: false });
    photoEditsApi.restore = (_photoId, rev, checkpoint): Promise<EditState> => {
      restored.push({ rev, checkpoint });
      return Promise.resolve({ doc: checkpoint.doc, rev: rev + 1, canUndo: true, canRedo: false });
    };
    photoEditsApi.finish = (photoId, opened): Promise<void> => {
      finished.push(photoId);
      finishedFrom.push(opened);
      return Promise.resolve();
    };
    edit.rev = 1;
    Object.assign(presenter, { photoId: 'a-photo-id' });
    presenter.edit.opened({
      doc: edit.doc ?? neutralEdits(),
      rev: 1,
      canUndo: true,
      canRedo: false,
      cursor: 1,
      history,
      stamp: 'opened-stamp',
    });
    Object.assign(presenter.edit, { photoId: 'a-photo-id' });
  });

  afterEach(() => {
    photoEditsApi.save = saveEdits;
    photoEditsApi.restore = restoreEdits;
    photoEditsApi.finish = finishEdits;
  });

  test('asks for the render the reader ended up with', async () => {
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    presenter.close();
    await Bun.sleep(0);
    expect(finished).toEqual(['a-photo-id']);
  });

  test('asks for nothing when nothing was written', async () => {
    presenter.previewExposure(1.25);

    presenter.close();
    await Bun.sleep(0);
    expect(finished).toEqual([]);
  });

  // The server compares, and vouches for the copies on disk where the document came home.
  test('hands the close what the editor opened on', async () => {
    const openedDoc = edit.doc;
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    presenter.close();
    await Bun.sleep(0);
    expect(finishedFrom).toEqual([expect.objectContaining({ doc: openedDoc, stamp: 'opened-stamp' })]);
  });

  test('a close waits for the save released on the way out', async () => {
    let land!: () => void;
    photoEditsApi.save = (_photoId, doc): Promise<EditState> =>
      new Promise((resolve) => {
        land = () => resolve({ doc, rev: 2, canUndo: true, canRedo: false });
      });
    presenter.settleExposure(1.25);

    presenter.close();
    await Bun.sleep(0);
    expect(finished).toEqual([]);

    land();
    await Bun.sleep(0);
    expect(finished).toEqual(['a-photo-id']);
  });

  test('a close right after a cancel asks only once the cancel has landed', async () => {
    let land!: () => void;
    photoEditsApi.restore = (_photoId, rev, checkpoint): Promise<EditState> =>
      new Promise((resolve) => {
        land = () => resolve({ doc: checkpoint.doc, rev: rev + 1, canUndo: true, canRedo: false });
      });
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    const cancelled = presenter.cancel();
    await Bun.sleep(0);
    presenter.close();
    await Bun.sleep(0);
    expect(finished).toEqual([]);

    land();
    await cancelled;
    await Bun.sleep(0);
    expect(finished).toEqual(['a-photo-id']);
  });

  test('a cancel puts back the document and history it opened on', async () => {
    const openedDoc = edit.doc;
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    expect(await presenter.cancel()).toBe(true);
    expect(restored).toEqual([{ rev: 2, checkpoint: expect.objectContaining({ doc: openedDoc, cursor: 1, history }) }]);
    expect(edit.doc?.exposure).toBe(openedDoc?.exposure);

    presenter.close();
    await Bun.sleep(0);
    expect(finishedFrom).toEqual([expect.objectContaining({ doc: openedDoc, stamp: 'opened-stamp' })]);
  });

  test('a cancel waits for the save in flight, and drops the one queued behind it', async () => {
    let land!: () => void;
    const saved: number[] = [];
    photoEditsApi.save = (_photoId, doc): Promise<EditState> => {
      saved.push(doc.exposure);
      return new Promise((resolve) => {
        land = () => resolve({ doc, rev: ++edit.rev, canUndo: true, canRedo: false });
      });
    };
    presenter.settleExposure(1.25);
    presenter.settleExposure(2);

    const cancelled = presenter.cancel();
    land();
    expect(await cancelled).toBe(true);
    expect(saved).toEqual([1.25]);
    expect(restored.map(({ rev }) => rev)).toEqual([2]);
  });

  test('a cancel with nothing written writes nothing', async () => {
    presenter.previewExposure(1.25);

    expect(await presenter.cancel()).toBe(true);
    expect(restored).toEqual([]);
  });

  test('a cancel the server refuses keeps the editor open', async () => {
    photoEditsApi.restore = (): Promise<EditState> => Promise.reject(new Error('offline'));
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    expect(await presenter.cancel()).toBe(false);
    expect(edit.saveStatus).toBe('failed');
  });

  test('a cancel refused because the edits moved elsewhere reports a conflict', async () => {
    photoEditsApi.restore = (): Promise<EditState> =>
      Promise.reject(new ApiError('CONFLICT', 'these edits have moved on', 409));
    presenter.settleExposure(1.25);
    await Bun.sleep(0);

    expect(await presenter.cancel()).toBe(false);
    expect(edit.saveStatus).toBe('conflict');
  });
});
