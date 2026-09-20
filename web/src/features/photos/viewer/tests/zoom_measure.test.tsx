// When the zoom measures the box it is fitting a picture into.
//
// The stage does not always exist on the render that creates the hook - the merge page shows its
// analysing state first, and its stage arrives with the recipe. A ref object is the same object
// before and after, so an effect keyed on one runs once, against nothing, and never again: the box
// stays at no extent, `fit` stays null, and with it go the percentage readout and the 100% stop a
// reader needs to judge a seam.
import { afterEach, expect, test } from 'bun:test';
import { useRef, useState } from 'react';
import { registerDom } from '../../../../test_dom';
import type { Size, ZoomPan } from '../zoom_pan';

registerDom();
const { act, cleanup, render } = await import('@testing-library/react');
const { DOUBLE_SCALE, MIN_SCALE, percentOf, useZoomPan } = await import('../zoom_pan');

afterEach(cleanup);

// The stubbed box is 200x20, so a frame ten times its width is fitted at a tenth and drawn at its
// own pixels at 10x.
const FRAME: Size = { width: 2000, height: 200 };

interface Seen {
  zoom: ZoomPan;
  show(): void;
}

function Late({ seen }: { seen: Seen }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  seen.zoom = useZoomPan(viewport, viewport, FRAME);
  seen.show = () => setShown(true);
  if (!shown) return <p>analysing</p>;
  return <div ref={viewport} style={{ width: 200, height: 20 }} />;
}

test('the stage is measured when it arrives, not only if it was there first', () => {
  const seen = {} as Seen;
  render(<Late seen={seen} />);
  expect(seen.zoom.fit).toBeNull();

  act(() => seen.show());

  expect(seen.zoom.fit).toBeCloseTo(0.1, 6);
  expect(seen.zoom.box).toEqual({ width: 200, height: 20 });
});

test('so the readout has a percentage to say and the ladder a 100% stop to climb to', () => {
  const seen = {} as Seen;
  render(<Late seen={seen} />);
  act(() => seen.show());

  const fit = seen.zoom.fit;
  expect(fit).not.toBeNull();
  expect(percentOf(MIN_SCALE, fit!)).toBe(10);
  expect(seen.zoom.nativeScale).toBeCloseTo(10, 6);
  expect(seen.zoom.nextStop).toBe(DOUBLE_SCALE);
  expect(seen.zoom.stopAfter(DOUBLE_SCALE)).toBeCloseTo(10, 6);
});
