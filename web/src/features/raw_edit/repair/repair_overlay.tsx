import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { color } from '../../../ui/tokens.stylex';
import { framePointOf, MIN_SCALE, stagePointOf, type Size, type View } from '../../photos/viewer/zoom_pan';
import type { RepairPresenter } from './repair_presenter';
import type { RepairStore } from './repair_store';
import { overlayColour } from '../overlay.stylex';
import { RepairOverlayStrings } from './repair_overlay.strings';

const styles = stylex.create({
  overlay: {
    position: 'absolute',
    inset: 0,
    touchAction: 'none',
    cursor: 'crosshair',
  },
  overRemoval: {
    cursor: 'pointer',
  },
  // A fill on offer is being worked on: nothing draws a lasso, and a drag pans as the stage's does.
  editing: {
    cursor: 'default',
  },
  panning: {
    cursor: { default: 'grab', ':active': 'grabbing' },
  },
  grab: {
    cursor: 'grab',
  },
  grabbing: {
    cursor: 'grabbing',
  },
  lines: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  seam: {
    fill: 'none',
    stroke: 'rgb(255 255 255 / 55%)',
    strokeWidth: 1.5,
    strokeDasharray: '4 4',
  },
  seamHovered: {
    stroke: overlayColour.sky,
    strokeWidth: 2,
  },
  // The fill in the brand's blue so it cannot be taken for where it is read from.
  fill: {
    fill: 'none',
    stroke: color.satin,
    strokeWidth: 1.5,
    strokeDasharray: '4 3',
  },
  fillOver: {
    strokeWidth: 2.5,
  },
  source: {
    fill: 'none',
    stroke: overlayColour.sky,
    strokeWidth: 1,
    strokeDasharray: '3 3',
  },
  arrow: {
    fill: overlayColour.sky,
  },
  loop: {
    fill: 'rgb(125 211 252 / 15%)',
    stroke: overlayColour.sky,
    strokeWidth: 2,
  },
});

type Point = { x: number; y: number };

/** The two things a fill on offer is dragged by: where it lands, and where it is read from. */
type Part = 'fill' | 'source';

/** How far a pointer may travel, in CSS pixels, and still have been a tap. */
export const TAP_SLOP = 8;

/** Whether `loop` holds `point`, by the even-odd rule the seam is drawn with. */
function holds(loop: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let at = 0, before = loop.length - 1; at < loop.length; before = at++) {
    const a = loop[before];
    const b = loop[at];
    if (a == null || b == null || b.y > point.y === a.y > point.y) continue;
    if (point.x < a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
  }
  return inside;
}

function centre(loop: readonly Point[]): Point {
  const sum = loop.reduce((total, { x, y }) => ({ x: total.x + x, y: total.y + y }), { x: 0, y: 0 });
  return { x: sum.x / Math.max(loop.length, 1), y: sum.y / Math.max(loop.length, 1) };
}

function shifted(loop: readonly Point[], by: Point): Point[] {
  return loop.map(({ x, y }) => ({ x: x + by.x, y: y + by.y }));
}

/**
 * The repair tool on the picture: a lasso around what to remove, and the seams of the repairs
 * already made - or, while a loop's fills are on offer, the one on show and where it is read from,
 * each dragged to move it.
 *
 * Over the stage as the reader has it - cropped, turned, zoomed and panned - so a loop is held as
 * fractions of the output and placed through the same view the picture is drawn at. The presenter
 * takes it onto the photograph (`RepairPresenter.draw`).
 */
export const RepairOverlay = observer(function RepairOverlay({
  store,
  presenter,
  view,
  box,
  natural,
}: {
  store: RepairStore;
  presenter: RepairPresenter;
  view: View;
  /** The viewport's box, observed by the zoom hook, so nothing here reads layout. */
  box: Size;
  /** The output's size, which the view is a view of. */
  natural: Size;
}): JSX.Element | null {
  /** The gesture in flight, as the way to end it. Null between gestures. */
  const held = useRef<(() => void) | null>(null);
  /** The loop being drawn, which is the gesture's and nothing the document holds until it ends. */
  const [loop, setLoop] = useState<Point[] | null>(null);
  /** The removal under a hovering pointer, which a click would reopen. */
  const [hovered, setHovered] = useState<number | null>(null);
  /** The part of the fill on offer under a hovering pointer, which a drag would move. */
  const [over, setOver] = useState<Part | null>(null);
  /**
   * A part being dragged: its outline as it was taken, and how far the pointer has carried it, which
   * the outlines the presenter maps for each step trail behind.
   */
  const [dragged, setDragged] = useState<{ part: Part; outline: readonly Point[]; by: Point } | null>(null);
  /** Whether the last press took a part, whose click is then not the stage's to zoom on. */
  const pressed = useRef(false);
  // `url(#…)` takes the id as it is written, and React's has characters that do not survive it.
  const arrow = `repair-arrow-${useId().replace(/[^\w-]/g, '')}`;
  /** The view as it is now, for a gesture that began before a wheel moved it. */
  const shown = useRef({ view, box, natural });
  shown.current = { view, box, natural };

  useEffect(() => () => held.current?.(), []);

  if (!store.repairing || natural.width === 0 || box.width === 0) return null;

  const editing = store.repairOptions != null;
  const fill = store.repairShownAt == null ? null : store.repairOutlines[store.repairShownAt] ?? null;
  const source = store.repairSourceOutline;

  const onOutput = (event: { offsetX: number; offsetY: number }): Point => {
    // `offsetX` is the browser's own answer against the overlay, which covers the viewport and
    // holds the capture, so nothing on a pointer's path reads layout.
    const now = shown.current;
    const at = framePointOf({ x: event.offsetX, y: event.offsetY }, now.view, now.box, now.natural);
    return { x: at.x / now.natural.width, y: at.y / now.natural.height };
  };
  const onStage = (points: readonly Point[]): string =>
    points
      .map((point) => {
        const at = stagePointOf(
          { x: point.x * natural.width, y: point.y * natural.height },
          view,
          box,
          natural,
        );
        return `${at.x},${at.y}`;
      })
      .join(' ');
  /** The removal a point on the output falls in, topmost first, or null. Not the one on offer. */
  const removalAt = (at: Point): number | null => {
    const seams = store.repairOutlines;
    for (let index = seams.length - 1; index >= 0; index--) {
      if (index !== store.repairShownAt && holds(seams[index] ?? [], at)) return index;
    }
    return null;
  };
  /** The part of the fill on offer a point on the output falls in, the fill first. */
  const partAt = (at: Point): Part | null => {
    if (fill != null && holds(fill, at)) return 'fill';
    if (source != null && holds(source, at)) return 'source';
    return null;
  };
  const hover = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (held.current != null || event.pointerType === 'touch') return;
    const at = onOutput(event.nativeEvent);
    if (editing) {
      const part = partAt(at);
      if (part !== over) setOver(part);
      return;
    }
    const removal = removalAt(at);
    if (removal !== hovered) setHovered(removal);
  };

  /**
   * A pointer held down on the overlay for the rest of its gesture, `onMove` and `onUp` its own, and
   * `onCancel` whatever ends it otherwise.
   */
  const capture = (
    event: ReactPointerEvent<HTMLDivElement>,
    onMove: (moved: PointerEvent, travelled: number) => void,
    onUp: (lifted: PointerEvent, travelled: number) => void,
    onCancel?: () => void,
  ): void => {
    event.preventDefault();
    const surface = event.currentTarget;
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      /* Not captured, so a gesture that leaves the stage ends early. Better than none. */
    }
    const from = { x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY };
    let travelled = 0;
    const onPointerMove = (moved: PointerEvent): void => {
      travelled = Math.max(travelled, Math.hypot(moved.offsetX - from.x, moved.offsetY - from.y));
      onMove(moved, travelled);
    };
    const release = (): void => {
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', lifting);
      surface.removeEventListener('pointercancel', cancelled);
      surface.removeEventListener('lostpointercapture', cancelled);
      held.current = null;
    };
    const cancelled = (): void => {
      release();
      setLoop(null);
      setDragged(null);
      onCancel?.();
    };
    const lifting = (lifted: PointerEvent): void => {
      release();
      onUp(lifted, travelled);
    };
    held.current = cancelled;
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', lifting);
    surface.addEventListener('pointercancel', cancelled);
    surface.addEventListener('lostpointercapture', cancelled);
  };

  /** A fill on offer, or where it is read from, taken by the pointer and moved where it is let go. */
  const drag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = onOutput(event.nativeEvent);
    const part = partAt(from);
    const outline = part === 'fill' ? fill : source;
    // Anywhere else is the stage's, which pans: a lasso here would throw away the fill being
    // worked on.
    if (part == null || outline == null) return;
    event.stopPropagation();
    pressed.current = true;
    setOver(null);
    setDragged({ part, outline, by: { x: 0, y: 0 } });
    let sent = from;
    const step = (to: Point): void => {
      void presenter.move(part, sent, to);
      sent = to;
    };
    capture(
      event,
      (moved, travelled) => {
        const to = onOutput(moved);
        setDragged({ part, outline, by: { x: to.x - from.x, y: to.y - from.y } });
        if (travelled > TAP_SLOP) step(to);
      },
      (lifted, travelled) => {
        setDragged(null);
        if (travelled <= TAP_SLOP) return;
        step(onOutput(lifted));
        void presenter.settleMove();
      },
      // The steps already sent moved it, so a cancelled drag settles where it was left.
      () => {
        if (sent !== from) void presenter.settleMove();
      },
    );
  };

  const lasso = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (store.repairSolving) return;
    setHovered(null);
    const points = [onOutput(event.nativeEvent)];
    setLoop([...points]);
    capture(
      event,
      (moved) => {
        points.push(onOutput(moved));
        setLoop([...points]);
      },
      (lifted, travelled) => {
        setLoop(null);
        // A tap on a removal reopens it; a tap anywhere else draws nothing.
        if (travelled <= TAP_SLOP) {
          const at = points[0];
          const index = at == null ? null : removalAt(at);
          if (index != null) void presenter.open(index);
          return;
        }
        points.push(onOutput(lifted));
        void presenter.draw(points);
      },
    );
  };

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // A second finger is a pinch, which the stage's own gesture takes from here.
    if (!event.isPrimary) {
      held.current?.();
      return;
    }
    // Every other button is the stage's: the middle one pans.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (held.current != null) return;
    pressed.current = false;
    if (editing) drag(event);
    else lasso(event);
  };

  const fillShown = dragged?.part === 'fill' ? shifted(dragged.outline, dragged.by) : fill;
  const sourceShown = dragged?.part === 'source' ? shifted(dragged.outline, dragged.by) : source;
  const removal = editing || hovered === store.repairShownAt ? null : hovered;
  const cursor =
    dragged != null ? styles.grabbing
    : editing && over != null ? styles.grab
    : editing && view.scale > MIN_SCALE ? styles.panning
    : editing ? styles.editing
    : removal != null ? styles.overRemoval
    : null;
  return (
    <div
      {...stylex.props(styles.overlay, cursor)}
      onPointerDown={down}
      onPointerMove={hover}
      onPointerLeave={() => {
        setHovered(null);
        setOver(null);
      }}
      onClick={(event) => {
        // A press that took a part ends in a click the stage would zoom on.
        if (pressed.current) event.stopPropagation();
      }}
    >
      <svg {...stylex.props(styles.lines)} viewBox={`0 0 ${box.width} ${box.height}`}>
        <defs>
          <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path {...stylex.props(styles.arrow)} d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        {store.repairOutlines.map((seam, index) =>
          // The one under the pointer is drawn with outlines hidden too: it is what a click opens.
          index !== store.repairShownAt && (store.repairOutlinesShown || index === removal) ?
            <polygon
              key={index}
              {...stylex.props(styles.seam, index === removal && styles.seamHovered)}
              role="img"
              aria-label={RepairOverlayStrings.removal(index + 1)}
              points={onStage(seam)}
            />
          : null,
        )}
        {editing && (
          <>
            {sourceShown != null && (
              <polygon
                {...stylex.props(styles.source)}
                role="img"
                aria-label={RepairOverlayStrings.source()}
                points={onStage(sourceShown)}
              />
            )}
            {fillShown != null && (
              <polygon
                {...stylex.props(styles.fill, (over === 'fill' || dragged?.part === 'fill') && styles.fillOver)}
                role="img"
                aria-label={RepairOverlayStrings.fill()}
                points={onStage(fillShown)}
              />
            )}
            {/* From where the fill is read to where it lands, which is the way it travels. */}
            {fillShown != null && sourceShown != null && (
              <polyline
                {...stylex.props(styles.source)}
                role="img"
                aria-label={RepairOverlayStrings.path()}
                points={onStage([centre(sourceShown), centre(fillShown)])}
                markerEnd={`url(#${arrow})`}
              />
            )}
          </>
        )}
        {loop != null && (
          <polygon
            {...stylex.props(styles.loop)}
            role="img"
            aria-label={RepairOverlayStrings.loop()}
            points={onStage(loop)}
          />
        )}
      </svg>
    </div>
  );
});
