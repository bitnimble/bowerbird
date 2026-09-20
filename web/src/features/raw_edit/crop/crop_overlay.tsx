import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { KeystoneStore } from '../keystone/keystone_store';

import { fitScale, type Size } from '../../photos/viewer/zoom_pan';
import type { CropGrip } from './crop_turn';
import type { CropStore } from './crop_store';

// A quarter of the rectangle each, so opposite edges leave its middle half to move it by, floored
// at what a finger can find.
const EDGE = 'clamp(14px, 25%, 24px)';
// A third, so four of them cannot swallow a small rectangle whole.
const CORNER = 'clamp(24px, 33%, 44px)';

const styles = stylex.create({
  overlay: {
    position: 'absolute',
    inset: 0,
    margin: 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
    // Or the compositor claims a crop drag on a touch screen as a scroll or pinch mid-drag.
    touchAction: 'none',
  },
  // Absorbing, not transparent: below it is the stage's own pan and pinch, which would move the
  // picture out from under a rectangle laid out for a fitted view.
  shade: {
    position: 'absolute',
    backgroundColor: 'rgb(0 0 0 / 55%)',
  },
  rect: {
    position: 'absolute',
    // Inset: an outward shadow is clipped by the stage's `overflow: hidden` wherever the picture
    // meets the viewport's edge, and a full-frame crop then reads as running off the canvas.
    boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 90%)',
    cursor: 'move',
  },
  third: {
    position: 'absolute',
    backgroundColor: 'rgb(255 255 255 / 30%)',
    pointerEvents: 'none',
  },
  thirdV: {
    top: 0,
    bottom: 0,
    width: '1px',
  },
  thirdH: {
    left: 0,
    right: 0,
    height: '1px',
  },
  // Undrawn, and hanging inwards from its edge rather than straddling it: at a fitted view the
  // picture meets the window's edge, so the outer half of a centred target is off-screen.
  grip: {
    position: 'absolute',
    zIndex: 1,
  },
  nw: { left: 0, top: 0, width: CORNER, height: CORNER, zIndex: 2, cursor: 'nwse-resize' },
  n: { left: 0, right: 0, top: 0, height: EDGE, cursor: 'ns-resize' },
  ne: { right: 0, top: 0, width: CORNER, height: CORNER, zIndex: 2, cursor: 'nesw-resize' },
  e: { top: 0, bottom: 0, right: 0, width: EDGE, cursor: 'ew-resize' },
  se: { right: 0, bottom: 0, width: CORNER, height: CORNER, zIndex: 2, cursor: 'nwse-resize' },
  s: { left: 0, right: 0, bottom: 0, height: EDGE, cursor: 'ns-resize' },
  sw: { left: 0, bottom: 0, width: CORNER, height: CORNER, zIndex: 2, cursor: 'nesw-resize' },
  w: { top: 0, bottom: 0, left: 0, width: EDGE, cursor: 'ew-resize' },
});

/** The eight grips, and which edges each one moves. Dragging the middle moves all four. */
const GRIPS: ({ name: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' } & CropGrip)[] = [
  { name: 'nw', x: 'left', y: 'top' },
  { name: 'n', x: null, y: 'top' },
  { name: 'ne', x: 'right', y: 'top' },
  { name: 'e', x: 'right', y: null },
  { name: 'se', x: 'right', y: 'bottom' },
  { name: 's', x: null, y: 'bottom' },
  { name: 'sw', x: 'left', y: 'bottom' },
  { name: 'w', x: 'left', y: null },
];

/**
 * The crop rectangle, over a stage showing the frame straightened but uncropped.
 *
 * **The rectangle is the document's own fractions**, because the stage is showing exactly what
 * they are fractions of - `EditDocSchema` defines them against the straightened frame, and that
 * is what `store.geometry` draws while the tool is open. So there is no mapping here beyond the
 * quarter turn, which `store.cropRect` does.
 *
 * Laid out in percentages of the canvas box rather than in pixels: the box is whatever the
 * viewport gives it and changes with the window, and a rectangle in percentages follows it for
 * free without this reading layout on a resize.
 *
 * What a drag *means* is not here either - `draggedCrop` holds the four edges in order and
 * inside the frame, and the presenter is what writes them.
 */
export const CropOverlay = observer(function CropOverlay({
  crop,
  keystone,
  presenter,
  viewport,
}: {
  crop: CropStore;
  keystone: KeystoneStore;
  presenter: RawEditPresenter;
  /**
   * The stage's box, observed by the zoom hook. Passed in rather than measured: a drag needs
   * the overlay's size to turn pointer pixels into fractions, and that is this box with the
   * picture's aspect fitted inside it - which is arithmetic, where `getBoundingClientRect` is
   * a layout read on a path a pointer is already in.
   */
  viewport: Size;
}): JSX.Element | null {
  /** The drag in flight, as the way to end it. Null between gestures. */
  const held = useRef<(() => void) | null>(null);

  // A drag survives its own element being taken away - closing the editor, or a save that
  // re-renders the tool shut - and releasing capture that way fires no `pointercancel`, so the
  // listeners below would never come off and the gesture would never settle.
  useEffect(() => () => held.current?.(), []);

  const rect = crop.cropRect;
  if (!crop.cropping || rect == null) return null;

  // The letterboxed picture inside the viewport, which is what the rectangle is laid out on and
  // what a pointer's pixels are a fraction of. The same `object-fit: contain` arithmetic the
  // `aspect-ratio` below leaves to CSS, done here because a drag needs the number.
  const picture = keystone.output;
  const fit = viewport.width === 0 || picture.width === 0 ? 0 : fitScale(viewport, picture);
  const box = { width: picture.width * fit, height: picture.height * fit };

  /**
   * One drag, from pointer down to up.
   *
   * Pointer capture rather than window listeners: a drag that leaves the element still belongs
   * to it, and capture is what keeps the moves coming without a teardown to forget.
   */
  const drag = (grip: CropGrip | null) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    // One drag at a time. A second finger landing on another grip would otherwise run this
    // again, and the two would fight over the document a move at a time.
    if (!event.isPrimary || held.current != null) return;
    if (box.width === 0 || box.height === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    // The pointer can already be gone by the time this runs, and capturing a dead one throws.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* Not captured, so a drag that leaves the grip ends early. Better than no drag at all. */
    }

    const from = { x: event.clientX, y: event.clientY };
    const start = { ...rect };
    const by = (at: { clientX: number; clientY: number }): { x: number; y: number } => ({
      x: (at.clientX - from.x) / box.width,
      y: (at.clientY - from.y) / box.height,
    });

    const onMove = (at: PointerEvent): void => presenter.dragCrop(start, grip, by(at), false);
    const release = (): void => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      target.removeEventListener('lostpointercapture', onCancel);
      held.current = null;
    };
    const onUp = (at: PointerEvent): void => {
      release();
      presenter.dragCrop(start, grip, by(at), true);
    };
    // A cancel is the system taking the gesture away, not the reader finishing one, so it
    // settles nothing: the rectangle stays where the last move put it and the next drag or
    // slider commits it.
    const onCancel = (): void => release();
    held.current = release;
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
    // **The one that covers a grip taken away mid-drag.** Closing the tool with a second finger
    // removes this element while it holds the capture, which releases it *implicitly* - no
    // `pointerup`, no `pointercancel`, so the two above never fire and `held` would stay set for
    // the life of the session, refusing every later drag. `lostpointercapture` fires either way.
    target.addEventListener('lostpointercapture', onCancel);
  };

  const percent = (value: number): string => `${value * 100}%`;
  const inside = {
    left: percent(rect.left),
    top: percent(rect.top),
    width: percent(rect.right - rect.left),
    height: percent(rect.bottom - rect.top),
  };

  return (
    // Sized by the picture's own aspect and centred, which is `object-fit: contain` written
    // out: the canvas fills the viewport but the *image* in it is letterboxed, and a rectangle
    // laid out on the viewport would sit in the bars.
    <div
      {...stylex.props(styles.overlay)}
      style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
    >
      {/* Four bands rather than one box with a giant shadow: a shadow spreads outwards from
          the element and would darken the page around the stage as well as the frame. */}
      <div {...stylex.props(styles.shade)} style={{ left: 0, top: 0, right: 0, height: inside.top }} />
      <div
        {...stylex.props(styles.shade)}
        style={{ left: 0, top: inside.top, width: inside.left, bottom: percent(1 - rect.bottom) }}
      />
      <div {...stylex.props(styles.shade)} style={{ left: 0, bottom: 0, right: 0, height: percent(1 - rect.bottom) }} />
      <div
        {...stylex.props(styles.shade)}
        style={{ right: 0, top: inside.top, width: percent(1 - rect.right), bottom: percent(1 - rect.bottom) }}
      />

      <div {...stylex.props(styles.rect)} style={inside} onPointerDown={drag(null)}>
        {/* Thirds, which is what a photographer is lining the rectangle up against. */}
        <div {...stylex.props(styles.third, styles.thirdV)} style={{ left: '33.333%' }} />
        <div {...stylex.props(styles.third, styles.thirdV)} style={{ left: '66.667%' }} />
        <div {...stylex.props(styles.third, styles.thirdH)} style={{ top: '33.333%' }} />
        <div {...stylex.props(styles.third, styles.thirdH)} style={{ top: '66.667%' }} />
        {GRIPS.map((grip) => (
          <div
            key={grip.name}
            {...stylex.props(styles.grip, styles[grip.name])}
            onPointerDown={drag(grip)}
          />
        ))}
      </div>
    </div>
  );
});
