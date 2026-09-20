// The editor's actions, against a store and a module that only record what they were told.
//
// This is the seam the architecture exists for: every mutation is on the presenter, so what a
// button does is answerable without a GPU, a server or a browser. An end-to-end run opening a
// real RAW answers the same questions slowly, and only ever says that *something* changed.
import { beforeEach, describe, expect, test } from 'bun:test';
import { RawEditPresenter } from '../../stage/raw_edit_presenter';
import type { EditStore } from '../../edit/edit_store';
import {
  drawnBy,
  FakeDecoder,
  openEditor,
  type Editor,
} from '../../stage/tests/raw_edit_harness';
import type { KeystoneStore } from '../keystone_store';

let editor: Editor;
let edit: EditStore;
let keystone: KeystoneStore;
let presenter: RawEditPresenter;
let decoder: FakeDecoder;

beforeEach(() => {
  editor = openEditor();
  ({ edit, keystone, presenter, decoder } = editor);
});

const drawn = (): Promise<number> => drawnBy(editor);

/** Two lines down edges that lean towards each other, as a building shot from below has. */
const LEANING = [
  { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
  { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
];

describe('the perspective tool', () => {
  test('turns the lines the reader drew into a correction on the document', () => {
    presenter.setGuides(LEANING, true);

    expect(edit.doc?.keystoneGuides).toEqual(LEANING);
    expect(edit.doc?.keystone).not.toBeNull();
    expect(keystone.keystoned).toBe(true);
  });

  test('holds the guides without a correction where they ask for nothing', () => {
    // Already parallel: there is nothing to correct, and the guides stay so the reader can
    // move one rather than start again.
    const parallel = [
      { x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.9 },
      { x1: 0.7, y1: 0.1, x2: 0.7, y2: 0.9 },
    ];
    presenter.setGuides(parallel, true);

    expect(edit.doc?.keystoneGuides).toEqual(parallel);
    expect(edit.doc?.keystone).toBeNull();
  });

  test('keeps the guides in the frame own fractions, whatever the turn', () => {
    presenter.turn(90);
    presenter.setGuides(LEANING, true);

    // What the overlay is handed back is what it drew, at the same place on screen; what the
    // document holds is the turn taken back off.
    expect(keystone.guides[0]?.x1).toBeCloseTo(LEANING[0]!.x1, 10);
    expect(keystone.guides[0]?.y1).toBeCloseTo(LEANING[0]!.y1, 10);
    expect(edit.doc?.keystoneGuides[0]?.x1).not.toBeCloseTo(LEANING[0]!.x1, 3);
  });

  test('shows the frame uncorrected while the tool is open, and corrected when it closes', async () => {
    presenter.setGuides(LEANING, true);

    presenter.setKeystoning(true);
    await drawn();
    expect(decoder.geometry?.keystone).toBeNull();

    presenter.setKeystoning(false);
    await drawn();
    expect(decoder.geometry?.keystone).toEqual(edit.doc!.keystone!);
  });

  // The bug this test exists for: closing the tool pushed the new geometry and never asked for
  // a frame. A crop hides that - the picture changes shape and the stage refits - and a
  // correction does not, so the corrected photograph simply never appeared.
  test('draws the picture again when a tool opens or closes', async () => {
    presenter.setGuides(LEANING, true);
    const before = await drawn();

    presenter.setKeystoning(true);
    const opened = await drawn();
    expect(opened).toBeGreaterThan(before);

    presenter.setKeystoning(false);
    const closed = await drawn();
    expect(closed).toBeGreaterThan(opened);

    presenter.setCropping(true);
    expect(await drawn()).toBeGreaterThan(closed);
  });

  test('clearing takes the correction and the guides together', () => {
    presenter.setGuides(LEANING, true);
    presenter.clearKeystone();

    expect(edit.doc?.keystone).toBeNull();
    expect(edit.doc?.keystoneGuides).toEqual([]);
    expect(keystone.keystoned).toBe(false);
  });
});
