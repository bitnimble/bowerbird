import { beforeEach, describe, expect, test } from 'bun:test';
import { KeystoneStore } from '../../keystone/keystone_store';
import { EditStore } from '../../edit/edit_store';
import { LoupeStore } from '../../loupe/loupe_store';
import { RepairStore } from '../../repair/repair_store';
import { PrintStore } from '../../print/print_store';
import { RawEditPresenter } from '../../stage/raw_edit_presenter';
import { StageStore } from '../../stage/stage_store';
import { drawnBy, FakeDecoder, openEditor, type Editor } from '../../stage/tests/raw_edit_harness';
import { CropStore } from '../crop_store';

let editor: Editor;
let stage: StageStore;
let edit: EditStore;
let crop: CropStore;
let keystone: KeystoneStore;
let presenter: RawEditPresenter;

beforeEach(() => {
  editor = openEditor();
  ({ edit, stage, crop, keystone, presenter } = editor);
});

const drawn = (): Promise<number> => drawnBy(editor);

/**
 * The ratio picker, which is a rectangle written to the document rather than dragged into shape.
 *
 * The document is where the claim is: a pick that only moved the overlay would look right on
 * screen and save nothing, and a pick read back through the picture's own shape is what says the
 * ratio is the one on screen rather than one in the frame's fractions.
 */
const LEANING = [
  { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
  { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
];

describe('a crop picked by its ratio', () => {
  test('writes a rectangle that is square on the picture, not in its fractions', () => {
    presenter.setCropping(true);
    presenter.setCropAspect('1:1');

    const doc = edit.doc!;
    // 4000x3000, so a square crop is three quarters of the width and the whole of the height.
    expect(doc.cropRight - doc.cropLeft).toBeCloseTo(0.75, 10);
    expect(doc.cropBottom - doc.cropTop).toBeCloseTo(1, 10);
    expect(crop.cropAspect).toBe('1:1');
  });

  test('is of the straightened frame, which is a different shape again', () => {
    // The habit off, so the rectangle the pick starts from is the frame rather than the fit a
    // straighten leaves inside it.
    presenter.setCropToFit(false);
    presenter.settleStraighten(45);
    presenter.setCropping(true);
    presenter.setCropAspect('16:9');

    // The straighten grew the frame to a 4950 square, so 16:9 out of it is a band across it.
    expect(crop.cropFrame).toEqual({ width: 4950, height: 4950 });
    const doc = edit.doc!;
    expect(doc.cropRight - doc.cropLeft).toBeCloseTo(1, 10);
    expect(doc.cropBottom - doc.cropTop).toBeCloseTo(9 / 16, 10);
    expect(crop.cropAspect).toBe('16:9');
  });

  test('follows the quarter turn, so the ratio is the one on screen', () => {
    presenter.turn(90);
    presenter.setCropping(true);
    presenter.setCropAspect('original');

    // Turned, the picture is 3000x4000 and its own shape is the whole of it.
    expect(keystone.output).toEqual({ width: 3000, height: 4000 });
    expect(edit.doc?.cropLeft).toBeCloseTo(0, 10);
    expect(edit.doc?.cropRight).toBeCloseTo(1, 10);
    expect(crop.cropAspect).toBe('original');
  });

  // Nothing to pick, so nothing to write: the picker shows what the rectangle is, and "Custom"
  // is one of the things it can be.
  test('leaves the rectangle alone when custom is chosen', () => {
    presenter.setCropping(true);
    presenter.settleCrop({ left: 0, top: 0, right: 0.9, bottom: 0.31 });
    presenter.setCropAspect('custom');

    expect(edit.doc?.cropRight).toBe(0.9);
    expect(edit.doc?.cropBottom).toBe(0.31);
  });
});

describe('a crop dragged', () => {
  const SE = { x: 'right', y: 'bottom' } as const;

  test('keeps the ratio the picker holds', () => {
    presenter.setCropping(true);
    presenter.setCropAspect('1:1');
    presenter.dragCrop(crop.cropRect!, SE, { x: -0.1, y: 0 }, true);

    const doc = edit.doc!;
    expect(doc.cropLeft).toBeCloseTo(0.125, 10);
    expect(doc.cropTop).toBeCloseTo(0, 10);
    expect(doc.cropRight).toBeCloseTo(0.825, 10);
    expect(doc.cropBottom).toBeCloseTo(2800 / 3000, 10);
    expect(crop.cropAspect).toBe('1:1');
  });

  test('is free until a ratio is picked, and through a shape that is on the list', () => {
    presenter.setCropping(true);
    expect(crop.cropAspect).toBe('custom');
    // 3000 by 3000, which is 1:1.
    presenter.dragCrop(crop.cropRect!, SE, { x: -0.25, y: 0 }, true);
    expect(crop.cropAspect).toBe('custom');

    presenter.dragCrop(crop.cropRect!, SE, { x: 0, y: -0.5 }, true);
    expect(edit.doc?.cropRight).toBeCloseTo(0.75, 10);
    expect(edit.doc?.cropBottom).toBeCloseTo(0.5, 10);
  });

  test('is free again once custom is picked', () => {
    presenter.setCropping(true);
    presenter.setCropAspect('1:1');
    presenter.setCropAspect('custom');
    presenter.dragCrop(crop.cropRect!, SE, { x: 0, y: -0.5 }, true);

    expect(edit.doc?.cropRight).toBeCloseTo(0.875, 10);
    expect(edit.doc?.cropBottom).toBeCloseTo(0.5, 10);
    expect(crop.cropAspect).toBe('custom');
  });

  test('turns portrait past the diagonal, and the picker follows', () => {
    presenter.setCropping(true);
    presenter.setCropAspect('3:2');
    // 4000 by 2666, and the pointer taken below the square it would need to stay wide.
    presenter.dragCrop(crop.cropRect!, SE, { x: -0.5, y: 0.5 }, true);

    expect(crop.cropAspect).toBe('2:3');
  });

  test('holds a turned original, which the list has no name for', () => {
    stage.width = 4000;
    stage.height = 2000;
    presenter.setCropping(true);
    presenter.setCropAspect('original');
    presenter.dragCrop(crop.cropRect!, SE, { x: -0.8, y: 0 }, true);

    const doc = edit.doc!;
    // 1:2, the frame's own 2:1 turned.
    expect((doc.cropRight - doc.cropLeft) * 4000).toBeCloseTo(960, 6);
    expect((doc.cropBottom - doc.cropTop) * 2000).toBeCloseTo(1920, 6);
    expect(crop.cropAspect).toBe('original');
  });

  test('draws nothing while it moves, the stage showing the frame uncropped', async () => {
    presenter.setCropping(true);
    const before = await drawn();

    presenter.dragCrop(crop.cropRect!, SE, { x: -0.1, y: -0.1 }, false);
    expect(await drawn()).toBe(before);
  });
});

describe('cropping to what the geometry left', () => {
  test('leaves a frame with nothing to trim whole', () => {
    presenter.settleStraighten(0);

    expect(edit.doc?.cropLeft).toBe(0);
    expect(edit.doc?.cropRight).toBe(1);
  });

  test('insets the crop after a straighten', () => {
    presenter.settleStraighten(6);

    const doc = edit.doc!;
    expect(doc.cropLeft).toBeGreaterThan(0);
    expect(doc.cropTop).toBeGreaterThan(0);
    expect(doc.cropRight).toBeLessThan(1);
    expect(doc.cropBottom).toBeLessThan(1);
  });

  // The toggle is the whole of whether any of this happens. Off, the reader owns the rectangle.
  test('leaves the crop alone entirely when the habit is off', () => {
    presenter.setCropToFit(false);
    presenter.settleStraighten(6);

    expect(edit.doc?.cropAngle).toBe(6);
    expect(edit.doc?.cropLeft).toBe(0);
    expect(edit.doc?.cropRight).toBe(1);

    // And turning it back on catches the crop up, rather than waiting for the next move.
    presenter.setCropToFit(true);
    expect(edit.doc?.cropLeft).toBeGreaterThan(0);
  });

  // Nobody straightens a horizon in order to look at the wedges of blank it leaves, so the
  // slider takes the crop with it - and gives the whole frame back on the way to zero.
  test('crops to fit as the straighten moves, and hands the frame back at zero', () => {
    presenter.settleStraighten(6);
    expect(edit.doc?.cropLeft).toBeGreaterThan(0);
    expect(edit.doc?.cropRight).toBeLessThan(1);

    presenter.settleStraighten(0);
    expect(edit.doc?.cropLeft).toBe(0);
    expect(edit.doc?.cropTop).toBe(0);
    expect(edit.doc?.cropRight).toBe(1);
    expect(edit.doc?.cropBottom).toBe(1);
  });

  // The one place it must not: a rectangle being chosen by hand cannot be replaced under the
  // hand choosing it.
  test('leaves the rectangle alone while the crop tool is open', () => {
    presenter.setCropping(true);
    presenter.settleCrop({ left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 });
    presenter.settleStraighten(6);

    expect(edit.doc?.cropAngle).toBe(6);
    expect(edit.doc?.cropLeft).toBe(0.2);
    expect(edit.doc?.cropRight).toBe(0.8);
  });

  /**
   * A rectangle the reader chose is what the wedges get trimmed out of, not the frame.
   *
   * Levelling a horizon on a photograph already cropped to a corner must not hand any of the
   * frame back: the fit takes the blank out of their crop rather than replacing it.
   */
  test('trims out of the rectangle the reader chose, not out of the frame', () => {
    presenter.settleCrop({ left: 0, top: 0, right: 0.5, bottom: 0.5 });
    presenter.settleStraighten(6);

    const doc = edit.doc!;
    expect(doc.cropRight).toBeLessThanOrEqual(0.5);
    expect(doc.cropBottom).toBeLessThanOrEqual(0.5);
    // And most of that quarter is kept rather than a token rectangle in the middle of it. Less
    // than a straighten costs a whole frame, because a corner of the quarter is a corner of the
    // frame and so sits under two of the wedges.
    const kept = ((doc.cropRight - doc.cropLeft) * (doc.cropBottom - doc.cropTop)) / 0.25;
    expect(kept).toBeGreaterThan(0.7);
  });

  /**
   * The fit is a function of that rectangle and the geometry, so it is repeatable.
   *
   * Taking the *document's* crop as the reference would make each move trim what the last one
   * already trimmed: a sweep out to the end of the slider and back would keep the crop from the
   * end of it, and the frame would never come back.
   */
  test('gives the whole of the reader rectangle back on the way to zero', () => {
    presenter.settleCrop({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });
    presenter.settleStraighten(40);
    expect(edit.doc!.cropRight - edit.doc!.cropLeft).toBeLessThan(0.8);

    presenter.settleStraighten(0);
    expect(edit.doc?.cropLeft).toBeCloseTo(0.1, 10);
    expect(edit.doc?.cropTop).toBeCloseTo(0.1, 10);
    expect(edit.doc?.cropRight).toBeCloseTo(0.9, 10);
    expect(edit.doc?.cropBottom).toBeCloseTo(0.9, 10);
  });

  /**
   * And across a reload, which is the whole reason the framing is on the document.
   *
   * Held on the presenter it survived a drag and nothing else: the crop the reader came back to
   * was the trimmed one, so it became the rectangle the next straighten trimmed *again*, and
   * every session that touched the slider took another bite.
   */
  test('gives it back after a reload, not the rectangle the straighten left', () => {
    presenter.settleCrop({ left: 0, top: 0, right: 0.5, bottom: 0.5 });
    presenter.settleStraighten(40);
    const stored = edit.doc!;
    expect(stored.cropRight).toBeLessThan(0.5);

    // The editor opened again on what the server kept, which is this document and no more.
    const reopenedEdit = new EditStore();
    const reopened = new StageStore(reopenedEdit);
    const reopenedCrop = new CropStore(reopened, reopenedEdit);
    const reopenedKeystone = new KeystoneStore(reopened, reopenedEdit, reopenedCrop);
    const reopenedRepair = new RepairStore(reopenedEdit, reopenedKeystone);
    const reopenedLoupe = new LoupeStore(reopenedCrop, reopenedKeystone, reopenedRepair);
    reopenedEdit.doc = { ...stored };
    reopened.width = 4000;
    reopened.height = 3000;
    reopened.status = 'live';
    const after = new RawEditPresenter(
      reopenedEdit,
      reopened,
      reopenedCrop,
      reopenedKeystone,
      reopenedRepair,
      reopenedLoupe,
      new PrintStore(),
    );
    Object.assign(after, {
      local: { decoder: new FakeDecoder(reopenedKeystone), open: {} },
      drawable: true,
      box: { width: 1000, height: 750 },
      shown: { width: 4000, height: 3000 },
    });

    after.settleStraighten(0);
    expect(reopenedEdit.doc?.cropLeft).toBeCloseTo(0, 10);
    expect(reopenedEdit.doc?.cropTop).toBeCloseTo(0, 10);
    expect(reopenedEdit.doc?.cropRight).toBeCloseTo(0.5, 10);
    expect(reopenedEdit.doc?.cropBottom).toBeCloseTo(0.5, 10);
  });

  test('insets the crop after a correction', () => {
    presenter.setGuides(LEANING, true);

    const doc = edit.doc!;
    expect((doc.cropRight - doc.cropLeft) * (doc.cropBottom - doc.cropTop)).toBeLessThan(1);
    expect((doc.cropRight - doc.cropLeft) * (doc.cropBottom - doc.cropTop)).toBeGreaterThan(0.3);
  });
});
