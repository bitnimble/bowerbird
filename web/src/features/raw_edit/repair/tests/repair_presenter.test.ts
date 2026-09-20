// The repair tool's actions, against a store and a module that only record what they were told.
import { beforeEach, describe, expect, test } from 'bun:test';
import { CropStore } from '../../crop/crop_store';
import { EditStore } from '../../edit/edit_store';
import { KeystoneStore } from '../../keystone/keystone_store';
import { prepareOf } from '../../local_decode/open_photo';
import { LoupeStore } from '../../loupe/loupe_store';
import { RawEditPresenter } from '../../stage/raw_edit_presenter';
import { StageStore } from '../../stage/stage_store';
import type { Repair } from '../../../../../../src/schemas/stored_grid';
import { RawEditPanelStrings } from '../../raw_edit_panel.strings';
import { FakeDecoder, GRADE, openEditor, openedWith, type Editor } from '../../stage/tests/raw_edit_harness';
import { RepairStore } from '../repair_store';

let editor: Editor;
let stage: StageStore;
let edit: EditStore;
let keystone: KeystoneStore;
let repair: RepairStore;
let presenter: RawEditPresenter;
let decoder: FakeDecoder;

/** A 4000x3000 frame's rows 2000 to 2100, on the grid: 49151 steps down, 65535 across. */
const seam: [number, number][] = [
  [10000, 32767],
  [12000, 32767],
  [12000, 34406],
  [10000, 34406],
];
const drawn: [number, number][] = [
  [10500, 33000],
  [11500, 33000],
  [11000, 34000],
];
const FIRST: Repair = { drawn, seam, donor: [3000, 0], gain: 1 };
const SECOND: Repair = { drawn, seam, donor: [-3000, 0], gain: 1.1 };
const SQUARE = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.1 },
  { x: 0.2, y: 0.2 },
  { x: 0.1, y: 0.2 },
];

/** Long enough for a sweep of bands to resolve, each one a turn of its own. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};

beforeEach(() => {
  editor = openEditor();
  ({ edit, stage, keystone, repair, presenter, decoder } = editor);
  // The settings the frame on the device was prepared at, which an open records.
  presenter.prepare.seed(prepareOf(edit.doc!));
  presenter.setTool('repair');
  decoder.offer = [FIRST, SECOND];
});

function rememberedRepair(): RepairStore {
  const nextEdit = new EditStore();
  const nextStage = new StageStore(nextEdit);
  const nextCrop = new CropStore(nextStage, nextEdit);
  const nextKeystone = new KeystoneStore(nextStage, nextEdit, nextCrop);
  const nextRepair = new RepairStore(nextEdit, nextKeystone);
  const nextLoupe = new LoupeStore(nextCrop, nextKeystone, nextRepair);
  new RawEditPresenter(nextEdit, nextStage, nextCrop, nextKeystone, nextRepair, nextLoupe);
  return nextRepair;
}

describe('the repair tool', () => {
  test('leaves the stage as it was: cropped, straightened and turned', () => {
    presenter.setTool('cursor');
    presenter.settle({ cropLeft: 0.1, cropAngle: 4, rotate: 90 });
    const before = keystone.geometry;

    presenter.setTool('repair');

    expect(keystone.geometry).toEqual(before);
  });

  test('solves a loop on the grid of the photograph as the lens left it, and shows its cheapest fill', async () => {
    await presenter.repair.draw(SQUARE);

    // A tenth of 65535 across and of 49151 down, rounded to whole steps.
    expect(decoder.solved.map(({ drawn, others }) => ({ drawn, others }))).toEqual([
      {
        drawn: [
          [6554, 4915],
          [13107, 4915],
          [13107, 9830],
          [6554, 9830],
        ],
        others: [],
      },
    ]);
    expect(repair.repairOptions).toEqual([FIRST, SECOND]);
    expect(edit.doc?.repairs).toEqual([FIRST]);
    expect(repair.repairShownAt).toBe(0);
  });

  test('takes a loop onto the picture through the geometry the stage is drawn at', async () => {
    presenter.turn(90);
    // A quarter turn clockwise, as the module would answer it: the output's (x, y) is the picture's
    // (y, 1 - x).
    decoder.pictureOfOutput = (geometry, points) => {
      decoder.mappedUnder.push(geometry);
      return Promise.resolve(points.map(([x, y]): [number, number] => [y, 1 - x]));
    };
    await presenter.repair.draw([{ x: 0.1, y: 0.2 }, ...SQUARE.slice(1)]);

    expect(decoder.mappedUnder.at(-1)?.rotate).toBe(90);
    // (0.2, 0.9) of the picture, on the grid.
    expect(decoder.solved[0]?.drawn[0]).toEqual([13107, 44236]);
  });

  test('hides the seams on request, and the next editor remembers', () => {
    expect(repair.repairOutlinesShown).toBe(true);
    presenter.repair.setOutlinesShown(false);
    expect(repair.repairOutlinesShown).toBe(false);

    expect(rememberedRepair().repairOutlinesShown).toBe(false);
  });

  test('searches again from the same loop when the seam is told not to grow', async () => {
    await presenter.repair.draw(SQUARE);
    expect(decoder.grown).toEqual([true]);
    decoder.offer = [SECOND];

    presenter.repair.setGrows(false);
    await settled();

    expect(decoder.grown).toEqual([true, false]);
    expect(decoder.solved[1]?.drawn).toEqual(decoder.solved[0]?.drawn);
    // Searched off the picture without the fill that was on offer.
    expect(decoder.solved[1]?.without).toEqual(FIRST);
    expect(edit.doc?.repairs).toEqual([SECOND]);

    expect(rememberedRepair().repairGrows).toBe(false);
  });

  test('draws every seam where the stage shows it', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();

    // The first seam vertex, as fractions of the 65535 x 49151 grid, through the identity.
    expect(repair.repairOutlines[0]?.[0]?.x).toBeCloseTo(10000 / 65535);
    expect(repair.repairOutlines[0]?.[0]?.y).toBeCloseTo(32767 / 49151);
    expect(repair.repairOutlines).toHaveLength(1);
  });

  test('draws its repairs over a picture prepared elsewhere, with no mosaic to re-run', async () => {
    openedWith(editor, { local: { decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true } });
    stage.preparedElsewhere = true;

    await presenter.repair.draw(SQUARE);
    await settled();

    expect(decoder.repairsSet.at(-1)).toEqual([FIRST]);
    expect(decoder.bands).toEqual([]);
    // Held as far as the search reads while it ran, and let go after.
    expect(decoder.searchedAround).toEqual([decoder.solved[0]?.drawn ?? null, null]);
    expect(decoder.searchedAround[0]).not.toBeNull();
  });

  test('shows another fill in the same place, and puts the repairs back on cancel', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.choose(1);
    expect(edit.doc?.repairs).toEqual([SECOND]);

    presenter.repair.cancel();
    expect(edit.doc?.repairs).toEqual([]);
    expect(repair.repairOptions).toBeNull();
    expect(repair.repairShownAt).toBeNull();
  });

  test('blends every fill on offer by the share of the long edge the slider is at', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.previewFeather(0.005);

    // Half a percent of 65535 steps.
    expect(repair.repairOptions?.map(({ feather }) => feather)).toEqual([328, 328]);
    expect(edit.doc?.repairs).toEqual([{ ...FIRST, feather: 328 }]);

    presenter.repair.choose(1);
    presenter.repair.settleFeather(0);
    presenter.repair.apply();
    await settled();

    expect(edit.doc?.repairs).toEqual([{ ...SECOND, feather: 0 }]);
    expect(decoder.redrawn.at(-1)).toEqual([{ ...SECOND, feather: 0 }]);
  });

  test('keeps the fill on show when it is applied, and leaving the tool keeps it too', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.choose(1);
    presenter.repair.apply();
    presenter.setTool('cursor');

    expect(edit.doc?.repairs).toEqual([SECOND]);
    expect(repair.repairOptions).toBeNull();
  });

  test('takes the fill on show back off when the tool is left without choosing', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.setTool('crop');

    expect(edit.doc?.repairs).toEqual([]);
  });

  test('drops a loop still being solved when the tool is left, or another loop is drawn', async () => {
    const left = presenter.repair.draw(SQUARE);
    presenter.setTool('cursor');
    await left;
    await settled();
    expect(edit.doc?.repairs).toEqual([]);
    expect(repair.repairOptions).toBeNull();

    presenter.setTool('repair');
    const first = presenter.repair.draw(SQUARE);
    const second = presenter.repair.draw(SQUARE.map(({ x, y }) => ({ x: x + 0.5, y })));
    await Promise.all([first, second]);
    await settled();
    expect(decoder.solved.map(({ drawn }) => drawn[0])).toEqual([[39321, 4915]]);
    expect(repair.repairSolving).toBe(false);
  });

  test('says so where there is nothing to fill from, and changes nothing', async () => {
    decoder.offer = [];
    await presenter.repair.draw(SQUARE);

    expect(repair.repairRefusal).toBe(RawEditPanelStrings.nothingToFillFrom());
    expect(edit.doc?.repairs).toEqual([]);
  });

  test('redraws a repair over the frame without preparing any of it again', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();

    expect(decoder.redrawn).toEqual([[FIRST]]);
    expect(decoder.bands).toEqual([]);
  });

  test('prepares again only the rows a sweep left behind, once the repairs are redrawn', async () => {
    // The second of the 1024-row bands, at a setting the rest of the frame is not.
    Object.assign(presenter.prepare, { mixedRows: [1100, 1900] });

    await presenter.repair.draw(SQUARE);
    await settled();

    expect(decoder.redrawn).toEqual([[FIRST]]);
    expect(decoder.bands.map(({ top, mosaic }) => ({ top, repairs: mosaic.repairs }))).toEqual([
      { top: 1024, repairs: [FIRST] },
    ]);
  });

  test('reopens a repair at its own fill and blend, beside the others searched off the picture without it', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.settleFeather(0.005);
    presenter.repair.apply();
    const kept = { ...FIRST, feather: 328 };
    decoder.offer = [FIRST, SECOND];
    await settled();
    const bands = decoder.bands.length;

    await presenter.repair.open(0);
    await settled();

    // Searched off a picture without the repair, from the loop it was drawn with, while the stage
    // went on showing it: nothing was prepared again.
    expect(decoder.solved.at(-1)).toEqual({ drawn, others: [], framed: [kept], without: kept, donor: null });
    expect(decoder.bands).toHaveLength(bands);
    expect(repair.repairOptions).toEqual([kept, { ...SECOND, feather: 328 }]);
    expect(repair.repairChoice).toBe(0);
    expect(repair.repairShownAt).toBe(0);
    expect(edit.doc?.repairs).toEqual([kept]);

    presenter.repair.choose(1);
    expect(edit.doc?.repairs).toEqual([{ ...SECOND, feather: 328 }]);
    presenter.repair.cancel();
    expect(edit.doc?.repairs).toEqual([kept]);
  });

  test('draws a thumbnail for a repair whose blend moved before it was kept', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();
    presenter.repair.settleFeather(0.005);
    presenter.repair.apply();
    await settled();

    expect(decoder.thumbnails).toHaveLength(1);
    expect(repair.repairThumbnails.has(repair.repairKeys[0] ?? '')).toBe(true);
  });

  test('draws each fill on offer in place of the one on show, over one square, and lets them go', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();

    expect(decoder.optionThumbnails.map(({ option }) => option)).toEqual([FIRST, SECOND]);
    expect(decoder.optionThumbnails.map(({ showing }) => showing)).toEqual([FIRST, FIRST]);
    expect(decoder.optionThumbnails[1]?.region).toEqual(decoder.optionThumbnails[0]?.region);
    expect([...repair.repairOptionThumbnails.keys()]).toEqual([0, 1]);

    presenter.repair.apply();
    expect(repair.repairOptionThumbnails.size).toBe(0);
  });

  test('moves where the fill on show is read from step by step, solving it at each', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.settleFeather(0.005);
    await settled();
    decoder.offer = [];

    // Two sixteenths of the output across, which the identity makes an eighth of the grid's 65535.
    void presenter.repair.move('source', { x: 0.25, y: 0.5 }, { x: 0.3125, y: 0.5 });
    await presenter.repair.move('source', { x: 0.3125, y: 0.5 }, { x: 0.375, y: 0.5 });
    const read: [number, number] = [3000 + 8192, 0];
    expect(edit.doc?.repairs[0]?.donor).toEqual(read);

    decoder.offer = [{ ...SECOND, gain: 1.25 }];
    await presenter.repair.move('source', { x: 0.375, y: 0.5 }, { x: 0.375, y: 0.5 });
    await settled();
    expect(decoder.solved.at(-1)).toMatchObject({ donor: read, without: { donor: read } });
    // Solved there, at the blend the reader had.
    expect(edit.doc?.repairs).toEqual([{ ...SECOND, gain: 1.25, feather: 328 }]);
  });

  test('moves the fill on show, reading from where it did, and drops the places found for where it was', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();
    expect(repair.repairOptions).toHaveLength(2);
    decoder.offer = [];

    await presenter.repair.move('fill', { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.45 });
    await settled();
    // A twentieth of the output down, which is 5% of the grid's 49151 steps.
    const by = -2458;
    const moved = edit.doc?.repairs[0];
    expect(moved?.drawn).toEqual(drawn.map(([x, y]) => [x, y + by]));
    expect(moved?.donor).toEqual([3000, -by]);
    expect(repair.repairOptions).toHaveLength(1);
    // Grown again from the loop the reader drew, not from the seam the last solve grew it to.
    expect(decoder.solved.at(-1)?.drawn).toEqual(drawn.map(([x, y]) => [x, y + by]));

    // Let go, it is searched around where it now is and offered first beside what that finds.
    const shown: Repair = { drawn: drawn.map(([x, y]) => [x, y + by]), seam: moved!.seam, donor: [3000, -by], gain: 1 };
    const found: Repair = { drawn: shown.drawn, seam, donor: [0, 5000], gain: 1 };
    decoder.offer = [found];
    await presenter.repair.settleMove();
    await settled();
    const searched = decoder.solved.at(-1);
    expect([searched?.drawn, searched?.donor, searched?.without]).toEqual([shown.drawn, null, shown]);
    expect(repair.repairOptions).toEqual([shown, found]);
    expect(repair.repairChoice).toBe(0);
    presenter.repair.cancel();
  });

  test('reopens a repair even where nothing else is found for it', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.apply();
    decoder.offer = [];

    await presenter.repair.open(0);

    expect(repair.repairOptions).toEqual([FIRST]);
    expect(repair.repairRefusal).toBeNull();
  });

  test('draws a thumbnail of each repair kept, square around its seam, and lets it go with the repair', async () => {
    await presenter.repair.draw(SQUARE);
    await settled();
    // Not while the fill is only on offer.
    expect(decoder.thumbnails).toEqual([]);

    presenter.repair.apply();
    await settled();

    const [asked] = decoder.thumbnails;
    const { width, height } = keystone.output;
    // The seam's box, 2000 x 1639 steps of the 65535 x 49151 grid, grown by 1.6 about its middle.
    const across = Math.max((2000 / 65535) * width, (1639 / 49151) * height) * 1.6;
    expect(asked?.side).toBe(Math.min(Math.max(Math.ceil(across), 96), 512));
    expect(asked?.repair).toEqual(FIRST);
    expect(asked?.region.width).toBeCloseTo(across);
    expect(asked?.region.height).toBeCloseTo(across);
    expect((asked?.region.x ?? 0) + across / 2).toBeCloseTo((11000 / 65535) * width);
    const key = repair.repairKeys[0] ?? '';
    expect(repair.repairThumbnails.get(key)?.seam[0]?.x).toBeCloseTo(
      ((10000 / 65535) * width - (asked?.region.x ?? 0)) / across,
    );

    presenter.repair.remove(0);
    presenter.setRepairing(false);
    presenter.setRepairing(true);
    await settled();
    expect(repair.repairThumbnails.size).toBe(0);
  });

  test('takes a repair off', async () => {
    await presenter.repair.draw(SQUARE);
    presenter.repair.apply();
    presenter.repair.remove(0);

    expect(edit.doc?.repairs).toEqual([]);
  });

  test('leaves the fill on offer out of the document when the editor closes', async () => {
    await presenter.repair.draw(SQUARE);

    presenter.close();

    expect(edit.doc?.repairs).toEqual([]);
    expect(repair.repairOptions).toBeNull();
  });
});
