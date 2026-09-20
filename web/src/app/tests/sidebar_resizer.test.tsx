// The handle's own wiring: which way each arrow takes the edge, and that the drag
// only counts while the pointer is captured. The arithmetic behind both is the
// presenter's and pinned there; what this holds is that the right call is made.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';
import { MemoryStorage } from '../../test_storage';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { SidebarResizer } = await import('../app');
const { StoresProvider, useSidebarStore } = await import('../stores_context');

afterEach(cleanup);
// A width the last test dragged to is a width the next one would start from.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

// The store is the provider's, so the assertions read it from inside rather than
// against one built beside it.
let store: ReturnType<typeof useSidebarStore>;

function Hold(): null {
  store = useSidebarStore();
  return null;
}

async function mount(): Promise<HTMLElement> {
  render(
    <StoresProvider>
      <Hold />
      <SidebarResizer />
    </StoresProvider>,
  );
  await act(async () => {});
  return screen.getByRole('separator');
}

test('the arrows take the edge the way they point', async () => {
  const handle = await mount();
  // Nothing has dragged it, so this starts from the width the stylesheet gives it.
  expect(store.width).toBeNull();

  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  const wider = store.width!;
  expect(wider).toBeGreaterThan(208);

  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(store.width).toBeLessThan(wider);
});

test('a key the handle does not own is left alone', async () => {
  const handle = await mount();
  fireEvent.keyDown(handle, { key: 'ArrowDown' });
  expect(store.width).toBeNull();
});

// Held against the clamp rather than the step, so this says the arrows stop at an
// end rather than how far each one travels.
test('the arrows stop at the narrowest the sidebar goes', async () => {
  const handle = await mount();
  for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(store.width).toBe(160);
});

// The pointer's own x is the width outright, the sidebar being the first column of the
// shell, so this is the whole of the drag.
test('a drag takes the edge to where the pointer is', async () => {
  const handle = await mount();

  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 208 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 320 });
  expect(store.width).toBe(320);

  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 240 });
  expect(store.width).toBe(240);

  // Let go, and the handle stops following - a pointer that wanders back over it is
  // not still dragging.
  fireEvent.pointerUp(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
  expect(store.width).toBe(240);
});

test('a drag past either end stops at it', async () => {
  const handle = await mount();
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 208 });

  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });
  expect(store.width).toBe(160);

  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 });
  expect(store.width).toBe(520);
});

test('a pointer that never took the handle does not move it', async () => {
  const handle = await mount();
  // A pointer crossing the handle on its way somewhere else, with no `pointerdown` to
  // claim it: the case the capture guard is there for.
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
  expect(store.width).toBeNull();
});
