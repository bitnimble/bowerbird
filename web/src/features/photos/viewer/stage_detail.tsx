import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  canvasSizeFor,
  decodeDetail,
  decodedFrame,
  fittedCanvasSize,
  releaseDetail,
} from './stage_bitmaps';
import type { Region } from './stage_gpu';
import { CanvasLost, stageCanvases, useStageCanvas } from './stage_canvas';
import { fitScale, type Size, type View } from './zoom_pan';
import { styles } from './photo_stage_view.stylex';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';

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
 * **A region is a decode, a `copyTo` and a texture upload.** Done per frame of a pinch - which
 * is what a gesture asks for, every move being a new scale and so a new region - the gesture
 * lags behind the fingers on a phone.
 *
 * Waiting costs nothing, because the patch already on screen is positioned in the frame's own
 * coordinates and rides the same transform as the picture: it stays registered through the
 * whole gesture and merely softens as the zoom outruns what it holds. So the gesture is smooth
 * and the sharpening happens once, when the reader has stopped and is looking.
 */
const DETAIL_SETTLE_MS = 50;

/**
 * How many frames a replaced patch stays under its replacement. The paint resolves once the GPU
 * thread has submitted, and the canvas it handed over shows that frame some time after; without
 * the old patch under it, the fitted frame blinks through for that long.
 */
const LANDING_FRAMES = 3;

interface Drawn {
  id: number;
  /** What it was drawn for, region, density, proof and attempt, so it is never drawn twice. */
  drawing: string;
  region: Region;
  /** Device pixels per image pixel this was drawn for; a change in zoom is a redraw. */
  density: number;
  proof: RenderingIntent | null;
  devicePeakNits: number;
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
  proof,
  devicePeakNits,
  onSharp,
}: {
  source: string;
  natural: Size;
  box: Size;
  view: View;
  hidden: boolean;
  /** False while this is the rendition being swapped to, drawn before it is revealed. */
  shown: boolean;
  /** As `StageFrame`'s: the patch has to be the picture it lies over. */
  proof: RenderingIntent | null;
  devicePeakNits: number;
  /** Whether what this lays over the frame is as sharp as the view asks for, including having nothing to add. */
  onSharp: (source: string, sharp: boolean) => void;
}): JSX.Element | null {
  // Oldest first, so a replacement stacks over the patch it replaces.
  const [drawn, setDrawn] = useState<readonly Drawn[]>([]);
  // Bumped to replace the pending canvas element, for the same reason `StageFrame` has one.
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
  const density =
    fit * resting.scale * (typeof window === 'undefined' ? 1 : window.devicePixelRatio);
  // What the fitted frame actually puts on screen, which is not always the cap: a JPEG decodes
  // at the steps its own coding allows, so asking for 4096 of a 9504-pixel file returns 3564 -
  // and a decoder that scales nothing at all returns the whole file, which the canvas under it
  // is then fitted down from (`fittedCanvasSize`). The canvas and not the decode, or a panorama
  // whose AVIF came back whole would claim to be holding every pixel of itself while showing
  // 4096 of them, and this layer would never think there was anything to add.
  const fitted = decodedFrame(source);
  const onScreen = fitted == null ? null : fittedCanvasSize(fitted);
  const held =
    onScreen == null
      ? 0
      : Math.max(onScreen.width, onScreen.height) / Math.max(natural.width, natural.height, 1);
  const wanted = !hidden && held > 0 && held < 1 && density > held * DETAIL_THRESHOLD;

  // The visible rectangle of the frame, in its own pixels.
  const seen = visibleRegion(box, natural, resting, fit);
  const covered = drawn.at(-1);
  const enough =
    covered != null &&
    covers(covered.region, seen) &&
    Math.abs(covered.density - density) < 0.001 &&
    covered.proof === proof &&
    covered.devicePeakNits === devicePeakNits;
  const region = wanted && !enough ? marginedRegion(seen, natural) : null;
  const key = region == null ? '' : `${region.x} ${region.y} ${region.width} ${region.height}`;
  const drawing = `${key} ${density} ${proof ?? ''} ${devicePeakNits} ${attempt}`;
  // The drawing a draw failed for, which is as sharp as it will get until the view moves.
  const [failed, setFailed] = useState<string | null>(null);
  const settled = failed === drawing || covered?.drawing === drawing;
  const sharp = !wanted || enough || settled;
  // Before paint: a swap waits on this, and would otherwise spend a frame on every rendition
  // change - zoomed or not - showing the one it is replacing.
  useLayoutEffect(() => {
    if (!sharp) return;
    onSharp(source, true);
    return () => onSharp(source, false);
  }, [sharp, source, onSharp]);

  useEffect(() => {
    if (wanted) return;
    setDrawn((was) => (was.length === 0 ? was : []));
    releaseDetail(source);
  }, [wanted, source]);

  useEffect(() => {
    if (drawn.length < 2) return;
    const newest = drawn[drawn.length - 1]!.id;
    let left = LANDING_FRAMES;
    let frame = requestAnimationFrame(function tick(): void {
      if (left-- > 0) frame = requestAnimationFrame(tick);
      else setDrawn((was) => was.filter((patch) => patch.id >= newest));
    });
    return () => cancelAnimationFrame(frame);
  }, [drawn]);

  const pending = useRef({ drawing: '', id: 0 });
  const drawsNext = region != null && !settled;
  if (
    drawsNext &&
    (pending.current.drawing !== drawing || drawn.some((patch) => patch.id === pending.current.id))
  ) {
    pending.current = { drawing, id: pending.current.id + 1 };
  }

  if (!wanted) return null;
  const placed = (patch: Region): React.CSSProperties => ({
    left: `${(box.width - natural.width * fit) / 2 + patch.x * fit}px`,
    top: `${(box.height - natural.height * fit) / 2 + patch.y * fit}px`,
    width: `${patch.width * fit}px`,
    height: `${patch.height * fit}px`,
  });
  const patches = drawn.map((patch) => (
    <DetailCanvas
      key={patch.id}
      style={{
        ...placed(patch.region),
        opacity: shown && patch.proof === proof && patch.devicePeakNits === devicePeakNits ? 1 : 0,
      }}
    />
  ));
  if (!drawsNext) return <>{patches}</>;
  const { id } = pending.current;
  // A new element per draw, in the same list as the drawn ones so it is kept when it joins them:
  // a canvas handed to the GPU thread shows a new frame some time after the paint resolves, so
  // one moved to the next rectangle shows the last one's pixels stretched into it.
  patches.push(
    <DetailCanvas
      key={id}
      style={{ ...placed(region), opacity: 0 }}
      draw={{
        source,
        region,
        proof,
        devicePeakNits,
        onDrawn: () => {
          const patch = { id, drawing, region, density, proof, devicePeakNits };
          setDrawn((was) => [...was.slice(-1), patch]);
          setFailed(null);
        },
        onFailed: (err) => {
          // Nothing covered rather than the last thing that was: what is held is a rectangle
          // of a *previous* view, and leaving it up puts a sharp patch of the photograph
          // somewhere the reader has since panned away from.
          setDrawn([]);
          // A canvas that took a WebGPU context it cannot draw into stays dead, and a retry of
          // the same drawing would keep it.
          if (err instanceof CanvasLost) setAttempt((was) => was + 1);
          else setFailed(drawing);
        },
      }}
    />,
  );
  return <>{patches}</>;
}

interface Draw {
  source: string;
  region: Region;
  proof: RenderingIntent | null;
  devicePeakNits: number;
  onDrawn: () => void;
  onFailed: (err: unknown) => void;
}

/** Painted once, as it mounts: a different picture is a different element. */
function DetailCanvas({ style, draw }: { style: React.CSSProperties; draw?: Draw }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCanvas = useStageCanvas(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    const job = draw;
    if (canvas == null || job == null) return;
    let live = true;
    void decodeDetail(job.source)
      .then(async (frame) => {
        if (!live) return;
        // A failure rather than a quiet return: a swap waiting on this layer would wait for good.
        if (frame.closed) throw new Error('closed');
        // The region is in the file's pixels and the frame may be smaller than the file - it is
        // capped by what the GPU can hold - so it is taken into the frame's own before the draw.
        const into = frame.width / Math.max(frame.naturalWidth, 1);
        const cropped = {
          x: Math.floor(job.region.x * into),
          y: Math.floor(job.region.y * into),
          width: Math.max(2, Math.round(job.region.width * into)),
          height: Math.max(2, Math.round(job.region.height * into)),
        };
        // One image pixel per device pixel, and no more of either than the cap allows - then
        // fitted to what a canvas will hold, which a long thin region of a panorama reaches
        // on its own axis while sitting well inside the area cap.
        const scale = Math.min(1, Math.sqrt(DETAIL_PIXELS / (cropped.width * cropped.height)));
        const size = canvasSizeFor(cropped.width * scale, cropped.height * scale);
        await stageCanvases.paint(canvas, size, frame, {
          devicePeakNits: job.devicePeakNits,
          region: cropped,
          proof: job.proof,
        });
        if (live) job.onDrawn();
      })
      .catch((err: unknown) => {
        if (live) job.onFailed(err);
      });
    return () => {
      live = false;
    };
  }, []);

  return <canvas ref={handCanvas} {...stylex.props(styles.detail)} aria-hidden style={style} />;
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
  // Only as far as `marginedRegion` can reach: an odd frame's last column is never drawn, and
  // asking for it leaves every patch short of the view.
  return {
    x: x0,
    y: y0,
    width: Math.max(1, Math.min(x1, even(natural.width)) - x0),
    height: Math.max(1, Math.min(y1, even(natural.height)) - y0),
  };
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
  return {
    x: x0,
    y: y0,
    width: Math.max(2, even(Math.min(natural.width, x1) - x0)),
    height: Math.max(2, even(Math.min(natural.height, y1) - y0)),
  };
}

function even(span: number): number {
  return span - (span % 2);
}

function covers(outer: Region, inner: Region): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}
