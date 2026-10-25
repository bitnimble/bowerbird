// The reflection brush's actions, against a store and a module that only record what they were told.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EditState, ReflectionStroke } from '../../../../../../src/schemas/photo_edits';
import { photoEditsApi } from '../../../../api/photo_edits';
import { prepareOf } from '../../local_decode/open_photo';
import { openEditor, type Editor } from '../../stage/tests/raw_edit_harness';

let editor: Editor;
let saved: ReflectionStroke[][];
const save = photoEditsApi.save;

/** A right angle across the top left quarter, with a point on its first leg that adds nothing. */
const CORNER = [
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.5 },
];

/** The corner on the grid of a 4000x3000 frame: 65535 steps across, 49151 down. */
const ON_GRID: [number, number][] = [
  [16384, 12288],
  [49151, 12288],
  [49151, 24576],
];

/** 5% of the long edge, on the grid. */
const RADIUS = 3277;

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};

beforeEach(() => {
  editor = openEditor();
  editor.presenter.prepare.seed(prepareOf(editor.edit.doc!, 'galosh', true));
  saved = [];
  photoEditsApi.save = (_photoId, doc): Promise<EditState> => {
    saved.push(doc.reflectionStrokes);
    return Promise.resolve({ doc, rev: ++editor.edit.rev, canUndo: true, canRedo: false });
  };
  Object.assign(editor.presenter.edit, { photoId: 'a-photo-id' });
  editor.presenter.reflection.setEnabled(true);
  editor.presenter.reflection.setBrushing(true);
});

afterEach(() => {
  photoEditsApi.save = save;
});

async function paint(points = CORNER): Promise<void> {
  saved = [];
  await editor.presenter.reflection.paint(points);
  await settled();
}

describe('the reflection brush', () => {
  test('keeps a stroke on the grid of the photo as the lens left it, simplified, and saves once', async () => {
    await paint();

    expect(editor.decoder.mappedUnder[0]).toEqual(editor.keystone.geometry);
    const stroke: ReflectionStroke = { kind: 'remove', radius: RADIUS, points: ON_GRID };
    expect(editor.edit.doc?.reflectionStrokes).toEqual([stroke]);
    expect(saved).toEqual([[stroke]]);
  });

  test('marks scene to keep in Keep mode, after the strokes before it', async () => {
    await paint();
    editor.presenter.reflection.setMode('keep');
    await paint([{ x: 0.5, y: 0.5 }]);

    expect(
      editor.edit.doc?.reflectionStrokes.map(({ kind, points }) => ({ kind, points })),
    ).toEqual([
      { kind: 'remove', points: ON_GRID },
      { kind: 'keep', points: [[32768, 24576]] },
    ]);
  });

  test('takes a stroke onto the photo through the geometry the stage is drawn at', async () => {
    editor.presenter.turn(90);
    // A quarter turn clockwise, as the module would answer it: the output's (x, y) is the photo's
    // (y, 1 - x).
    editor.decoder.pictureOfOutput = (geometry, points) => {
      editor.decoder.mappedUnder.push(geometry);
      return Promise.resolve(points.map(([x, y]): [number, number] => [y, 1 - x]));
    };
    await paint([{ x: 0.25, y: 0.5 }]);

    expect(editor.decoder.mappedUnder.at(-1)?.rotate).toBe(90);
    expect(editor.edit.doc?.reflectionStrokes[0]?.points).toEqual([[32768, 36863]]);
  });

  test('draws the strokes kept over the output, at their radius in its pixels', async () => {
    await paint();

    expect(editor.reflection.outlines).toEqual([
      {
        kind: 'remove',
        radius: (RADIUS / 65535) * 4000,
        points: ON_GRID.map(([x, y]) => ({ x: x / 65535, y: y / 49151 })),
      },
    ]);
  });

  test('puts the brush away when reflection removal is turned off, and paints nothing then', async () => {
    saved = [];
    editor.presenter.reflection.setEnabled(false);
    await settled();

    expect(editor.edit.doc?.reflectionRemoval).toBe(false);
    expect(editor.reflection.brushing).toBe(false);
    expect(editor.reflection.painting).toBe(false);
    expect(saved).toHaveLength(1);

    await paint();
    expect(editor.edit.doc?.reflectionStrokes).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('clears every stroke as one step', async () => {
    await paint();
    saved = [];
    editor.presenter.reflection.clear();
    await settled();

    expect(editor.edit.doc?.reflectionStrokes).toEqual([]);
    expect(saved).toEqual([[]]);
  });

  test('drops the stroke on show when the module cannot place it', async () => {
    editor.decoder.pictureOfOutput = () => Promise.reject(new Error('no frame'));
    await paint();

    expect(editor.edit.doc?.reflectionStrokes).toEqual([]);
    expect(editor.reflection.outlines).toEqual([]);
  });

  test('lays a sheet turned in a room flat to paint, and paints nothing over one', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.reflection.setBrushing(true);
    expect(editor.stage.softProof).toBe('print');
    expect(editor.reflection.painting).toBe(true);

    editor.presenter.setSoftProof('print3d');
    expect(editor.reflection.painting).toBe(false);
  });

  test('takes the stage back from the loupe, and gives it up to any tool', () => {
    editor.presenter.setTool('loupe');
    expect(editor.reflection.brushing).toBe(false);

    editor.presenter.reflection.setBrushing(true);
    expect(editor.loupe.loupeOpen).toBe(false);
    expect(editor.reflection.painting).toBe(true);

    editor.presenter.setTool('repair');
    expect(editor.reflection.brushing).toBe(false);
  });
});
