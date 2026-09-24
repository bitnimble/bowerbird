import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { focusRing } from '../../../ui/focus_ring';
import { menuStyles } from '../../../ui/menu_styles';
import { Row } from '../../../ui/row';
import { color } from '../../../ui/tokens.stylex';
import { swatchRegion } from './merge_mask';
import { MergePageStrings } from './merge_page.strings';
import type { MergePresenter } from './merge_presenter';
import type { MergeStore } from './merge_store';
import { Spinner } from '../../../ui/spinner';
import type { Decoded } from '../viewer/stage_bitmaps';
import { CanvasLost, stageCanvases, useStageCanvas } from '../viewer/stage_canvas';
import { NO_SIZE, stagePointOf, type Size, type ZoomPan } from '../viewer/zoom_pan';

/** The crop's own size in CSS pixels, which `styles.crop` is drawn at. */
const SWATCH_BOX = 176;

// The flyout's box is computed from these rather than measured, so they are the styles' own numbers:
// the filename under a swatch with the gap above it, `Row`'s gap, and `styles.popup`'s padding with
// `menuStyles.popup`'s border.
const SWATCH_NAME = 18;
const SWATCH_GAP = 8;
const FLYOUT_CHROME = 18;

/** The flyout while its swatches are solved: `styles.searching` and the chrome. */
const SEARCHING_SIZE = { width: 26 + FLYOUT_CHROME, height: 26 + FLYOUT_CHROME };

const styles = stylex.create({
  // `left` and `top` arrive inline, from `flyoutAt`.
  popup: {
    position: 'absolute',
    padding: '8px',
    maxWidth: '100%',
  },
  // One line however many frames the burst holds: `flyoutSize` computes the box, and a row that
  // wrapped would be twice the height it was placed as.
  swatches: {
    flexWrap: 'nowrap',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  swatch: {
    width: `${SWATCH_BOX}px`,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: 0,
    backgroundColor: 'transparent',
    borderStyle: 'none',
    cursor: 'pointer',
  },
  crop: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: `${SWATCH_BOX}px`,
    overflow: 'hidden',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '4px',
  },
  cropCurrent: {
    borderColor: color.glass,
  },
  name: {
    display: 'block',
    fontSize: '11px',
    lineHeight: '16px',
    color: color.boneDim,
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  searching: {
    display: 'flex',
    width: '26px',
    height: '26px',
  },
  picture: {
    display: 'block',
  },
});

const FLYOUT_GAP = 8;
/** How coarsely the stage is searched for a clear spot, when the tile leaves room on neither side. */
const FLYOUT_STEP = 16;

interface Point {
  x: number;
  y: number;
}

/**
 * The flyout's own box, computed rather than measured: it is one row of fixed swatches, and
 * reading it off the element would be a layout read in the path every pan and zoom runs through.
 *
 * Capped at the stage, which the row scrolls inside of - a twelve-frame burst is wider than most
 * stages, and a flyout wider than what clips it can only hang off the side.
 */
export function flyoutSize(swatches: number, stage: Size): Size {
  const width = swatches * SWATCH_BOX + Math.max(0, swatches - 1) * SWATCH_GAP + FLYOUT_CHROME;
  return {
    width: stage.width > 0 ? Math.min(width, stage.width) : width,
    height: SWATCH_BOX + SWATCH_NAME + FLYOUT_CHROME,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Where the flyout sits on the stage: anywhere at all, so long as it covers no part of the tile
 * it belongs to. Below the outline by preference, then above it, then either side, and failing all
 * four wherever on the stage it is clear.
 *
 * **Against the outline, not against its bounding box, and clearance beats proximity.** A tile is a
 * concave blob, so a box that merely misses the bbox misses a great deal of stage that is actually
 * free. And a swatch is large: on a burst of several frames the flyout is most of the stage wide,
 * so the four sides routinely have no room and what is left is the search - where the spot *nearest*
 * the tile is the one pressed up against it, which is the placement the reader reads as covering it.
 * Furthest wins instead.
 *
 * `polygon` and `stage` are both in the stage's own CSS pixels, measured from its top left.
 */
export function flyoutAt(polygon: readonly Point[], popup: Size, stage: Size): { left: number; top: number } {
  if (polygon.length === 0) return { left: 0, top: 0 };
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const across = clamp((x0 + x1) / 2 - popup.width / 2, 0, stage.width - popup.width);
  const down = clamp((y0 + y1) / 2 - popup.height / 2, 0, stage.height - popup.height);
  const sides = [
    { left: across, top: y1 + FLYOUT_GAP },
    { left: across, top: y0 - FLYOUT_GAP - popup.height },
    { left: x1 + FLYOUT_GAP, top: down },
    { left: x0 - FLYOUT_GAP - popup.width, top: down },
  ];
  for (const side of sides) {
    if (side.left < 0 || side.top < 0) continue;
    if (side.left + popup.width > stage.width || side.top + popup.height > stage.height) continue;
    return side;
  }
  // Clamped only once nowhere on the stage is clear, the flyout being larger than what is left of
  // it; the stage clips what leaves it either way.
  return clearOf(polygon, popup, stage) ?? { left: across, top: clamp(y1 + FLYOUT_GAP, 0, stage.height - popup.height) };
}

/** The spot furthest from the tile that the flyout covers none of it in, or null where there is none. */
function clearOf(polygon: readonly Point[], popup: Size, stage: Size): { left: number; top: number } | null {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const middle = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  let best: { left: number; top: number; reach: number } | null = null;
  for (let top = 0; top <= stage.height - popup.height; top += FLYOUT_STEP) {
    for (let left = 0; left <= stage.width - popup.width; left += FLYOUT_STEP) {
      if (covers({ left, top, width: popup.width, height: popup.height }, polygon)) continue;
      const reach = Math.hypot(left + popup.width / 2 - middle.x, top + popup.height / 2 - middle.y);
      if (best == null || reach > best.reach) best = { left, top, reach };
    }
  }
  return best == null ? null : { left: best.left, top: best.top };
}

/** Whether a box and a loop share any ground at all, either one being able to contain the other. */
function covers(box: { left: number; top: number; width: number; height: number }, polygon: readonly Point[]): boolean {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (polygon.some((p) => p.x >= box.left && p.x <= right && p.y >= box.top && p.y <= bottom)) return true;
  if (encloses(polygon, { x: box.left, y: box.top })) return true;
  const corners: Point[] = [
    { x: box.left, y: box.top },
    { x: right, y: box.top },
    { x: right, y: bottom },
    { x: box.left, y: bottom },
  ];
  for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i]!;
    const to = polygon[(i + 1) % polygon.length]!;
    for (let c = 0; c < corners.length; c++) {
      if (crosses(from, to, corners[c]!, corners[(c + 1) % corners.length]!)) return true;
    }
  }
  return false;
}

function encloses(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point): number =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

/** One tile of one frame, out of the frame the page already holds, clipped to its grown outline. */
function SwatchCanvas({
  frame,
  loop,
  label,
}: {
  frame: Decoded;
  loop: readonly (readonly [number, number])[];
  label: string;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCanvas = useStageCanvas(canvasRef);
  const swatch = swatchRegion(loop, frame, SWATCH_BOX);
  const { x, y, width, height } = swatch.region;
  const density = globalThis.devicePixelRatio ?? 1;
  const backingWidth = Math.max(1, Math.round(swatch.width * density));
  const backingHeight = Math.max(1, Math.round(swatch.height * density));

  // Replaces the canvas element, for the same reason `StageFrame` has one.
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas == null || frame.closed) return;
    const size = { width: backingWidth, height: backingHeight };
    void stageCanvases.paint(canvas, size, frame, { x, y, width, height }).catch((err: unknown) => {
      if (err instanceof CanvasLost) setAttempt((was) => was + 1);
    });
  }, [frame, x, y, width, height, backingWidth, backingHeight, attempt]);

  return (
    <canvas
      key={attempt}
      ref={handCanvas}
      role="img"
      aria-label={label}
      {...stylex.props(styles.picture)}
      style={{ width: `${swatch.width}px`, height: `${swatch.height}px`, clipPath: swatch.clipPath }}
    />
  );
}

export const MergeTilePopup = observer(function MergeTilePopup({
  store,
  presenter,
  tile,
  zoom,
  onClose,
}: {
  store: MergeStore;
  presenter: MergePresenter;
  tile: number;
  zoom: ZoomPan;
  onClose: () => void;
}): JSX.Element | null {
  const swatches = store.swatches;
  const recipe = store.recipe;
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (store.searching) return;
      // An arrow previews rather than picks, which is what a hover does: the reader is flicking
      // between two frames to see which one has the eyes open, and Enter is what settles it.
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        presenter.stepSwatch(1);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        presenter.stepSwatch(-1);
        return;
      }
      if (event.key === 'Enter') {
        const previewed = store.hoveredSwatch;
        if (previewed == null) return;
        presenter.pick(tile, previewed);
        onClose();
        return;
      }
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
      const swatch = swatches[digit - 1];
      if (swatch == null) return;
      presenter.pick(tile, swatch.source);
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [swatches, store, tile, presenter, onClose]);

  useEffect(() => {
    function onDown(event: PointerEvent): void {
      if (root.current?.contains(event.target as Node) === true) return;
      onClose();
    }
    // On the press, so the click it ends finds the popup gone and `merge_page`'s `dismissing` set.
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  if (recipe == null) return null;
  const clear = store.grownOpen ?? store.tilePolygons[tile] ?? [];

  // The tile's outline through the view's transform, so a pan or a zoom moves the flyout with it
  // without anything the browser laid out being measured.
  const natural = store.layerSize ?? NO_SIZE;
  const outline = clear.map(([x, y]) => stagePointOf({ x, y }, zoom.view, zoom.box, natural));
  const searching = store.searching;
  const at = flyoutAt(outline, searching ? SEARCHING_SIZE : flyoutSize(swatches.length, zoom.box), zoom.box);

  if (searching) {
    return (
      <div
        {...stylex.props(menuStyles.popup, styles.popup)}
        role="dialog"
        aria-label={MergePageStrings.tileLabel(tile)}
        ref={root}
        style={{ left: `${at.left}px`, top: `${at.top}px` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div {...stylex.props(styles.searching)} role="status" aria-label={MergePageStrings.searching()}>
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div
      {...stylex.props(menuStyles.popup, styles.popup)}
      role="dialog"
      aria-label={MergePageStrings.tileLabel(tile)}
      ref={root}
      style={{ left: `${at.left}px`, top: `${at.top}px` }}
      // The stage is the pan's gesture surface and this is inside it now: without this a drag
      // begun on a swatch would be taken for a pan, and take the pointer capture off the swatch
      // that a touch hold is previewing through.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* Left on the row rather than on each swatch: crossing from one swatch to the next is not
          a moment the canvas should show the tile without either. */}
      <Row style={styles.swatches} onMouseLeave={() => presenter.hoverSwatch(null)}>
        {swatches.map((swatch, index) => {
          const grown = store.readFor(swatch.source);
          const frame = store.layers.get(swatch.source);
          const current = store.picks[tile] === swatch.source;
          return (
          <button
            key={swatch.source}
            type="button"
            aria-label={MergePageStrings.pickSwatch(index)}
            aria-pressed={current}
            {...stylex.props(styles.swatch, focusRing.ring)}
            onMouseEnter={() => presenter.hoverSwatch(swatch.source)}
            onClick={() => {
              presenter.pick(tile, swatch.source);
              onClose();
            }}
            // A finger has no hover, so the same button takes the gesture instead: hold to
            // preview, release to commit. `ViewSwitch`'s peek is the same shape for the same
            // reason - the capture is what makes a release outside the button still end it.
            onPointerDown={(event) => {
              if (event.pointerType !== 'touch') return;
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* the cancel handler still ends the preview */
              }
              presenter.hoverSwatch(swatch.source);
            }}
            onPointerUp={(event) => {
              if (event.pointerType !== 'touch') return;
              presenter.hoverSwatch(null);
              presenter.pick(tile, swatch.source);
              onClose();
            }}
            onPointerCancel={() => presenter.hoverSwatch(null)}
          >
            <span {...stylex.props(styles.crop, current && styles.cropCurrent)}>
              {grown.length > 0 && frame != null && (
                <SwatchCanvas frame={frame} loop={grown} label={MergePageStrings.swatchAlt(index)} />
              )}
            </span>
            <span {...stylex.props(styles.name)} title={swatch.name}>
              {swatch.name}
            </span>
          </button>
          );
        })}
      </Row>
    </div>
  );
});
