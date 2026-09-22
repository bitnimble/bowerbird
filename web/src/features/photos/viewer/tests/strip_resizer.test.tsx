// The filmstrip edge's own wiring: which way a drag and each arrow take it on either
// axis, and that the drag only counts while the pointer is captured. The clamp behind
// it is the presenter's; what this holds is that the right call is made.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import { MemoryStorage } from '../../../../test_storage';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { useEffect, useState } = await import('react');
const { StripResizer } = await import('../../grid/photo_strip');
const { StripViewPresenter } = await import('../strip_view_presenter');
const { STRIP_DEFAULT_THICKNESS, STRIP_MAX_THICKNESS, STRIP_MIN_THICKNESS, StripViewStore } = await import('../strip_view_store');
const { StoresProvider, useListingStore, usePresenters, useStacksStore, useViewerStore } = await import('../../../../app/stores_context');

afterEach(cleanup);
// A thickness the last test dragged to is one the next would start from.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

let view: InstanceType<typeof StripViewStore>;

function Hold({ axis }: { axis: 'x' | 'y' }): JSX.Element {
  const listing = useListingStore();
  const stacks = useStacksStore();
  const viewer = useViewerStore();
  const { photos } = usePresenters();
  const [strip] = useState(() => {
    const store = new StripViewStore(listing, stacks, viewer);
    return { view: store, presenter: new StripViewPresenter(store, photos) };
  });
  view = strip.view;
  useEffect(() => strip.presenter.setAxis(axis), [strip, axis]);
  return <StripResizer view={strip.view} presenter={strip.presenter} />;
}

/** The page handing the strip the other edge, which it does off the strip's own thickness. */
let turn: (axis: 'x' | 'y') => Promise<void>;

async function mount(axis: 'x' | 'y'): Promise<HTMLElement> {
  const { rerender } = render(
    <StoresProvider>
      <Hold axis={axis} />
    </StoresProvider>,
  );
  turn = async (next) => {
    await act(async () => {
      rerender(
        <StoresProvider>
          <Hold axis={next} />
        </StoresProvider>,
      );
    });
  };
  await act(async () => {});
  return screen.getByRole('separator');
}

// Up the screen along the foot, and towards the photograph down the side: the strip is
// past the picture either way, so it grows back towards where the drag came from.
test('a drag grows the strip towards the photograph', async () => {
  const handle = await mount('x');

  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 600 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 560 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS + 40);

  // Where the pointer is, not how far it last moved: a drag back is the thickness it started at.
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 620 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS - 20);

  // Let go, and the edge stops following - a pointer that wanders back over it is not
  // still dragging.
  fireEvent.pointerUp(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS - 20);
});

test('a strip down the side is dragged sideways', async () => {
  const handle = await mount('y');

  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 860 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS + 40);

  // The axis it does not run on says nothing about how thick it is.
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 860, clientY: 300 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS + 40);
});

// How thick the strip is is what decides which edge it takes, so a drag long enough to cross
// that decision swaps the axis it is being measured on, with the pointer still down.
test('a drag survives the strip swapping edges under it', async () => {
  const handle = await mount('x');

  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500, clientY: 600 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 560 });
  const grown = view.thickness;
  expect(grown).toBe(STRIP_DEFAULT_THICKNESS + 40);

  await turn('y');
  // Where the pointer is now is where the sideways drag starts from, so this move is no move.
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 560 });
  expect(view.thickness).toBe(grown);

  // Sideways from there, rather than a distance down the screen subtracted from one across it.
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, clientY: 560 });
  expect(view.thickness).toBe(grown + 20);
});

test('a pointer that never took the handle does not move it', async () => {
  const handle = await mount('x');
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS);
});

test('the arrows take the edge the way they point', async () => {
  const handle = await mount('x');

  fireEvent.keyDown(handle, { key: 'ArrowUp' });
  const thicker = view.thickness;
  expect(thicker).toBeGreaterThan(STRIP_DEFAULT_THICKNESS);

  fireEvent.keyDown(handle, { key: 'ArrowDown' });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS);

  // The pair the other axis is dragged with is the pair it is nudged with.
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS);
});

test('the arrows down the side are the sideways pair', async () => {
  const handle = await mount('y');

  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  const thicker = view.thickness;
  expect(thicker).toBeGreaterThan(STRIP_DEFAULT_THICKNESS);

  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS);

  fireEvent.keyDown(handle, { key: 'ArrowUp' });
  expect(view.thickness).toBe(STRIP_DEFAULT_THICKNESS);
});

test('the handle announces how thick the strip is, and how thick it goes', async () => {
  const handle = await mount('x');
  expect(handle.getAttribute('aria-valuenow')).toBe(String(STRIP_DEFAULT_THICKNESS));
  expect(handle.getAttribute('aria-valuemin')).toBe(String(STRIP_MIN_THICKNESS));
  expect(handle.getAttribute('aria-valuemax')).toBe(String(STRIP_MAX_THICKNESS));

  fireEvent.keyDown(handle, { key: 'ArrowUp' });
  expect(handle.getAttribute('aria-valuenow')).toBe(String(view.thickness));
});

// Held against the clamp rather than the step, so this says the arrows stop at an end
// rather than how far each one travels.
test('a drag past either end stops at it', async () => {
  const handle = await mount('x');
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 600 });

  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
  expect(view.thickness).toBe(STRIP_MAX_THICKNESS);

  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 2000 });
  expect(view.thickness).toBe(STRIP_MIN_THICKNESS);
});
