import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  canvasSizeFor,
  decodeDetail,
  decodedFrame,
  drawInto,
  fittedCanvasSize,
  releaseDetail,
} from './stage_bitmaps';
import { CanvasLost, type Region } from './stage_gpu';
import { fitScale, type Size, type View } from './zoom_pan';
import { styles } from './photo_stage_view.stylex';

/**
 * How much of the frame beyond what is on screen the detail canvas covers, as a fraction of
 * the visible span each way. Panning inside what is already drawn is then the CSS transform
 * moving an element, with nothing decoded or uploaded; only leaving it costs a redraw.
 */
const DETAIL_MARGIN = 0.5;

/** The most a detail canvas may hold, whatever the zoom asks for: 16MP, so 64MB of backing. */
const DETAIL_PIXELS = 4096 * 4096;

/** Below this there is nothing a bigger decode could add, so the fitted frame is left alone. */
const DETAIL_THRESHOLD = 1.05;

/**
 * How long the view has to hold still before the detail canvas is redrawn for it.
 *
 * **A region is a decode, a `copyTo` and a texture upload**, and the redraw also resizes the
 * canvas, which clears it and dirties layout. Done per frame of a pinch - which is what a
 * gesture asks for, every move being a new scale and so a new region - that is three separate
 * faults at once on a phone: the gesture lags behind the fingers, the patch blanks and comes
 * back on every frame of a pan, and for the frame between the draw landing and the state
 * commit that follows it the canvas holds one rectangle's pixels while it is laid out at
 * another's, which reads as the picture stretching.
 *
 * Waiting costs nothing, because the patch already on screen is positioned in the frame's own
 * coordinates and rides the same transform as the picture: it stays registered through the
 * whole gesture and merely softens as the zoom outruns what it holds. So the gesture is smooth
 * and the sharpening happens once, when the reader has stopped and is looking.
 */
const DETAIL_SETTLE_MS = 50;

interface Covered {
  region: Region;
  /** Device pixels per image pixel this was drawn for; a change in zoom is a redraw. */
  density: number;
}

/**
 * The part of the photograph a reader has zoomed into, at the file's own pixels.
 *
 * **The fitted frame is drawn to fit** (`DECODE_CAP`), so magnifying it past that is an
 * upscale of pixels that were thrown away on the way in, rather than the file's own. So
 * past that point the visible part of the file at its own pixels (`decodeDetail`) is drawn
 * here, one image pixel to one device pixel.
 *
 * Inside the picture, so the zoom and pan transform carries it and this only has to say where
 * in the frame it is; and over the fitted frame rather than instead of it, so there is
 * something sharp-enough on screen while the bigger decode is still running.
 */
export function StageDetail({
  source,
  natural,
  box,
  view,
  hidden,
  shown,
  onSharp,
}: {
  source: string;
  natural: Size;
  box: Size;
  view: View;
  hidden: boolean;
  /** False while this is the rendition being swapped to, drawn before it is revealed. */
  shown: boolean;
  /** Whether what this lays over the frame is as sharp as the view asks for, including having nothing to add. */
  onSharp: (source: string, sharp: boolean) => void;
}): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [covered, setCovered] = useState<Covered | null>(null);
  // Replaces the canvas element, for the same reason `StageFrame` has one.
  const [attempt, setAttempt] = useState(0);

  // The view this layer draws for, which lags the one on screen by however long the gesture
  // takes to stop (`DETAIL_SETTLE_MS`). Everything below reads it rather than the live view, so
  // a pan or a pinch moves the transform and nothing else.
  const [resting, setResting] = useState(view);
  useEffect(() => {
    const timer = setTimeout(() => setResting(view), DETAIL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [view]);

  const fit = fitScale(box, natural);
  const density = fit * resting.scale * (typeof window === 'undefined' ? 1 : window.devicePixelRatio);
  // What the fitted frame actually puts on screen, which is not always the cap: a JPEG decodes
  // at the steps its own coding allows, so asking for 4096 of a 9504-pixel file returns 3564 -
  // and a decoder that scales nothing at all returns the whole file, which the canvas under it
  // is then fitted down from (`fittedCanvasSize`). The canvas and not the decode, or a panorama
  // whose AVIF came back whole would claim to be holding every pixel of itself while showing
  // 4096 of them, and this layer would never think there was anything to add.
  const fitted = decodedFrame(source);
  const onScreen = fitted == null ? null : fittedCanvasSize(fitted);
  const held =
    onScreen == null ? 0 : Math.max(onScreen.width, onScreen.height) / Math.max(natural.width, natural.height, 1);
  const wanted = !hidden && held > 0 && held < 1 && density > held * DETAIL_THRESHOLD;

  // The visible rectangle of the frame, in its own pixels.
  const seen = visibleRegion(box, natural, resting, fit);
  const enough = covered != null && covers(covered.region, seen) && Math.abs(covered.density - density) < 0.001;
  const region = wanted && !enough ? marginedRegion(seen, natural) : covered?.region;
  const key = region == null ? '' : `${region.x} ${region.y} ${region.width} ${region.height}`;
  // The region a draw failed for, which is as sharp as it will get until the view moves.
  const [failed, setFailed] = useState<string | null>(null);
  const sharp = !wanted || enough || failed === key;
  // Before paint: a swap waits on this, and would otherwise spend a frame on every rendition
  // change - zoomed or not - showing the one it is replacing.
  useLayoutEffect(() => {
    if (!sharp) return;
    onSharp(source, true);
    return () => onSharp(source, false);
  }, [sharp, source, onSharp]);

  useEffect(() => {
    if (!wanted) {
      setCovered(null);
      releaseDetail(source);
    }
  }, [wanted, source]);

  // Through a ref: the region is a fresh object every render, and as a dependency it would
  // restart the decode below on every frame of a pan.
  const pending = useRef<Region | null>(null);
  pending.current = region ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = pending.current;
    if (!wanted || drawing == null || canvas == null || enough) return;
    let live = true;
    void decodeDetail(source)
      .then(async (frame) => {
        if (!live) return;
        // A failure rather than a quiet return: a swap waiting on this layer would wait for good.
        if (frame.closed) throw new Error('closed');
        // The region is in the file's pixels and the frame may be smaller than the file - it is
        // capped by what the GPU can hold - so it is taken into the frame's own before the draw.
        const into = frame.width / Math.max(frame.naturalWidth, 1);
        const cropped = {
          x: Math.floor(drawing.x * into),
          y: Math.floor(drawing.y * into),
          width: Math.max(2, Math.round(drawing.width * into)),
          height: Math.max(2, Math.round(drawing.height * into)),
        };
        // One image pixel per device pixel, and no more of either than the cap allows - then
        // fitted to what a canvas will hold, which a long thin region of a panorama reaches
        // on its own axis while sitting well inside the area cap.
        const scale = Math.min(1, Math.sqrt(DETAIL_PIXELS / (cropped.width * cropped.height)));
        const bitmap = canvasSizeFor(cropped.width * scale, cropped.height * scale);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        await drawInto(canvas, frame, cropped);
        if (live) setCovered({ region: drawing, density });
      })
      // Nothing covered rather than the last thing that was: what is held is a rectangle of a
      // *previous* view, and leaving it up puts a sharp patch of the photograph somewhere the
      // reader has since panned away from. Dropped, the fitted frame shows through, and the
      // next move of the view asks again.
      .catch((err: unknown) => {
        if (!live) return;
        setCovered(null);
        // The element took a WebGPU context it cannot be drawn into, and it outlives this
        // failure - the zoom holds one canvas across every pan. Without a fresh one, every
        // later region meets the same dead element and 100% never sharpens again.
        if (err instanceof CanvasLost) setAttempt((was) => was + 1);
        else setFailed(key);
      });
    return () => {
      live = false;
    };
  }, [source, wanted, enough, key, density, attempt]);

  if (!wanted || region == null) return null;
  // **Laid out at the rectangle it is being drawn for, and shown only once that is what it
  // holds.** Mounted before it has anything on it, because the draw above needs the element to
  // exist; and the draw resizes it, which happens outside React and so can reach the screen a
  // frame before the state saying what it now holds does. Positioned from what it *held* the
  // element then wore one rectangle's pixels at another's size, which is the picture appearing
  // to stretch. Transparent instead, the fitted frame shows through for the length of a redraw
  // - which is what it is under this for.
  //
  // Identity is the test, and it is exact: `region` is only ever the covered one by having been
  // read straight off it above.
  const left = (box.width - natural.width * fit) / 2 + region.x * fit;
  const top = (box.height - natural.height * fit) / 2 + region.y * fit;
  return (
    <canvas
      key={attempt}
      ref={canvasRef}
      {...stylex.props(styles.detail)}
      aria-hidden
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${region.width * fit}px`,
        height: `${region.height * fit}px`,
        opacity: shown && region === covered?.region ? 1 : 0,
      }}
    />
  );
}

/** The part of the frame the viewport is showing, in the frame's own pixels. */
function visibleRegion(box: Size, natural: Size, view: View, fit: number): Region {
  const width = natural.width * fit * view.scale;
  const height = natural.height * fit * view.scale;
  const left = box.width / 2 + view.x - width / 2;
  const top = box.height / 2 + view.y - height / 2;
  const span = (from: number, to: number, size: number, extent: number): [number, number] => {
    const low = Math.min(Math.max((0 - from) / size, 0), 1) * extent;
    const high = Math.min(Math.max((to - from) / size, 0), 1) * extent;
    return [low, high];
  };
  const [x0, x1] = span(left, box.width, width, natural.width);
  const [y0, y1] = span(top, box.height, height, natural.height);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** The same, grown by its margin and squared off to even pixels, which 4:2:0 chroma needs. */
function marginedRegion(seen: Region, natural: Size): Region {
  const grow = (from: number, size: number, limit: number): [number, number] => {
    const margin = size * DETAIL_MARGIN;
    const low = Math.max(0, Math.floor(from - margin));
    const high = Math.min(limit, Math.ceil(from + size + margin));
    return [low - (low % 2), high + (high % 2)];
  };
  const [x0, x1] = grow(seen.x, seen.width, natural.width);
  const [y0, y1] = grow(seen.y, seen.height, natural.height);
  // Even after the clamp too, not just after the growth: a frame with an odd dimension reaches
  // its own edge with an odd span, and a rect that is not sample-aligned is one `copyTo`
  // rejects outright - which takes the whole draw down rather than the last column.
  const even = (span: number): number => span - (span % 2);
  return {
    x: x0,
    y: y0,
    width: Math.max(2, even(Math.min(natural.width, x1) - x0)),
    height: Math.max(2, even(Math.min(natural.height, y1) - y0)),
  };
}

function covers(outer: Region, inner: Region): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

