// The editor's actions, against a store and a pipeline that only record what they were told.
//
// This is the seam the architecture exists for: every mutation is on the presenter, so what a
// button does is answerable without a GPU, a server or a browser. What used to answer these
// questions was an end-to-end run that opened a real RAW - which could only say that *something*
// changed, and said it slowly.
import { beforeEach, describe, expect, test } from 'bun:test';
import { RawEditPresenter } from '../raw_edit_presenter';
import { RawEditStore } from '../raw_edit_store';
import type { Region } from '../gpu/edit_pipeline';
import { neutralEdits } from '../../../../../src/schemas/photo_edits';
import {
  EDIT_UNIFORM_FLOATS,
  editOffsets,
  edits,
  wholeFrameGeometry,
  type EditAdjust,
  type EditGeometry,
} from '../gpu/shaders';

const AT_REST = {
  region: { x: 0, y: 0, width: 4000, height: 3000 },
  canvas: { width: 1000, height: 750 },
  maxLod: 0,
};

/**
 * What the presenter asks of the pipeline, and nothing else.
 *
 * **It keeps what it was told and can produce the uniform from it**, which is the point: the
 * question "does moving this slider change the picture" is answerable without a GPU, because
 * the frame the GPU would draw is a pure function of these values (`edits`). A device would
 * only tell us the same number again, more slowly.
 */
class Pipeline {
  geometry: EditGeometry = wholeFrameGeometry(4000, 3000);
  adjust: EditAdjust = {
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    saturation: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    temperature: null,
    tint: null,
  };
  exposure = 0;
  draws = 0;
  readonly wholeFrame = { x: 0, y: 0, width: 4000, height: 3000 };

  /**
   * The Detail pair, and how many times the chain behind it was asked to run.
   *
   * The count is the interesting half: the denoise is eight passes over the frame rather
   * than a uniform word, so a control that re-ran it per tick would be a control that made
   * the editor unusable while any *other* slider moved.
   */
  denoise: { luminance: number; colour: number } | null = null;
  denoises = 0;

  setGeometry(next: EditGeometry): void {
    this.geometry = next;
  }

  setAdjust(next: Partial<EditAdjust>): void {
    this.adjust = { ...this.adjust, ...next };
  }

  setDenoise(next: { luminance: number; colour: number }): void {
    if (this.denoise?.luminance === next.luminance && this.denoise.colour === next.colour) {
      return;
    }
    this.denoise = next;
    this.denoises++;
  }

  /**
   * Every frame asked for: the window it read, the picture that window is on, and the canvas
   * it landed on. Which is the whole of a draw, geometrically.
   */
  readonly frames: {
    region: Region;
    output: { width: number; height: number };
    stage: { width: number; height: number };
  }[] = [];

  render(exposure: number, region: Region): void {
    this.exposure = exposure;
    this.draws += 1;
    this.frames.push({ region, output: this.geometry.output, stage: { ...canvas } });
  }

  /** What the loupe was last asked to magnify, and how many times it was asked. */
  loupeRegion: Region | null = null;
  loupeDraws = 0;

  renderLoupe(_exposure: number, region: Region): void {
    this.loupeRegion = region;
    this.loupeDraws += 1;
  }

  attachLoupe(): void {
    /* the canvas is the component's, and nothing here has one */
  }

  /** The words the shader would be handed for the last frame asked for. */
  uniform(): { floats: Float32Array; ints: Uint32Array; at: ReturnType<typeof editOffsets>['at'] } {
    const words = edits(
      Array.from<number>({ length: EDIT_UNIFORM_FLOATS }).fill(0),
      this.adjust,
      this.exposure,
      AT_REST,
      this.geometry,
    );
    return { floats: words, ints: new Uint32Array(words.buffer), at: editOffsets().at };
  }
}

let store: RawEditStore;
let presenter: RawEditPresenter;
let pipeline: Pipeline;
/** The backing store, which is the only part of the canvas the presenter writes. */
let canvas: { width: number; height: number };

/** The frames asked for and not yet run. Drained by `drawn()`, which is the display's job. */
let frames: FrameRequestCallback[] = [];

/**
 * Runs the frames the presenter asked for, and answers how many draws they made.
 *
 * Queued rather than run where they are asked for: the presenter coalesces onto *one*
 * outstanding frame, so a callback that runs inside `requestAnimationFrame` itself leaves the
 * handle set forever and every later request is dropped as already pending.
 */
function drawn(): number {
  const due = frames;
  frames = [];
  for (const frame of due) frame(0);
  return pipeline.draws;
}

beforeEach(() => {
  frames = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;

  store = new RawEditStore();
  store.doc = neutralEdits();
  store.width = 4000;
  store.height = 3000;
  store.status = 'live';
  presenter = new RawEditPresenter(store);
  pipeline = new Pipeline();
  canvas = { width: 300, height: 150 };
  // The presenter builds all of this when a photo opens, which needs a device and a mounted
  // element; from its point of view these are the same objects. The box is the stage's CSS
  // size, which the resize observer would have reported.
  Object.assign(presenter, {
    pipeline,
    canvas,
    device: { limits: { maxTextureDimension2D: 8192 } },
    box: { width: 1000, height: 750 },
    // What the open sees the picture's shape as. Without it the first edit reads a shape that
    // has "changed" from nothing and throws the reader's zoom away.
    shown: { width: 4000, height: 3000 },
  });
});

/** Two lines down edges that lean towards each other, as a building shot from below has. */
const LEANING = [
  { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
  { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
];

describe('the perspective tool', () => {
  test('turns the lines the reader drew into a correction on the document', () => {
    presenter.setGuides(LEANING, true);

    expect(store.doc?.keystoneGuides).toEqual(LEANING);
    expect(store.doc?.keystone).not.toBeNull();
    expect(store.keystoned).toBe(true);
  });

  test('holds the guides without a correction where they ask for nothing', () => {
    // Already parallel: there is nothing to correct, and the guides stay so the reader can
    // move one rather than start again.
    const parallel = [
      { x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.9 },
      { x1: 0.7, y1: 0.1, x2: 0.7, y2: 0.9 },
    ];
    presenter.setGuides(parallel, true);

    expect(store.doc?.keystoneGuides).toEqual(parallel);
    expect(store.doc?.keystone).toBeNull();
  });

  test('keeps the guides in the frame own fractions, whatever the turn', () => {
    presenter.turn(90);
    presenter.setGuides(LEANING, true);

    // What the overlay is handed back is what it drew, at the same place on screen; what the
    // document holds is the turn taken back off.
    expect(store.guides[0]?.x1).toBeCloseTo(LEANING[0]!.x1, 10);
    expect(store.guides[0]?.y1).toBeCloseTo(LEANING[0]!.y1, 10);
    expect(store.doc?.keystoneGuides[0]?.x1).not.toBeCloseTo(LEANING[0]!.x1, 3);
  });

  test('shows the frame uncorrected while the tool is open, and corrected when it closes', () => {
    presenter.setGuides(LEANING, true);

    presenter.setKeystoning(true);
    expect(pipeline.geometry?.keystone).toBeNull();

    presenter.setKeystoning(false);
    expect(pipeline.geometry?.keystone).toEqual(store.doc!.keystone!);
  });

  // The bug this test exists for: closing the tool pushed the new geometry and never asked for
  // a frame. A crop hides that - the picture changes shape and the stage refits - and a
  // correction does not, so the corrected photograph simply never appeared.
  test('draws the picture again when a tool opens or closes', () => {
    presenter.setGuides(LEANING, true);
    const before = drawn();

    presenter.setKeystoning(true);
    const opened = drawn();
    expect(opened).toBeGreaterThan(before);

    presenter.setKeystoning(false);
    const closed = drawn();
    expect(closed).toBeGreaterThan(opened);

    presenter.setCropping(true);
    expect(drawn()).toBeGreaterThan(closed);
  });

  test('clearing takes the correction and the guides together', () => {
    presenter.setGuides(LEANING, true);
    presenter.clearKeystone();

    expect(store.doc?.keystone).toBeNull();
    expect(store.doc?.keystoneGuides).toEqual([]);
    expect(store.keystoned).toBe(false);
  });
});

/**
 * Every slider, from the presenter's method to the word the shader reads.
 *
 * **This is what a Playwright run was for**, and it could say less: it moved a control, watched
 * the canvas change, and left the value unexamined. A tick's uniform is a pure function of the
 * document, so the number is checkable here - and a transposed pair, a scale applied twice or a
 * slider wired to its neighbour is a *wrong number*, not a canvas that failed to change.
 */
describe('a slider reaching the picture', () => {
  test('carries the exposure in stops, and asks for a frame', () => {
    const before = drawn();

    presenter.settleExposure(1.25);
    expect(drawn()).toBeGreaterThan(before);

    const { floats, at } = pipeline.uniform();
    // Stops rather than a gain: `colour.wgsl` is what raises it, so a host that converted here
    // would be applying the exposure twice.
    expect(floats[at.exposure]).toBeCloseTo(1.25, 6);
  });

  test('puts each tone and presence slider in its own slot', () => {
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
    drawn();

    const { floats, at } = pipeline.uniform();
    expect(floats[at.contrast]).toBe(11);
    expect(floats[at.highlights]).toBe(-22);
    expect(floats[at.shadows]).toBe(33);
    expect(floats[at.whites]).toBe(-44);
    expect(floats[at.blacks]).toBe(55);
    expect(floats[at.texture_adjust]).toBe(-66);
    expect(floats[at.clarity]).toBe(77);
    expect(floats[at.dehaze]).toBeCloseTo(-88.5, 4);
    expect(floats[at.vibrance]).toBe(99);
    expect(floats[at.sat_adjust]).toBe(-12);
  });

  test('leaves the white balance as the frame own until the reader moves it', () => {
    store.asShot = { temperature: 5487.3, tint: 11.4 };

    drawn();
    // Nothing set, so the shader is told to use the illuminant the camera recorded.
    expect(pipeline.uniform().ints[editOffsets().at.balance_set]).toBe(0);

    presenter.settleBalance({ temperature: 6000 });
    drawn();

    const { floats, ints, at } = pipeline.uniform();
    // Both halves, because half a white balance reads as a colour cast.
    expect(ints[at.balance_set]).toBe(3);
    expect(floats[at.temperature]).toBe(6000);
    expect(floats[at.tint]).toBe(11);
  });

  test('sends the Detail pair to the denoise, and only when one of them moves', () => {
    presenter.preview({ luminanceNoise: 60, colourNoise: 20 });
    expect(pipeline.denoise).toEqual({ luminance: 60, colour: 20 });

    // Every other slider goes through the same `preview`, so the guard against re-running
    // thirteen whole-frame passes has to be the *value*, not the call.
    const ran = pipeline.denoises;
    presenter.preview({ exposure: 1.2 });
    presenter.preview({ contrast: 40 });
    presenter.settleStraighten(3);
    expect(pipeline.denoises).toBe(ran);

    presenter.preview({ colourNoise: 21 });
    expect(pipeline.denoises).toBe(ran + 1);
    expect(pipeline.denoise).toEqual({ luminance: 60, colour: 21 });
  });

  test('sends the geometry the reader chose, not the one the tool is showing', () => {
    presenter.settleStraighten(6);
    presenter.settleCrop({ left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 });
    drawn();

    const { floats, ints, at } = pipeline.uniform();
    expect(floats[at.crop_left]).toBeCloseTo(0.2, 6);
    expect(floats[at.crop_bottom]).toBeCloseTo(0.9, 6);
    expect(floats[at.crop_angle]).toBeCloseTo(6, 6);
    expect(ints[at.output_width]).toBe(store.output.width);
    expect(ints[at.output_height]).toBe(store.output.height);
  });

  test('sends the perspective correction the guides produced', () => {
    presenter.setGuides(
      [
        { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
        { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
      ],
      true,
    );
    drawn();

    const { floats, ints, at } = pipeline.uniform();
    expect(ints[at.has_keystone]).toBe(1);
    for (const [element, value] of store.doc!.keystone!.entries()) {
      expect(floats[at.keystone_0 + element]).toBeCloseTo(value, 5);
    }
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
 * new one, it stretches it. Both used to be fixed from a React effect that runs *after* the
 * paint, so a drag alternated between the photograph and a distorted copy of it for as long as
 * it lasted.
 */
describe('the window each frame is drawn at', () => {
  test('never reads a window bigger than the picture it is on', () => {
    for (const angle of [1, 2, 3, 4, 5, 6, 7, 8]) {
      presenter.previewStraighten(angle);
      drawn();
    }

    expect(pipeline.frames.length).toBeGreaterThan(4);
    for (const { region, output } of pipeline.frames) {
      expect(region.width, `${region.width} of ${output.width}`).toBeLessThanOrEqual(output.width);
      expect(region.height, `${region.height} of ${output.height}`).toBeLessThanOrEqual(output.height);
    }
  });

  test('lands on a canvas of its own shape, on every frame of a drag', () => {
    const shapes: string[] = [];
    for (const angle of [0.5, 1, 2, 3, 4, 5, 6, 7]) {
      presenter.previewStraighten(angle);
      drawn();
      shapes.push(`${canvas.width}x${canvas.height}`);
    }

    // The stage really is following the picture, or the check below passes on a canvas that
    // never moved.
    expect(new Set(shapes).size).toBeGreaterThan(4);
    for (const { region, stage } of pipeline.frames) {
      expect(stage.width / stage.height, `${stage.width}x${stage.height} for ${region.width}x${region.height}`).toBeCloseTo(
        region.width / region.height,
        2,
      );
    }
  });

  test('lands on a canvas of its own shape when the zoom moves too', () => {
    presenter.showRegion({ x: 100, y: 100, width: 1200, height: 675 });
    drawn();

    const last = pipeline.frames.at(-1)!;
    expect(last.stage.width / last.stage.height).toBeCloseTo(1200 / 675, 2);
  });

  test('follows a shape that changed, and leaves a zoom that did not alone', () => {
    presenter.showRegion({ x: 100, y: 100, width: 1000, height: 750 });
    drawn();

    // A slider that leaves the picture the size it was must not throw the reader's zoom away.
    presenter.previewExposure(1);
    drawn();
    expect(store.region).toEqual({ x: 100, y: 100, width: 1000, height: 750 });

    // One that changes the shape has to, or the window is measured against a picture that is
    // no longer there.
    presenter.previewStraighten(6);
    drawn();
    expect(store.region).toEqual({ x: 0, y: 0, ...store.output });
  });
});

// The shape the stage is laid out on, which is `displaySize` - the server's own function - read
// through the store. It was a Playwright test that opened a RAW and compared the canvas's
// backing store, for a claim that is three numbers.
describe('the shape the picture takes', () => {
  test('is the frame until something changes it', () => {
    expect(store.output).toEqual({ width: 4000, height: 3000 });
  });

  test('inverts under a quarter turn, and comes back', () => {
    presenter.turn(90);
    expect(store.output).toEqual({ width: 3000, height: 4000 });
    expect(pipeline.geometry?.rotate).toBe(90);

    presenter.turn(-90);
    expect(store.output).toEqual({ width: 4000, height: 3000 });
  });

  test('follows the crop, and the crop is of the straightened frame', () => {
    presenter.settleCrop({ left: 0.25, top: 0, right: 0.75, bottom: 1 });
    expect(store.output.width).toBe(2000);
    expect(store.output.height).toBe(3000);
  });

  test('grows with a straighten, because the frame does', () => {
    presenter.settleStraighten(45);
    // A 45-degree straighten on 4000x3000 needs a box of 4950 either way, which is the frame
    // the crop tool shows - the picture left over is the largest rectangle inside it, the
    // straighten having cropped to fit as it moved.
    presenter.setCropping(true);
    expect(store.output).toEqual({ width: 4950, height: 4950 });

    presenter.setCropping(false);
    expect(store.output.width).toBeLessThan(4950);
    expect(store.output.width).toBeGreaterThan(0);
  });

  test('shows the whole frame while the crop tool is open, cropped when it closes', () => {
    presenter.settleCrop({ left: 0.25, top: 0, right: 0.75, bottom: 1 });

    presenter.setCropping(true);
    expect(store.output).toEqual({ width: 4000, height: 3000 });
    expect(pipeline.geometry?.cropLeft).toBe(0);

    presenter.setCropping(false);
    expect(store.output.width).toBe(2000);
    expect(pipeline.geometry?.cropLeft).toBe(0.25);
  });
});

// The header's selector, which is the two modes and the absence of both. One at a time is the
// rule it exists to make visible: each tool shows the frame with different things taken off it,
// so an overlay laid out under one is naming a different picture from the one under the other.
describe('the tool the pointer is in', () => {
  test('is whichever the selector names, and only ever one', () => {
    expect(store.tool).toBe('cursor');

    presenter.setTool('crop');
    expect(store.tool).toBe('crop');
    expect(store.keystoning).toBe(false);

    presenter.setTool('perspective');
    expect(store.tool).toBe('perspective');
    expect(store.cropping).toBe(false);

    presenter.setTool('cursor');
    expect(store.cropping).toBe(false);
    expect(store.keystoning).toBe(false);
  });
});

// The one pair whose slider position is not what the document holds. What a browser has to say
// about it is only that the frame's illuminant crossed from the server; the rules below are
// arithmetic over that number and a nullable pair.
describe('the white balance pair', () => {
  beforeEach(() => {
    store.asShot = { temperature: 5487.3, tint: 11.4 };
  });

  test('sits at the frame own illuminant until the reader moves it', () => {
    expect(store.doc?.temperature).toBeNull();
    // Rounded for the panel, because a solved illuminant arrives at 5487.3K.
    expect(store.balance).toEqual({ temperature: 5487, tint: 11 });
  });

  test('stores both halves the moment either one moves', () => {
    presenter.settleBalance({ temperature: 6000 });

    // A temperature beside a null tint is not a white balance, it is half of one - and the
    // half that is missing reads as a colour cast.
    expect(store.doc?.temperature).toBe(6000);
    expect(store.doc?.tint).toBe(11);
  });

  test('has no pair at all where the camera recorded no neutral', () => {
    store.asShot = null;
    expect(store.balance).toBeNull();
  });
});

describe('cropping to what the geometry left', () => {
  test('leaves a frame with nothing to trim whole', () => {
    presenter.settleStraighten(0);

    expect(store.doc?.cropLeft).toBe(0);
    expect(store.doc?.cropRight).toBe(1);
  });

  test('insets the crop after a straighten', () => {
    presenter.settleStraighten(6);

    const doc = store.doc!;
    expect(doc.cropLeft).toBeGreaterThan(0);
    expect(doc.cropTop).toBeGreaterThan(0);
    expect(doc.cropRight).toBeLessThan(1);
    expect(doc.cropBottom).toBeLessThan(1);
  });

  // The toggle is the whole of whether any of this happens. Off, the reader owns the rectangle.
  test('leaves the crop alone entirely when the habit is off', () => {
    presenter.setCropToFit(false);
    presenter.settleStraighten(6);

    expect(store.doc?.cropAngle).toBe(6);
    expect(store.doc?.cropLeft).toBe(0);
    expect(store.doc?.cropRight).toBe(1);

    // And turning it back on catches the crop up, rather than waiting for the next move.
    presenter.setCropToFit(true);
    expect(store.doc?.cropLeft).toBeGreaterThan(0);
  });

  // Nobody straightens a horizon in order to look at the wedges of blank it leaves, so the
  // slider takes the crop with it - and gives the whole frame back on the way to zero.
  test('crops to fit as the straighten moves, and hands the frame back at zero', () => {
    presenter.settleStraighten(6);
    expect(store.doc?.cropLeft).toBeGreaterThan(0);
    expect(store.doc?.cropRight).toBeLessThan(1);

    presenter.settleStraighten(0);
    expect(store.doc?.cropLeft).toBe(0);
    expect(store.doc?.cropTop).toBe(0);
    expect(store.doc?.cropRight).toBe(1);
    expect(store.doc?.cropBottom).toBe(1);
  });

  // The one place it must not: a rectangle being chosen by hand cannot be replaced under the
  // hand choosing it.
  test('leaves the rectangle alone while the crop tool is open', () => {
    presenter.setCropping(true);
    presenter.settleCrop({ left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 });
    presenter.settleStraighten(6);

    expect(store.doc?.cropAngle).toBe(6);
    expect(store.doc?.cropLeft).toBe(0.2);
    expect(store.doc?.cropRight).toBe(0.8);
  });

  test('insets the crop after a correction', () => {
    presenter.setGuides(LEANING, true);

    const doc = store.doc!;
    expect((doc.cropRight - doc.cropLeft) * (doc.cropBottom - doc.cropTop)).toBeLessThan(1);
    expect((doc.cropRight - doc.cropLeft) * (doc.cropBottom - doc.cropTop)).toBeGreaterThan(0.3);
  });
});

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
  function fitted(): void {
    presenter.showRegion({ x: 0, y: 0, width: 4000, height: 3000 });
    drawn();
  }

  test('magnifies the point under the pointer, not the middle of the picture', () => {
    fitted();
    presenter.setLoupe(true);
    // A quarter across and a quarter down the stage is a quarter into the region.
    presenter.moveLoupe({ x: 250, y: 187.5 }, BOX);

    const region = pipeline.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(1000, 0);
    expect(region.y + region.height / 2).toBeCloseTo(750, 0);
  });

  test('shows a square of source pixels the magnification decides', () => {
    fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);

    // 400 screen pixels at 2x is 200 of the photograph's own, and the box is square whatever
    // shape the stage is.
    const region = pipeline.loupeRegion!;
    expect(region.width).toBeCloseTo(200, 5);
    expect(region.height).toBeCloseTo(200, 5);
  });

  test('a wheel notch narrows the window, and the ends hold', () => {
    fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    const before = pipeline.loupeRegion!.width;

    // Away from the reader is more magnification, which is fewer source pixels.
    presenter.zoomLoupe(-1, BOX);
    expect(pipeline.loupeRegion!.width).toBeLessThan(before);

    for (let notch = 0; notch < 40; notch++) presenter.zoomLoupe(-1, BOX);
    expect(store.loupeMagnification).toBe(16);
    for (let notch = 0; notch < 80; notch++) presenter.zoomLoupe(1, BOX);
    expect(store.loupeMagnification).toBe(1);
  });

  test('magnifies what the reader is already zoomed into', () => {
    // Half the picture on the stage, so one stage pixel is half a source pixel - and the loupe
    // still answers in the photograph's own pixels rather than the view's.
    presenter.showRegion({ x: 1000, y: 750, width: 2000, height: 1500 });
    drawn();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);

    const region = pipeline.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(2000, 0);
    expect(region.y + region.height / 2).toBeCloseTo(1500, 0);
    expect(region.width).toBeCloseTo(200, 5);
  });

  test('draws nothing once the pointer has left, and forgets where it was on close', () => {
    fitted();
    presenter.setLoupe(true);
    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    const drew = pipeline.loupeDraws;

    presenter.moveLoupe(null, BOX);
    expect(pipeline.loupeDraws).toBe(drew);
    expect(store.loupeAt).toBeNull();

    presenter.moveLoupe({ x: 500, y: 375 }, BOX);
    presenter.setLoupe(false);
    expect(store.loupeAt).toBeNull();
  });

  test('parks against the edge rather than magnifying past it', () => {
    fitted();
    presenter.setLoupe(true);
    // A drag that ran off the corner: the glass stops on the picture, which is all there is to
    // magnify.
    presenter.moveLoupe({ x: -300, y: 2000 }, BOX);

    expect(store.loupeAt).toEqual({ x: 0, y: 750 });
    const region = pipeline.loupeRegion!;
    expect(region.x + region.width / 2).toBeCloseTo(0, 0);
    expect(region.y + region.height / 2).toBeCloseTo(3000, 0);
  });

  test('is one tool among the others, so opening it puts the geometry tools away', () => {
    presenter.setTool('crop');
    expect(store.tool).toBe('crop');

    presenter.setTool('loupe');
    expect(store.tool).toBe('loupe');
    expect(store.cropping).toBe(false);
    expect(store.keystoning).toBe(false);
  });
});
