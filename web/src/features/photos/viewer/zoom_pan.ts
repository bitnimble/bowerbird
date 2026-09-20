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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const MIN_SCALE = 1; // 1 = fitted to the stage
// The zoom control's middle stop; its third is the frame's own pixel scale.
export const DOUBLE_SCALE = 2;
const MAX_NATIVE_MULTIPLE = 2;

/**
 * Twice fitted is the floor, for the frame smaller than the stage: 200% of its own
 * pixels is less than fitted there, and taking it at face value leaves a picture
 * that cannot be zoomed at all.
 */
export function maxScaleFor(nativeScale: number): number {
  return Math.max(DOUBLE_SCALE, MAX_NATIVE_MULTIPLE * nativeScale);
}

/**
 * A view scale as the percentage the readout and the slider speak, and back.
 *
 * `fit` is the scale the frame is drawn at when the view is fitted, so `fit * scale`
 * is how many CSS pixels one image pixel covers: 100% is 1:1 whatever the stage is.
 */
export function percentOf(scale: number, fit: number): number {
  return Math.round(fit * scale * 100);
}

export function scaleOf(percent: number, fit: number): number {
  return percent / 100 / fit;
}

const WHEEL_SENSITIVITY = 0.0015;
// Scales are floats off a division, so "already at this stop" needs slack.
export const STOP_EPSILON = 0.001;
// How far a pointer may travel and still count as a click rather than a drag.
export const CLICK_SLOP_PX = 4;
/** `PointerEvent.button` for the wheel pressed in. */
export const MIDDLE_BUTTON = 1;

/** As the hook measures it, so a surface arbitrating against the pan draws the same line. */
export function travelOf(dx: number, dy: number): number {
  return Math.abs(dx) + Math.abs(dy);
}

interface Point {
  x: number;
  y: number;
}

function gap(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

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
  // A box of no extent is a box this cannot clamp against, exactly as a missing one is:
  // taken at face value it says nothing fits and pulls the offset to zero, which would jump
  // a zoomed photo back to the middle. It is what the observer holds before it first fires.
  if (box == null || box.width === 0 || box.height === 0) return view;
  if (natural.width === 0 || natural.height === 0) return view;
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

/**
 * The bare stage a view leaves on each side, which is what anything pinned to a corner of the
 * *photograph* rather than of the viewport is inset by.
 *
 * At the view's scale, so zooming in eats the letterbox as the picture grows into it. An axis
 * with room to spare cannot be panned (`panLimit` is zero there), so the picture stays centred
 * and the two sides of it are equal.
 */
export function letterboxOf(view: View, box: Size, natural: Size): { x: number; y: number } {
  if (box.width === 0 || box.height === 0 || natural.width === 0 || natural.height === 0) {
    return { x: 0, y: 0 };
  }
  const covered = fitScale(box, natural) * view.scale;
  return {
    x: Math.max(0, (box.width - natural.width * covered) / 2),
    y: Math.max(0, (box.height - natural.height * covered) / 2),
  };
}

/**
 * Where a point in the frame's own pixels lands in the viewport box, in CSS pixels from its
 * top left - the transform the merge page's view is drawn with, read forwards.
 *
 * What anything pinned to a *place in the picture* rather than to the stage is positioned by,
 * and it is arithmetic over the view and the observed box, so nothing has to be measured to
 * follow a pan or a zoom. `regionOf` is the same mapping the other way.
 */
export function stagePointOf(point: { x: number; y: number }, view: View, box: Size, natural: Size): Point {
  if (box.width === 0 || box.height === 0 || natural.width === 0 || natural.height === 0) {
    return { x: 0, y: 0 };
  }
  const covered = fitScale(box, natural) * view.scale;
  return {
    x: box.width / 2 + view.x + (point.x - natural.width / 2) * covered,
    y: box.height / 2 + view.y + (point.y - natural.height / 2) * covered,
  };
}

/** `stagePointOf` read backwards: where a point on the stage lands in the frame's own pixels. */
export function framePointOf(point: Point, view: View, box: Size, natural: Size): Point {
  if (box.width === 0 || box.height === 0 || natural.width === 0 || natural.height === 0) {
    return { x: 0, y: 0 };
  }
  const covered = fitScale(box, natural) * view.scale;
  return {
    x: (point.x - box.width / 2 - view.x) / covered + natural.width / 2,
    y: (point.y - box.height / 2 - view.y) / covered + natural.height / 2,
  };
}

export const NO_SIZE: Size = { width: 0, height: 0 };

/**
 * The stop a click or the zoom button moves to next: fitted, twice that, then the frame's own
 * pixels, and round to fitted again.
 *
 * Sorted rather than listed in that order, because a render smaller than the stage is already
 * past 1:1 once it is fitted and for those two the 100% stop is the nearer one.
 *
 * Out here rather than in the hook so the ladder can be climbed without a browser: what it is
 * is arithmetic over two numbers, and it was only reachable through a Playwright click.
 */
export function nextStopAfter(scale: number, nativeScale: number): number {
  return (
    [DOUBLE_SCALE, nativeScale]
      .filter((stop) => stop > MIN_SCALE)
      .sort((a, b) => a - b)
      .find((stop) => stop > scale + STOP_EPSILON) ?? MIN_SCALE
  );
}

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
  /** The scale that draws one source pixel per CSS pixel. */
  nativeScale: number;
  /** The furthest in a zoom goes, which is also the top of the slider that drives it. */
  maxScale: number;
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
 *
 * `enabled` turns the gesture off without unmounting the surface, for a tool that wants the
 * view held still under it. It has to be the hook's own: the wheel is a native listener on
 * `gestures`, so a caller that only declines to spread `handlers` still zooms.
 *
 * `drags` false leaves one pointer to a tool that draws with it: a drag no longer pans and a
 * click no longer steps the zoom, while the wheel, a pinch and a middle-button drag still do.
 */
export function useZoomPan(
  viewport: React.RefObject<HTMLElement | null>,
  gestures: React.RefObject<HTMLElement | null>,
  size: Size,
  onGestureEnd?: (travel: { dx: number; dy: number; zoomed: boolean }) => void,
  enabled = true,
  drags = true,
): ZoomPan {
  // Held by its extent rather than by the object it arrived in. A caller that builds the
  // size inline - which is the natural way to write it from a store - hands over a new
  // object every render, and everything below that depends on it would be rebuilt: the
  // wheel listener detaches and reattaches on each one, and in the editor that is every
  // frame of a drag. Cheaper to be indifferent to it here than to require every caller to
  // remember.
  const natural = useMemo(
    () => ({ width: size.width, height: size.height }),
    [size.width, size.height],
  );

  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState<Size>(NO_SIZE);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  // How far the pointer travelled in the gesture that just ended, which is what
  // separates the click that closes a tap from the one that closes a drag.
  const travelled = useRef(0);
  // Every finger on the glass, not just the one that started the gesture: a pinch
  // is the distance between two of them, and the second one is by definition not
  // the primary.
  const pointers = useRef(new Map<number, Point>());
  // The spread and the scale a pinch began at, so the scale follows the fingers
  // absolutely rather than accumulating rounding from each move - and the two it
  // was measured between, because any other pair is a different distance and would
  // rescale the picture by the ratio between two unrelated gaps.
  const pinch = useRef<{ spread: number; scale: number; ids: [number, number] } | null>(null);
  // A pinch ends in the same pointerup a swipe would be read out of, and on a
  // phone in a click as well. Neither is what the reader did.
  const pinched = useRef(false);
  // The primary press in flight, and how to stop watching it for the move that makes it a drag.
  const press = useRef<{ id: number; release: () => void } | null>(null);
  // The viewport's rect, measured once for the gesture that is using it.
  //
  // `zoomTo` pins a point, so it wants the origin as well as the extent and cannot read the
  // observed box - and a pinch calls it once per move, at the rate of the fingers, in a handler
  // whose previous frame wrote an inline transform. Measuring there is a forced style
  // recalculation per frame, which is what a phone feels as the picture lagging behind the
  // hand. Nothing can move the viewport under a gesture except a resize, and that is observed.
  const gestureRect = useRef<DOMRect | null>(null);

  const zoomed = view.scale > MIN_SCALE;
  const fit = natural.width === 0 || box.width === 0 ? null : fitScale(box, natural);
  // The view scale that draws one image pixel per CSS pixel.
  const nativeScale = fit == null ? MIN_SCALE : 1 / fit;

  const reset = useCallback(() => setView(FITTED), []);

  // Every render, with no dependency array, because there is nothing to key this on: a ref object
  // is the same object before and after its element exists, so a surface whose stage arrives on a
  // later render - the merge page shows its analysing state first - would observe nothing, forever,
  // and `fit` would stay null for the life of the page. What the identity check below costs is a
  // comparison per render; what it buys is that the observer follows the element it is about.
  const observed = useRef<{ element: HTMLElement; observer: ResizeObserver } | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (observed.current?.element === element) return;
    observed.current?.observer.disconnect();
    observed.current = null;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    observed.current = { element, observer };
  });

  useEffect(
    () => () => {
      observed.current?.observer.disconnect();
      observed.current = null;
      press.current?.release();
    },
    [],
  );

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
    // Whatever a gesture in flight cached is of a viewport that has since moved.
    gestureRect.current = null;
    if (natural.width === 0 || box.width === 0) return;
    setView((currentView) => clampPan(currentView, box, natural));
  }, [natural.width, natural.height, box.width, box.height]);

  // Measures here, outside the updater, so the updater itself stays pure.
  const zoomTo = useCallback(
    (nextScale: (current: number) => number, point: { x: number; y: number } | null) => {
      const rect = gestureRect.current ?? viewport.current?.getBoundingClientRect() ?? null;
      const scale = rect == null || natural.width === 0 ? MIN_SCALE : 1 / fitScale(rect, natural);
      const max = maxScaleFor(scale);
      setView((currentView) =>
        clampPan(zoomAbout(currentView, nextScale(currentView.scale), max, rect, point), rect, natural),
      );
    },
    [natural, viewport],
  );

  const stopAfter = useCallback((scale: number): number => nextStopAfter(scale, nativeScale), [nativeScale]);

  // Non-passive so preventDefault actually stops the page scrolling underneath.
  useEffect(() => {
    const stage = gestures.current;
    if (stage == null || !enabled) return;

    function onWheel(e: WheelEvent): void {
      e.preventDefault();
      zoomTo((currentScale) => currentScale * (1 - e.deltaY * WHEEL_SENSITIVITY), {
        x: e.clientX,
        y: e.clientY,
      });
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomTo, gestures, enabled]);

  function onPointerDown(e: React.PointerEvent): void {
    if (!enabled) return;
    // The primary is the first finger of a sequence, so anything still held here is
    // a pointer whose release never arrived - and left in, the next single touch
    // would be read as the second finger of a pinch.
    if (e.isPrimary) pointers.current.clear();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const [first, second] = pointers.current.size < 2 ? [] : [...pointers.current.entries()];
    if (first != null && second != null) {
      // A pinch already under way keeps the pair it started with: a third finger
      // landing beside it is not a reason to re-measure the two that are pinching.
      if (pinch.current == null) {
        // The pan the first finger had started is over: from here the two of them
        // scale the picture, and continuing to follow one would fight the other.
        setDragging(false);
        pinch.current = { spread: gap(first[1], second[1]), scale: view.scale, ids: [first[0], second[0]] };
        // Once, here, for every move the pinch is about to make.
        gestureRect.current = viewport.current?.getBoundingClientRect() ?? null;
      }
      pinched.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the moves still arrive: the fingers are over this element */
      }
      return;
    }

    // One gesture at a time: a second finger landing would otherwise restart the
    // one in flight from wherever it touched down, and lift into a step of its own.
    if (!e.isPrimary) return;
    pinched.current = false;
    if (!drags) {
      if (e.button !== MIDDLE_BUTTON) return;
      // The browser's own middle-button autoscroll would otherwise scroll the page under the pan.
      e.preventDefault();
    }
    // Before the zoom check: unzoomed, where nothing pans, this is still where a
    // swipe starts and what tells the tap that ends a swipe from a real tap.
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.x, offsetY: view.y };
    travelled.current = 0;
    // Not captured here, on purpose: capture retargets the following pointer events *and the
    // compatibility click* to this element, so a press that turns out to be a press would have
    // its click taken off whatever it was aimed at - the tile outline under the pointer on the
    // merge page, which is what the reader is pressing. It is taken on the first move past the
    // slop instead, by which point the gesture is a drag and there is no click to protect.
    //
    // Watched on the window, because until it is taken a move only reaches the stage while the
    // pointer is over it: a quick drag's first move can land outside, and the pan never starts.
    press.current?.release();
    const stage = e.currentTarget;
    const id = e.pointerId;
    const onMove = (moved: PointerEvent): void => {
      if (moved.pointerId !== id) return;
      if (travelOf(moved.clientX - dragStart.current.x, moved.clientY - dragStart.current.y) <= CLICK_SLOP_PX) return;
      release();
      try {
        stage.setPointerCapture(id);
      } catch {
        /* the moves keep arriving while the pointer is over this element */
      }
    };
    const release = (): void => window.removeEventListener('pointermove', onMove);
    window.addEventListener('pointermove', onMove);
    press.current = { id, release };
    if (zoomed) setDragging(true);
  }

  // The observed box, not a fresh measurement: a pan emits a move per pointer position and
  // all this needs is the extent, which the observer already holds. `zoomTo` reads the rect
  // because it pins a point and so wants the origin too; this does not.
  function onPointerMove(e: React.PointerEvent): void {
    // A pan can already be in flight when `enabled` goes false: a second finger opening a
    // geometry tool while the first is panning would otherwise keep sliding the photograph
    // out from under a rectangle just laid out for a fitted view.
    if (!enabled) return;
    const tracked = pointers.current.get(e.pointerId);
    if (tracked != null) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }

    const held = pinch.current;
    if (held != null) {
      const first = pointers.current.get(held.ids[0]);
      const second = pointers.current.get(held.ids[1]);
      if (first == null || second == null) return;
      const spread = gap(first, second);
      // About the midpoint, so the picture stays under the fingers and a pinch
      // that slides across the frame pans it as it scales.
      if (spread > 0 && held.spread > 0) zoomTo(() => (held.scale * spread) / held.spread, midpoint(first, second));
      return;
    }

    if (!dragging) return;
    setView((currentView) =>
      clampPan(
        {
          scale: currentView.scale,
          x: dragStart.current.offsetX + (e.clientX - dragStart.current.x),
          y: dragStart.current.offsetY + (e.clientY - dragStart.current.y),
        },
        box,
        natural,
      ),
    );
  }

  // Not a gesture the reader completed: the browser took the pointer, so end the
  // drag without reading a step out of where it stopped.
  function onPointerCancel(e: React.PointerEvent): void {
    pointers.current.delete(e.pointerId);
    if (press.current?.id === e.pointerId) {
      press.current.release();
      press.current = null;
    }
    // A pinch is over when either of *its* fingers goes, whatever else is still down:
    // the fingers left behind are a different distance apart and the picture would
    // jump by the ratio between the two gaps.
    if (pinch.current?.ids.includes(e.pointerId) === true) {
      pinch.current = null;
      gestureRect.current = null;
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
    setDragging(false);
  }

  function onPointerUp(e: React.PointerEvent): void {
    // Whichever finger of a pinch lifts first ends it, and neither ends it in a step: two
    // fingers spread across the frame travel as far as a swipe does. `pinched` as well as the
    // pinch itself, because the first lift clears the pinch and the finger left behind would
    // then be read against a `dragStart` from before the second one ever landed.
    if (pinch.current != null || pinched.current) {
      onPointerCancel(e);
      return;
    }
    // Before ending anything. `onPointerDown` ignores a second finger so it cannot restart
    // the gesture in flight, but the release was ending it for everyone: a second finger
    // tapped and lifted while the first was still panning cleared `dragging`, and the photo
    // stopped following a finger that had never left the glass.
    if (!e.isPrimary) {
      // Dropped here too, or a finger that lifted while the gesture was disabled stays in
      // the map and pairs its last position into the next pinch's baseline.
      pointers.current.delete(e.pointerId);
      // Its own capture, if it somehow took one; the primary's is by pointer id and is left
      // exactly where it was.
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing was captured for this one */
      }
      return;
    }
    onPointerCancel(e);
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    travelled.current = travelOf(dx, dy);
    onGestureEnd?.({ dx, dy, zoomed });
  }

  // A drag ends in a click event too, so only treat it as a zoom step when the
  // gesture it ends barely moved - a swipe that lands on the next photo must not
  // zoom it, and a pan must not un-zoom.
  function onClick(e: React.MouseEvent): void {
    // A pinch lifts its last finger into a click, and one whose fingers scaled about a still
    // midpoint has travelled nothing to disqualify it. Spent here, so the next real tap steps
    // the zoom as it always did.
    if (pinched.current) {
      pinched.current = false;
      return;
    }
    if (!enabled || !drags || dragging || travelled.current > CLICK_SLOP_PX) return;
    zoomTo(stopAfter, { x: e.clientX, y: e.clientY });
  }

  return {
    view,
    zoomed,
    dragging,
    box,
    fit,
    nativeScale,
    maxScale: maxScaleFor(nativeScale),
    nextStop: stopAfter(view.scale),
    reset,
    zoomTo,
    stopAfter,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
  };
}
