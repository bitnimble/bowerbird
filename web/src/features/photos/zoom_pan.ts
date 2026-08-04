// Fit, zoom and pan, apart from what is being zoomed.
//
// Two surfaces show a photograph now and both have to feel the same: the viewer's `<img>`,
// which applies this as a CSS transform, and the editor's WebGPU canvas, which cannot -
// there is no element to transform, only a region to redraw at (`raw_edit_stage.tsx`). The
// gesture is the same gesture either way, so it lives here and each surface says what to do
// with the result.
//
// The maths is pure and takes the viewport box as an argument rather than measuring it, so
// it is safe to run inside a React state updater - which is where it has to run, since
// zooming about a point reads the current offset to compute the next one.
import { useCallback, useEffect, useRef, useState } from 'react';

export const MIN_SCALE = 1; // 1 = fitted to the stage
// The zoom control's middle stop; its third is the frame's own pixel scale.
export const DOUBLE_SCALE = 2;
// The ceiling, unless 1:1 is higher, in which case that is. A flat multiple of
// the fitted size on its own meant a 3840px render in a 430px stage topped out
// at 86% and could not be pixel-peeped at all; the multiple is still the floor,
// so a frame smaller than the stage can be pushed past its own pixels.
export const FLOOR_MAX_SCALE = 8;
const WHEEL_SENSITIVITY = 0.0015;
// Scales are floats off a division, so "already at this stop" needs slack.
export const STOP_EPSILON = 0.001;
// How far a pointer may travel and still count as a click rather than a drag.
const CLICK_SLOP_PX = 4;

// Scale and pan are one value, not two pieces of state. Zooming about a point
// has to read the current offset to compute the next one, and doing that by
// calling setOffset from inside a setScale updater made the maths run twice
// (React re-invokes updaters), landing the photo at roughly double the offset.
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const FITTED: View = { scale: MIN_SCALE, x: 0, y: 0 };

export interface Size {
  width: number;
  height: number;
}

// How much of the photo is off-screen on each axis at this scale, halved: past
// that the image would separate from the viewport edge and drag out of view.
function panLimit(viewport: number, content: number): number {
  return Math.max(0, (content - viewport) / 2);
}

// The photo is drawn with object-fit: contain, so one image pixel covers this
// many CSS pixels before the zoom is applied.
export function fitScale(box: Size, natural: Size): number {
  return Math.min(box.width / natural.width, box.height / natural.height);
}

// `box` is passed in rather than measured here so the caller does the layout
// read, keeping this a pure function safe to run inside a state updater.
//
// A `Size` rather than a `DOMRect`, because only the extent matters here and that lets the
// observed box be used where a fresh measurement would otherwise be taken. `zoomAbout` does
// need the rect - it pins a point, so it wants the origin too.
export function clampPan(view: View, box: Size | null, natural: Size): View {
  if (box == null || natural.width === 0 || natural.height === 0) return view;
  const fit = fitScale(box, natural);
  const maxX = panLimit(box.width, natural.width * fit * view.scale);
  const maxY = panLimit(box.height, natural.height * fit * view.scale);
  return {
    scale: view.scale,
    x: Math.max(-maxX, Math.min(maxX, view.x)),
    y: Math.max(-maxY, Math.min(maxY, view.y)),
  };
}

// Zooms so the content under (clientX, clientY) stays under it. transform-origin
// is the centre, so with d = pointer - centre the offset that pins the point is
// d - (next/current) * (d - offset); without it every zoom drifts to the middle.
export function zoomAbout(
  view: View,
  next: number,
  max: number,
  box: DOMRect | null,
  point: { x: number; y: number } | null,
): View {
  const scale = Math.min(max, Math.max(MIN_SCALE, next));
  if (scale === MIN_SCALE) return FITTED;
  if (box == null || point == null) return { ...view, scale };
  const dx = point.x - (box.left + box.width / 2);
  const dy = point.y - (box.top + box.height / 2);
  const ratio = scale / view.scale;
  return { scale, x: dx - ratio * (dx - view.x), y: dy - ratio * (dy - view.y) };
}

/**
 * The part of the frame a view is showing, in source pixels.
 *
 * What the `<img>` gets for free by being transformed, the canvas has to be told: it draws
 * whatever rectangle it is given at whatever size it is given, so the gesture has to become
 * a rectangle before it means anything there.
 *
 * Held inside the frame, because the draw clamps its taps to the frame's edges anyway and a
 * region that hangs over the side would only read the edge pixel repeatedly.
 */
export function regionOf(view: View, box: Size, natural: Size): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (box.width === 0 || box.height === 0 || natural.width === 0 || natural.height === 0) {
    return { x: 0, y: 0, width: natural.width, height: natural.height };
  }
  const covered = fitScale(box, natural) * view.scale;
  const width = Math.min(natural.width, box.width / covered);
  const height = Math.min(natural.height, box.height / covered);
  // The pan moves the picture under the viewport, so the viewport moves the other way over
  // the picture.
  const x = (natural.width - width) / 2 - view.x / covered;
  const y = (natural.height - height) / 2 - view.y / covered;
  return {
    x: Math.max(0, Math.min(natural.width - width, x)),
    y: Math.max(0, Math.min(natural.height - height, y)),
    width,
    height,
  };
}

export const NO_SIZE: Size = { width: 0, height: 0 };

/** What a surface has to give this to be zoomable, and what it gets back. */
export interface ZoomPan {
  view: View;
  zoomed: boolean;
  dragging: boolean;
  /**
   * The viewport, observed rather than measured on demand: the scale readout is rendered
   * every frame of a wheel zoom, and reading the box there would be a layout read in the
   * hottest path either surface has.
   */
  box: Size;
  /** Null until the frame is known and the stage measured, which the readout waits on. */
  fit: number | null;
  /** The scale that draws one source pixel per CSS pixel, and the zoom ceiling's floor. */
  nativeScale: number;
  /** The stop a click or the zoom button moves to next, `MIN_SCALE` to round back to fit. */
  nextStop: number;
  reset(): void;
  zoomTo(nextScale: (current: number) => number, point: { x: number; y: number } | null): void;
  stopAfter(scale: number): number;
  /** Spread onto the element the gesture happens over. */
  handlers: {
    onPointerDown(e: React.PointerEvent): void;
    onPointerMove(e: React.PointerEvent): void;
    onPointerUp(e: React.PointerEvent): void;
    onPointerCancel(e: React.PointerEvent): void;
    onClick(e: React.MouseEvent): void;
  };
}

/**
 * The gesture, over whatever is being shown.
 *
 * `viewport` is the box the picture is fitted into and `gestures` the element the pointer
 * and wheel land on; in the viewer they are nested, and elsewhere they may be the same
 * element. `natural` is the frame's own size in pixels - the decoded image's, or the RAW's.
 *
 * `onGestureEnd` reports how far a completed gesture travelled, and whether it happened
 * zoomed - which is all the viewer needs to read a swipe out of one. What a swipe *means*
 * stays with the surface, because only it knows.
 */
export function useZoomPan(
  viewport: React.RefObject<HTMLElement | null>,
  gestures: React.RefObject<HTMLElement | null>,
  natural: Size,
  onGestureEnd?: (travel: { dx: number; dy: number; zoomed: boolean }) => void,
): ZoomPan {
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState<Size>(NO_SIZE);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  // How far the pointer travelled in the gesture that just ended, which is what
  // separates the click that closes a tap from the one that closes a drag.
  const travelled = useRef(0);

  const zoomed = view.scale > MIN_SCALE;
  const fit = natural.width === 0 || box.width === 0 ? null : fitScale(box, natural);
  // The view scale that draws one image pixel per CSS pixel.
  const nativeScale = fit == null ? MIN_SCALE : 1 / fit;

  const reset = useCallback(() => setView(FITTED), []);

  useEffect(() => {
    const element = viewport.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport]);

  // An offset that was legal a moment ago and is not now. `clampPan` is otherwise applied
  // only while zooming or panning, so without this the photo stays out of range until the
  // next drag - which then snaps it, having moved nothing until it had eaten the excess.
  //
  // Two ways that happens, and the box is the one that was missed. Flipping to a
  // differently-shaped frame is the obvious one. The other is the viewport changing shape
  // under a view that did not: the pan limit is `(content - viewport) / 2`, so widening the
  // stage on an axis the fit is not bound by shrinks the limit while the offset stays where
  // it was. Hiding the detail panels beside a portrait photo does exactly that, and going
  // fullscreen does far more of it.
  useEffect(() => {
    if (natural.width === 0 || box.width === 0) return;
    setView((currentView) => clampPan(currentView, box, natural));
  }, [natural.width, natural.height, box.width, box.height]);

  // Measures here, outside the updater, so the updater itself stays pure.
  const zoomTo = useCallback(
    (nextScale: (current: number) => number, point: { x: number; y: number } | null) => {
      const rect = viewport.current?.getBoundingClientRect() ?? null;
      const scale = rect == null || natural.width === 0 ? MIN_SCALE : 1 / fitScale(rect, natural);
      const max = Math.max(FLOOR_MAX_SCALE, scale);
      setView((currentView) =>
        clampPan(zoomAbout(currentView, nextScale(currentView.scale), max, rect, point), rect, natural),
      );
    },
    [natural, viewport],
  );

  // Fitted, twice that, then the frame's own pixels, and round to fitted again.
  // Sorted rather than listed in that order: a render smaller than the stage is
  // already past 1:1 once it is fitted, so for those two the 100% stop is the
  // nearer one.
  const stopAfter = useCallback(
    (scale: number): number =>
      [DOUBLE_SCALE, nativeScale]
        .filter((stop) => stop > MIN_SCALE)
        .sort((a, b) => a - b)
        .find((stop) => stop > scale + STOP_EPSILON) ?? MIN_SCALE,
    [nativeScale],
  );

  // Non-passive so preventDefault actually stops the page scrolling underneath.
  useEffect(() => {
    const stage = gestures.current;
    if (stage == null) return;

    function onWheel(e: WheelEvent): void {
      e.preventDefault();
      zoomTo((currentScale) => currentScale * (1 - e.deltaY * WHEEL_SENSITIVITY), {
        x: e.clientX,
        y: e.clientY,
      });
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomTo, gestures]);

  function onPointerDown(e: React.PointerEvent): void {
    // One gesture at a time: a second finger landing would otherwise restart the
    // one in flight from wherever it touched down, and lift into a step of its own.
    if (!e.isPrimary) return;
    // Before the zoom check: unzoomed, where nothing pans, this is still where a
    // swipe starts and what tells the tap that ends a swipe from a real tap.
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.x, offsetY: view.y };
    travelled.current = 0;
    // Capture keeps the gesture alive if the pointer leaves the stage, but it
    // throws for a pointer id the browser doesn't consider active. Neither pan
    // nor swipe may depend on it, so a failure here is ignored.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pan still works from the move handler, and the swipe from pointerup */
    }
    if (zoomed) setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent): void {
    if (!dragging) return;
    const rect = viewport.current?.getBoundingClientRect() ?? null;
    setView((currentView) =>
      clampPan(
        {
          scale: currentView.scale,
          x: dragStart.current.offsetX + (e.clientX - dragStart.current.x),
          y: dragStart.current.offsetY + (e.clientY - dragStart.current.y),
        },
        rect,
        natural,
      ),
    );
  }

  // Not a gesture the reader completed: the browser took the pointer, so end the
  // drag without reading a step out of where it stopped.
  function onPointerCancel(e: React.PointerEvent): void {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
    setDragging(false);
  }

  function onPointerUp(e: React.PointerEvent): void {
    onPointerCancel(e);
    if (!e.isPrimary) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    travelled.current = Math.abs(dx) + Math.abs(dy);
    onGestureEnd?.({ dx, dy, zoomed });
  }

  // A drag ends in a click event too, so only treat it as a zoom step when the
  // gesture it ends barely moved - a swipe that lands on the next photo must not
  // zoom it, and a pan must not un-zoom.
  function onClick(e: React.MouseEvent): void {
    if (dragging || travelled.current > CLICK_SLOP_PX) return;
    zoomTo(stopAfter, { x: e.clientX, y: e.clientY });
  }

  return {
    view,
    zoomed,
    dragging,
    box,
    fit,
    nativeScale,
    nextStop: stopAfter(view.scale),
    reset,
    zoomTo,
    stopAfter,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
  };
}
