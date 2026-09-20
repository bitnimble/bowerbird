// Two fingers on the glass, and what the hook makes of them.
//
// A pinch is bookkeeping over pointer events - which ids are down, what they were apart at
// the start, which of them the scale should follow - and none of that needs a GPU or a real
// photograph. What a browser is still needed for is that a touch produces these events at
// all, which `mobile.spec.ts` covers once.
import { afterEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { registerDom } from '../../../../test_dom';
import type { Size } from '../zoom_pan';

registerDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { useZoomPan } = await import('../zoom_pan');

afterEach(cleanup);

// The stub box is 200x20 and a frame ten times its width is what a stage really holds, so
// fitted is a tenth and there is room to zoom.
const FRAME: Size = { width: 2000, height: 200 };

interface Seen {
  scale: number;
  steps: { dx: number; dy: number; zoomed: boolean }[];
}

function Probe({ seen }: { seen: Seen }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const zoom = useZoomPan(viewport, viewport, FRAME, (travel) => seen.steps.push(travel));
  seen.scale = zoom.view.scale;
  return <div ref={viewport} style={{ width: 200, height: 20 }} {...zoom.handlers} />;
}

function open(): { frame: HTMLElement; seen: Seen } {
  const seen: Seen = { scale: 1, steps: [] };
  const { container } = render(<Probe seen={seen} />);
  return { frame: container.firstElementChild as HTMLElement, seen };
}

// `fireEvent` builds a PointerEvent from what it is given, and the hook reads exactly these.
const down = (frame: HTMLElement, pointerId: number, x: number, isPrimary: boolean): void => {
  fireEvent.pointerDown(frame, { pointerId, clientX: x, clientY: 10, isPrimary });
};
const move = (frame: HTMLElement, pointerId: number, x: number): void => {
  fireEvent.pointerMove(frame, { pointerId, clientX: x, clientY: 10, isPrimary: pointerId === 1 });
};
const up = (frame: HTMLElement, pointerId: number, x: number): void => {
  fireEvent.pointerUp(frame, { pointerId, clientX: x, clientY: 10, isPrimary: pointerId === 1 });
};

test('two fingers spread the picture by exactly what they spread', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 90, true);
    down(frame, 2, 110, false);
    // 20px apart to 60: three times, which is what the scale has to be.
    move(frame, 1, 70);
    move(frame, 2, 130);
  });

  expect(seen.scale).toBeCloseTo(3, 5);
});

test('and pinching back in returns the picture to fitted', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 70, true);
    down(frame, 2, 130, false);
    move(frame, 1, 95);
    move(frame, 2, 105);
  });

  expect(seen.scale).toBe(1);
});

/**
 * The bug this exists for: a third finger, or one of three lifting, leaves a pair the
 * baseline says nothing about.
 *
 * Reading "the first two" out of the map regardless of how many are down took the spread
 * between whichever two those now were, so a palm landing beside a pinch - or the first
 * finger of three coming off - snapped a zoomed picture straight back to fitted.
 */
test('a third finger does not rescale the picture', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 70, true);
    down(frame, 2, 130, false);
    move(frame, 1, 50);
    move(frame, 2, 150);
  });
  const held = seen.scale;
  expect(held).toBeGreaterThan(1);

  act(() => {
    down(frame, 3, 155, false);
    move(frame, 3, 156);
    up(frame, 1, 50);
    move(frame, 3, 157);
  });

  expect(seen.scale).toBe(held);
});

test('the fingers of a pinch lift without stepping to another photograph', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 20, true);
    down(frame, 2, 40, false);
    // Both fingers travel far enough across the frame to read as a swipe, were either of
    // them a swipe.
    move(frame, 1, 120);
    move(frame, 2, 140);
    up(frame, 1, 120);
    up(frame, 2, 140);
  });

  expect(seen.steps).toEqual([]);
});

test('and the click that closes a pinch does not step the zoom on top of it', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 90, true);
    down(frame, 2, 110, false);
    move(frame, 1, 70);
    move(frame, 2, 130);
    up(frame, 2, 130);
    up(frame, 1, 70);
  });
  const held = seen.scale;

  act(() => {
    fireEvent.click(frame, { clientX: 100, clientY: 10 });
  });

  expect(seen.scale).toBe(held);
});

test('a tap after a pinch still steps the zoom', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 90, true);
    down(frame, 2, 110, false);
    up(frame, 2, 110);
    up(frame, 1, 90);
    fireEvent.click(frame, { clientX: 100, clientY: 10 });
  });
  const held = seen.scale;

  act(() => {
    down(frame, 1, 100, true);
    up(frame, 1, 100);
    fireEvent.click(frame, { clientX: 100, clientY: 10 });
  });

  expect(seen.scale).toBeGreaterThan(held);
});

// A press whose release never arrived, which is what a browser does when it takes the
// pointer for a gesture of its own. Left in the map, its last position pairs into the next
// pinch's baseline and the following touch scales the picture by an arbitrary amount.
test('a stale pointer is dropped when a fresh gesture starts', () => {
  const { frame, seen } = open();

  act(() => {
    down(frame, 1, 100, true);
    // No pointerup: the sequence simply ends.
    down(frame, 1, 20, true);
    move(frame, 1, 60);
    up(frame, 1, 60);
  });

  expect(seen.scale).toBe(1);
  expect(seen.steps).toHaveLength(1);
});
