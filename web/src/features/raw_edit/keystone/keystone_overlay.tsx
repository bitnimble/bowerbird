import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { fitScale, type Size } from '../../photos/viewer/zoom_pan';
import { isUpright, type KeystoneGuide } from './keystone';
import { KeystoneOverlayStrings } from './keystone_overlay.strings';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import { overlayColour } from '../overlay.stylex';
import type { KeystoneStore } from './keystone_store';

/**
 * How many lines a pair takes, which is two - and the pairs are what the geometry uses.
 *
 * Two lines give one vanishing point and fix one axis; the second pair fixes the other, and
 * there is no third axis in a photograph for a fifth line to be about. Per pair rather than a
 * total of four, because four lines that all happen to be upright fix one axis twice and the
 * other not at all - which the reader could reach, and which looked like the tool ignoring them.
 */
const PAIR = 2;

/** A line shorter than this is a tap that slipped, not a line. Fractions of the frame's diagonal. */
const SHORTEST = 0.04;

/** The end handle's size, which is also how far it may be held in from the picture's edge. */
const HANDLE = 32;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const styles = stylex.create({
  // The crop overlay's `object-fit: contain` box, because both name fractions of the same frame.
  overlay: {
    position: 'absolute',
    inset: 0,
    margin: 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
    touchAction: 'none',
    cursor: 'crosshair',
  },
  lines: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  line: {
    strokeWidth: 2,
    // Dashed, so a guide lying exactly along an edge still reads as the reader's, not the photograph's.
    strokeDasharray: '7 5',
  },
  lineVertical: { stroke: overlayColour.sky },
  lineHorizontal: { stroke: overlayColour.amber },
  grab: {
    stroke: 'transparent',
    strokeWidth: 22,
    pointerEvents: 'stroke',
    cursor: 'move',
  },
  end: {
    position: 'absolute',
    width: `${HANDLE}px`,
    height: `${HANDLE}px`,
    borderRadius: '50%',
    cursor: 'grab',
    '::after': {
      content: '""',
      position: 'absolute',
      inset: '10px',
      borderRadius: '50%',
      boxShadow: '0 0 3px rgb(0 0 0 / 70%)',
    },
  },
  endVertical: { '::after': { backgroundColor: overlayColour.sky } },
  endHorizontal: { '::after': { backgroundColor: overlayColour.amber } },
});

/**
 * The keystone tool: lines the reader lays down the edges that should have been straight.
 *
 * **The reader states the intent and the correction follows.** Rather than pushing a slider
 * until the building looks upright, they say "this edge and that edge are both vertical in the
 * world" - and the perspective that makes both true at once is the answer to that, not a
 * search. `keystone.ts` does the geometry; this puts the lines on the picture.
 *
 * Drawn over the frame with the correction, the crop and the straighten all taken off, because
 * a guide has to be laid along an edge that is still leaning.
 */
export const KeystoneOverlay = observer(function KeystoneOverlay({
  store,
  presenter,
  viewport,
}: {
  store: KeystoneStore;
  presenter: RawEditPresenter;
  /** The stage's box, observed by the zoom hook, so nothing here reads layout. */
  viewport: Size;
}): JSX.Element | null {
  /** The drag in flight, as the way to end it. Null between gestures. */
  const held = useRef<(() => void) | null>(null);

  useEffect(() => () => held.current?.(), []);

  if (!store.keystoning) return null;

  const picture = store.output;
  const fit = viewport.width === 0 || picture.width === 0 ? 0 : fitScale(viewport, picture);
  const box = { width: picture.width * fit, height: picture.height * fit };
  const guides = store.guides;

  /**
   * One drag: an end of a line, a whole line, or a new line drawn on bare picture.
   *
   * `end` names which end moves, `null` moving both - the same shape the crop rectangle's grips
   * have, where a null grip moves all four edges.
   */
  const drag =
    (index: number, end: 1 | 2 | null) =>
    (event: ReactPointerEvent<HTMLElement | SVGElement>): void => {
      if (!event.isPrimary || held.current != null) return;
      const start = store.guides[index];
      if (start == null || box.width === 0 || box.height === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // As an `HTMLElement`, which is what the pointer event map is declared on. The handler is
      // shared between a `<line>` and a `<div>`, and `SVGElement` carries only the older map.
      const target = event.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* Not captured, so a drag that leaves the handle ends early. Better than no drag. */
      }

      const from = { x: event.clientX, y: event.clientY };

      const moved = (at: { clientX: number; clientY: number }): KeystoneGuide[] => {
        const dx = (at.clientX - from.x) / box.width;
        const dy = (at.clientY - from.y) / box.height;
        const next = { ...start };
        if (end !== 2) {
          next.x1 = clamp01(start.x1 + dx);
          next.y1 = clamp01(start.y1 + dy);
        }
        if (end !== 1) {
          next.x2 = clamp01(start.x2 + dx);
          next.y2 = clamp01(start.y2 + dy);
        }
        // Read now rather than closed over at the press: a guide removed part-way through this
        // gesture would otherwise come back on the next move, written from a list that no
        // longer exists.
        return store.guides.map((guide, at) => (at === index ? next : guide));
      };

      const onMove = (at: PointerEvent): void => presenter.setGuides(moved(at), false);
      const release = (): void => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onCancel);
        target.removeEventListener('lostpointercapture', onCancel);
        held.current = null;
      };
      const onUp = (at: PointerEvent): void => {
        release();
        presenter.setGuides(moved(at), true);
      };
      const onCancel = (): void => release();
      held.current = release;
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onCancel);
      // A handle taken away mid-drag releases the capture implicitly and fires neither of the
      // two above; without this the latch stays set and no later drag starts.
      target.addEventListener('lostpointercapture', onCancel);
    };

  /** A new line, drawn out of the picture itself rather than out of a button. */
  const draw = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary || held.current != null) return;
    // The pair the reader says they are drawing, and it has to have room. A third upright line
    // fixes the vertical a second time and the horizontal not at all.
    if (box.width === 0 || box.height === 0 || store.guidePairs[store.guideKind].length >= PAIR) return;
    event.preventDefault();
    event.stopPropagation();
    const surface = event.currentTarget;
    const from = { x: event.clientX, y: event.clientY };
    // Where in the overlay the line starts. `offsetX` is the browser's own answer, measured
    // against the element the event was dispatched on, so this needs no `getBoundingClientRect`
    // on a path a pointer is already in; everything after it is a delta.
    const head = {
      x: clamp01(event.nativeEvent.offsetX / box.width),
      y: clamp01(event.nativeEvent.offsetY / box.height),
    };

    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      /* As above. */
    }

    const line = (client: { clientX: number; clientY: number }): KeystoneGuide => ({
      x1: head.x,
      y1: head.y,
      x2: clamp01(head.x + (client.clientX - from.x) / box.width),
      y2: clamp01(head.y + (client.clientY - from.y) / box.height),
    });
    const longEnough = (guide: KeystoneGuide): boolean =>
      Math.hypot(guide.x2 - guide.x1, guide.y2 - guide.y1) >= SHORTEST;
    // The lines that were already there when this one started. Held rather than re-read,
    // because every move of this gesture writes the drawn line into the list and re-reading
    // would take that one for a settled guide and append another beside it. Nothing else can
    // change the list meanwhile: `remove` declines while a gesture is in flight.
    const settled = store.guides;
    const drawnOver = (drawn: KeystoneGuide | null): KeystoneGuide[] =>
      drawn == null ? settled : [...settled, drawn];

    // A line's pair is its own direction, so a drag that came out the other way joins the other
    // pair - and is dropped where that one is already full rather than being kept as a fifth
    // line the correction would ignore. Over `settled` rather than the live list, which already
    // carries this very line - counted there, the second line of a pair finds its own pair full.
    const roomFor = (guide: KeystoneGuide): boolean =>
      settled.filter((each) => isUpright(each) === isUpright(guide)).length < PAIR;

    const onMove = (client: PointerEvent): void => {
      const drawn = line(client);
      if (!longEnough(drawn)) return;
      presenter.setGuides(drawnOver(drawn), false);
    };
    const release = (): void => {
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      surface.removeEventListener('lostpointercapture', onCancel);
      held.current = null;
    };
    const onUp = (client: PointerEvent): void => {
      release();
      const drawn = line(client);
      // A tap that never travelled leaves the guides where they were rather than adding a line
      // of no length, which names no direction and would refuse the whole correction.
      presenter.setGuides(drawnOver(longEnough(drawn) && roomFor(drawn) ? drawn : null), true);
    };
    const onCancel = (): void => {
      release();
      presenter.setGuides(drawnOver(null), false);
    };
    held.current = release;
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onCancel);
    surface.addEventListener('lostpointercapture', onCancel);
  };

  /**
   * Where an end handle sits, in pixels, held inside the picture.
   *
   * The point it names is a fraction and could be the very edge - a guide is laid along an
   * edge, after all - and a 32px handle centred there would be half outside a stage that clips,
   * to paint and to a finger both. Held the way the crop grips are: the mark stays on the
   * point, the target moves in.
   */
  function placed(x: number, y: number): { left: string; top: string } {
    const inside = (at: number, extent: number): number =>
      Math.min(Math.max(at * extent - HANDLE / 2, 0), Math.max(extent - HANDLE, 0));
    return { left: `${inside(x, box.width)}px`, top: `${inside(y, box.height)}px` };
  }

  return (
    <div
      {...stylex.props(styles.overlay)}
      role="group"
      aria-label={KeystoneOverlayStrings.guides()}
      style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
      onPointerDown={draw}
    >
      <svg {...stylex.props(styles.lines)} viewBox="0 0 100 100" preserveAspectRatio="none">
        {guides.map((guide, index) => (
          <Fragment key={index}>
            {/* Coloured by the pair it is in, which is the one fact about a guide the reader
                cannot read off the picture: two lines of one colour are what gets corrected
                together, and a line that came out the other way changes colour as it is drawn. */}
            <line
              {...stylex.props(styles.line, isUpright(guide) ? styles.lineVertical : styles.lineHorizontal)}
              x1={guide.x1 * 100}
              y1={guide.y1 * 100}
              x2={guide.x2 * 100}
              y2={guide.y2 * 100}
              vectorEffect="non-scaling-stroke"
            />
            {/* The line's own body, for sliding it whole without changing what it says. A fat
                invisible stroke *along* the line rather than a box around it: a box around a
                diagonal is its whole bounding rectangle - a third of the picture for one guide -
                which swallowed the other guides' handles and the bare canvas a new line is drawn
                on. `pointer-events: stroke` is what makes only the line itself answer. */}
            <line
              {...stylex.props(styles.grab)}
              onPointerDown={drag(index, null)}
              x1={guide.x1 * 100}
              y1={guide.y1 * 100}
              x2={guide.x2 * 100}
              y2={guide.y2 * 100}
              vectorEffect="non-scaling-stroke"
            />
          </Fragment>
        ))}
      </svg>

      {/* A fragment rather than a wrapper: everything below is positioned against the overlay
          itself, so a box around it would be a box of nothing. */}
      {guides.map((guide, index) => (
        <Fragment key={index}>
          {([1, 2] as const).map((end) => (
            <div
              key={end}
              {...stylex.props(styles.end, isUpright(guide) ? styles.endVertical : styles.endHorizontal)}
              onPointerDown={drag(index, end)}
              style={placed(end === 1 ? guide.x1 : guide.x2, end === 1 ? guide.y1 : guide.y2)}
            />
          ))}
        </Fragment>
      ))}
      {/* Removing a guide is the panel's, not the picture's. A × at the midpoint sat under both
          end handles on a short guide - so it took the presses meant for them and never got the
          ones meant for it - and it was a text node in the middle of a drag surface, which a
          drag selected rather than moved. */}
    </div>
  );
});
