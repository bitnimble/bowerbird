import { afterEach, describe, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { registerDom } from '../../../../test_dom';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const React = await import('react');
const { MergeTilePopup, flyoutAt } = await import('../merge_tile_popup');
const { FITTED, NO_SIZE } = await import('../../viewer/zoom_pan');
const { MergeStore } = await import('../merge_store');
const { assemblyRecipeFixture, triangleSeams } = await import('./fixtures/assembly_recipe');

afterEach(cleanup);

interface Calls {
  pick?: [number, number];
  hover?: number | null;
  stepped?: number;
  closed?: boolean;
}

function build(): { store: InstanceType<typeof MergeStore>; presenter: never; calls: Calls } {
  const store = new MergeStore();
  runInAction(() => {
    const recipe = assemblyRecipeFixture();
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.openTile = 0;
    store.layerUrls = ['/image/drafts/lib/key/0', '/image/drafts/lib/key/1'];
    // Half the recipe's canvas, as the analysis plane is: the flyout is placed in these pixels.
    store.layerSize = { width: 500, height: 500 };
  });
  const calls: Calls = {};
  const presenter = {
    pick: (tile: number, source: number) => (calls.pick = [tile, source]),
    hoverSwatch: (source: number | null) => (calls.hover = source),
    stepSwatch: (delta: number) => (calls.stepped = delta),
  } as never;
  return { store, presenter, calls };
}

function show(box = NO_SIZE): { store: InstanceType<typeof MergeStore>; calls: Calls } {
  const { store, presenter, calls } = build();
  render(
    React.createElement(MergeTilePopup, {
      store,
      presenter,
      tile: 0,
      zoom: { view: FITTED, box } as never,
      onClose: () => (calls.closed = true),
    }),
  );
  return { store, calls };
}

test('one swatch button per source, clicking one picks it and closes', () => {
  const { calls } = show();
  const buttons = screen.getAllByRole('button', { name: /choose frame/i });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
  expect(calls.pick).toEqual([0, 1]);
  expect(calls.closed).toBe(true);
});

// A swatch says which file it is and nothing else: the digit badges said only where in the row the
// swatch already was, over the one part of the picture the reader opened the flyout to look at.
test('a swatch is labelled by its file, with no badge over the picture', () => {
  show();
  expect(screen.queryByText(/^[0-9]$/)).toBeNull();
  const names = screen.getAllByRole('button', { name: /choose frame/i }).map((it) => it.textContent);
  expect(names).toEqual(['frame001', 'frame002']);
});

// Moving from one swatch to the next is not a moment to show the tile without either: only leaving
// the row clears the preview.
test('hovering a swatch previews it, and only leaving the row clears the preview', () => {
  const { calls } = show();
  const buttons = screen.getAllByRole('button', { name: /choose frame/i });
  fireEvent.mouseEnter(buttons[1]!);
  expect(calls.hover).toBe(1);
  fireEvent.mouseEnter(buttons[0]!);
  expect(calls.hover).toBe(0);
  fireEvent.mouseLeave(buttons[0]!.parentElement!);
  expect(calls.hover).toBeNull();
});

// §2.3: one swatch per frame, each clipped to the tile's own outline - and each is drawn from the
// frame the page already decoded, rather than a file decoded again on every open.
test('each swatch is drawn from its own decoded layer, clipped to the tile', () => {
  const { store } = build();
  const frame = (width: number): never =>
    ({ picture: {}, close: () => undefined, closed: false, width, height: 500, naturalWidth: width, naturalHeight: 500 }) as never;
  runInAction(() => (store.layers = new Map([[0, frame(500)], [1, frame(500)]])));
  render(
    React.createElement(MergeTilePopup, {
      store,
      presenter: build().presenter,
      tile: 0,
      zoom: { view: FITTED, box: NO_SIZE } as never,
      onClose: () => undefined,
    }),
  );
  const pictures = screen.getAllByRole('img', { name: /over this tile/i });
  expect(pictures.map((picture) => picture.tagName)).toEqual(['CANVAS', 'CANVAS']);
  expect(pictures[0]!.style.clipPath).toContain('polygon');
  expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
});

// Only the grown form is ever shown: once a frame's growth of the tile is solved, its swatch is cut
// to that rather than to the tile the click seeded.
test('a swatch is clipped to its frame grown, once that is solved', () => {
  const clipOf = (solved: boolean): string => {
    const { store, presenter } = build();
    const frame = { picture: {}, close: () => undefined, closed: false, width: 500, height: 500 } as never;
    runInAction(() => {
      store.layers = new Map([[0, frame], [1, frame]]);
      if (!solved) return;
      store.solved.set(store.keyOf([1, 0]), { seams: triangleSeams([1, 0], 0, 900), geometry: store.geometry });
    });
    render(
      React.createElement(MergeTilePopup, {
        store,
        presenter,
        tile: 0,
        zoom: { view: FITTED, box: NO_SIZE } as never,
        onClose: () => undefined,
      }),
    );
    const clip = screen.getAllByRole('img', { name: /over this tile/i })[1]!.style.clipPath;
    cleanup();
    return clip;
  };
  expect(clipOf(true)).not.toBe(clipOf(false));
});

test('the swatch the tile currently draws from is marked', () => {
  show();
  const buttons = screen.getAllByRole('button', { name: /choose frame/i });
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
});

test('a digit picks the swatch at that position', () => {
  const { calls } = show();
  fireEvent.keyDown(window, { key: '2' });
  expect(calls.pick).toEqual([0, 1]);
  expect(calls.closed).toBe(true);
});

test('Escape closes without picking', () => {
  const { calls } = show();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(calls.closed).toBe(true);
  expect(calls.pick).toBeUndefined();
});

// §2.8's arrows. A preview, not a pick: the reader flicks between two frames to see which one has
// the eyes open, and what settles it is Enter.
test('an arrow previews the neighbouring frame and Enter settles on it', () => {
  const { store, calls } = show();
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(calls.stepped).toBe(1);
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(calls.stepped).toBe(-1);
  expect(calls.pick).toBeUndefined();

  runInAction(() => (store.hoveredSwatch = 1));
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(calls.pick).toEqual([0, 1]);
  expect(calls.closed).toBe(true);
});

// The tile's own outline carried onto the stage, which is what makes this a flyout rather than a
// panel in a corner. Tile 0 is the canvas's top left quarter, so at the analysis scale it ends at
// 250 and the flyout starts a gap below that, centred on it.
test('the flyout is placed against the tile it belongs to', () => {
  show({ width: 500, height: 500 });
  const popup = screen.getByRole('dialog');
  expect(popup.style.top).toBe('258px');
  expect(popup.style.left).toBe('0px');
});

// Where the flyout lands, which is arithmetic over the outline, the flyout's own box and the
// stage's.
describe('flyoutAt', () => {
  const STAGE = { width: 1000, height: 800 };
  const POPUP = { width: 300, height: 140 };

  const loop = (left: number, top: number, right: number, bottom: number): { x: number; y: number }[] => [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];

  // Concave, with a notch cut into its underside: what the flyout clears is the lowest point of
  // the outline, so the notch changes nothing.
  test('sits below the tile, centred on it', () => {
    const notched = [
      { x: 400, y: 300 },
      { x: 500, y: 300 },
      { x: 500, y: 400 },
      { x: 450, y: 340 },
      { x: 400, y: 400 },
    ];
    expect(flyoutAt(notched, POPUP, STAGE)).toEqual({ left: 300, top: 408 });
  });

  test('flips above a tile with no room below it', () => {
    expect(flyoutAt(loop(400, 680, 500, 780), POPUP, STAGE)).toEqual({ left: 300, top: 532 });
  });

  test('slides along to stay inside the stage at either edge', () => {
    expect(flyoutAt(loop(940, 300, 1000, 400), POPUP, STAGE).left).toBe(700);
    expect(flyoutAt(loop(0, 300, 60, 400), POPUP, STAGE).left).toBe(0);
  });

  // A tile with no room above it or below it: what is left is one of the two sides, and either
  // will do so long as the outline is not under it.
  test('goes beside a tile that fits neither above nor below', () => {
    const stage = { width: 1000, height: 200 };
    const at = flyoutAt(loop(400, 60, 500, 150), POPUP, stage);
    expect(at.left + POPUP.width <= 400 || at.left >= 500).toBe(true);
    expect(at.top + POPUP.height).toBeLessThanOrEqual(stage.height);
  });

  // The picture is not much bigger than the flyout on a burst of several frames, so the four sides
  // routinely have no room and what is left is the search. The spot it takes has to be one the
  // outline does not reach - and of those, the one furthest from it, a flyout pressed up against
  // the tile being what the reader reads as covering it.
  test('takes the clearest spot on the stage when no side has room', () => {
    const stage = { width: 700, height: 500 };
    const tile = loop(150, 150, 550, 350);
    const at = flyoutAt(tile, POPUP, stage);
    const box = { ...at, right: at.left + POPUP.width, bottom: at.top + POPUP.height };
    expect(box.right <= 150 || box.left >= 550 || box.bottom <= 150 || box.top >= 350).toBe(true);
  });

  test('holds the near edge when the flyout is wider or taller than the stage', () => {
    expect(flyoutAt(loop(100, 100, 200, 200), POPUP, { width: 200, height: 100 })).toEqual({ left: 0, top: 0 });
  });

  // The claim the whole placement exists for, over every tile a burst plausibly produces rather
  // than the four the cases above name: **wherever the stage has a clear spot at all, the one
  // taken is clear**. A flyout over the tile is the one thing a reader comparing frames cannot work
  // around, and what breaks it is the awkward shapes - a tile most of the stage wide, one in a
  // corner, one so large that only a sliver of stage is left.
  //
  // The search's own grid is what "exists" is asked over, so this pins the choice rather than the
  // resolution: a stage with room for the flyout only between two grid steps is a stage this
  // reports no spot on, which is the miss `FLYOUT_STEP` is.
  test('covers no part of its own tile wherever the stage has room for it at all', () => {
    // The real flyout at four frames, and the stages a laptop, a small window and a phone give it.
    const popup = { width: 758, height: 194 };
    const stages = [
      { width: 1600, height: 900 },
      { width: 1200, height: 800 },
      { width: 900, height: 620 },
      { width: 1600, height: 300 },
    ];
    const clearOfTile = (at: { left: number; top: number }, tile: { x: number; y: number }[]): boolean =>
      at.left + popup.width <= tile[0]!.x ||
      at.left >= tile[1]!.x ||
      at.top + popup.height <= tile[0]!.y ||
      at.top >= tile[2]!.y;

    let checked = 0;
    for (const stage of stages) {
      for (let left = 0; left + 40 <= stage.width; left += 137) {
        for (let top = 0; top + 40 <= stage.height; top += 91) {
          const shapes: [number, number][] = [
            [40, 40],
            [260, 150],
            [700, 200],
            [200, 500],
          ];
          for (const [wide, tall] of shapes) {
            const tile = loop(
              left,
              top,
              Math.min(left + wide, stage.width),
              Math.min(top + tall, stage.height),
            );
            let room = false;
            for (let y = 0; y <= stage.height - popup.height && !room; y += 16) {
              for (let x = 0; x <= stage.width - popup.width && !room; x += 16) {
                room = clearOfTile({ left: x, top: y }, tile);
              }
            }
            if (!room) continue;
            checked += 1;
            const at = flyoutAt(tile, popup, stage);
            expect({ stage, at, clear: clearOfTile(at, tile) }).toEqual({ stage, at, clear: true });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
