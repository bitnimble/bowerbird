// The zoom's range as the menu offers it: what the track spans, and the way back to fitted.
//
// Read off the rendered control rather than the props, the percentage being this component's
// own arithmetic. Dragging it is not here: Base UI's slider does not answer a pointer or a
// keypress outside a real browser (see `raw_edit_panel.test.tsx`).
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import type { View, ZoomPan } from '../zoom_pan';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { ZoomSlider } = await import('../zoom_control');
const { FITTED, maxScaleFor } = await import('../zoom_pan');

afterEach(cleanup);

// A frame ten times the stage: fitted is 10% of its own pixels, so the track runs 10 to 200.
const NATIVE = 10;

function zoomOf(view: View, reset: () => void = () => undefined): ZoomPan {
  return {
    view,
    zoomed: view.scale > 1,
    dragging: false,
    box: { width: 1000, height: 800 },
    fit: 1 / NATIVE,
    nativeScale: NATIVE,
    maxScale: maxScaleFor(NATIVE),
    nextStop: 2,
    reset,
    zoomTo: () => undefined,
    stopAfter: (scale) => scale,
    handlers: {
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerCancel: () => undefined,
      onClick: () => undefined,
    },
  };
}

test('the track runs from fitted to twice the frame\'s own pixels', () => {
  render(<ZoomSlider zoom={zoomOf(FITTED)} />);

  // By its name, which is on the input that carries the value: a name left on the
  // control around it announces nothing.
  const slider = screen.getByRole('slider', { name: 'Zoom' }) as HTMLInputElement;
  expect(slider.min).toBe('10');
  expect(slider.max).toBe('200');
  expect(slider.value).toBe('10');
  // Neither control may be tabbed to: they sit in a menu popup, and the first
  // tabbable element there takes the focus the menu's own items need.
  expect(slider.tabIndex).toBe(-1);
  expect(screen.getByRole('button', { name: 'Fit' }).tabIndex).toBe(-1);
});

test('the readout the track carries is the scale in the frame\'s own pixels', () => {
  render(<ZoomSlider zoom={zoomOf({ scale: NATIVE, x: 0, y: 0 })} />);

  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('100');
});

test('Fit is the way back, and is spent once the view is already there', () => {
  let reset = 0;
  const { rerender } = render(<ZoomSlider zoom={zoomOf({ scale: 4, x: 0, y: 0 }, () => (reset += 1))} />);

  fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
  expect(reset).toBe(1);

  rerender(<ZoomSlider zoom={zoomOf(FITTED)} />);
  expect((screen.getByRole('button', { name: 'Fit' }) as HTMLButtonElement).disabled).toBe(true);
});
