// Which of the two a press turns out to be, and what the hook does about it.
//
// Pointer capture is the whole of the decision. Captured, the browser retargets every following
// pointer event *and the compatibility click* to the capturing element - so a stage that captures
// on pointerdown eats the click on whatever was under the pointer, which on the merge page is the
// tile outline the reader was aiming at. Taken on the first move past the slop instead, a press
// that goes nowhere never captures and the click lands where it was aimed, while a drag still
// holds the pointer for the pan.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { registerDom } from '../../../../test_dom';
import type { Size } from '../zoom_pan';

registerDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { useZoomPan } = await import('../zoom_pan');

afterEach(cleanup);

const FRAME: Size = { width: 2000, height: 200 };

const captured: number[] = [];
beforeEach(() => (captured.length = 0));

function Probe(): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const zoom = useZoomPan(viewport, viewport, FRAME);
  return <div ref={viewport} style={{ width: 200, height: 20 }} {...zoom.handlers} />;
}

// On the instance rather than the prototype: jsdom has no pointer capture at all, and a stub left
// on `Element` would be there for every other suite this runner shares a process with.
function open(): HTMLElement {
  const frame = render(<Probe />).container.firstElementChild as HTMLElement;
  Object.assign(frame, {
    setPointerCapture: (id: number) => captured.push(id),
    releasePointerCapture: () => undefined,
  });
  return frame;
}

const down = (frame: HTMLElement, pointerId: number, x: number, isPrimary = true): void => {
  fireEvent.pointerDown(frame, { pointerId, clientX: x, clientY: 10, isPrimary });
};
const move = (frame: HTMLElement, pointerId: number, x: number): void => {
  fireEvent.pointerMove(frame, { pointerId, clientX: x, clientY: 10, isPrimary: pointerId === 1 });
};
const up = (frame: HTMLElement, pointerId: number, x: number): void => {
  fireEvent.pointerUp(frame, { pointerId, clientX: x, clientY: 10, isPrimary: pointerId === 1 });
};

test('a press that goes nowhere takes no capture, so the click reaches what is under it', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 100);
    // Inside the slop: a hand resting on a mouse button moves this far.
    move(frame, 1, 102);
    up(frame, 1, 102);
  });

  expect(captured).toEqual([]);
});

test('a press that becomes a drag takes it, so the pan survives the pointer leaving the stage', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 100);
    move(frame, 1, 140);
    up(frame, 1, 140);
  });

  expect(captured).toEqual([1]);
});

// A quick drag's first move can already be off the stage, where the stage's own handler never
// hears it; without the capture nothing after it arrives either, and the pan never starts.
test('a drag whose first move lands off the stage still takes it', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 100);
    move(document.body, 1, 900);
  });

  expect(captured).toEqual([1]);
});

test('and takes it once, not once a move', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 100);
    move(frame, 1, 140);
    move(frame, 1, 160);
    move(frame, 1, 180);
    up(frame, 1, 180);
  });

  expect(captured).toEqual([1]);
});

// A pinch is never a click, so there is nothing to keep out of its way and the fingers are worth
// holding from the moment the second one lands.
test('a second finger captures at once', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 90);
    down(frame, 2, 110, false);
  });

  expect(captured).toContain(2);
});

// The next press is a press of its own: a drag that captured must not leave the decision made.
test('a drag does not leave the next press captured', () => {
  const frame = open();

  act(() => {
    down(frame, 1, 100);
    move(frame, 1, 140);
    up(frame, 1, 140);
  });
  captured.length = 0;

  act(() => {
    down(frame, 1, 100);
    up(frame, 1, 100);
  });

  expect(captured).toEqual([]);
});
