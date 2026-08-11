import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { RawEditStore } from './raw_edit_store';

import { fitScale, type Size } from '../photos/zoom_pan';
import type { CropGrip } from './crop_turn';

/** The eight grips, and which edges each one moves. Dragging the middle moves all four. */
const GRIPS: ({ name: string } & CropGrip)[] = [
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
  store,
  presenter,
  viewport,
}: {
  store: RawEditStore;
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

  const rect = store.cropRect;
  if (!store.cropping || rect == null) return null;

  // The letterboxed picture inside the viewport, which is what the rectangle is laid out on and
  // what a pointer's pixels are a fraction of. The same `object-fit: contain` arithmetic the
  // `aspect-ratio` below leaves to CSS, done here because a drag needs the number.
  const picture = store.output;
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
      className="crop-overlay"
      data-testid="crop-overlay"
      style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
    >
      {/* Four bands rather than one box with a giant shadow: a shadow spreads outwards from
          the element and would darken the page around the stage as well as the frame. */}
      <div className="crop-overlay__shade" style={{ left: 0, top: 0, right: 0, height: inside.top }} />
      <div
        className="crop-overlay__shade"
        style={{ left: 0, top: inside.top, width: inside.left, bottom: percent(1 - rect.bottom) }}
      />
      <div className="crop-overlay__shade" style={{ left: 0, bottom: 0, right: 0, height: percent(1 - rect.bottom) }} />
      <div
        className="crop-overlay__shade"
        style={{ right: 0, top: inside.top, width: percent(1 - rect.right), bottom: percent(1 - rect.bottom) }}
      />

      <div className="crop-overlay__rect" style={inside} onPointerDown={drag(null)} data-testid="crop-rect">
        {/* Thirds, which is what a photographer is lining the rectangle up against. */}
        <div className="crop-overlay__third crop-overlay__third--v" style={{ left: '33.333%' }} />
        <div className="crop-overlay__third crop-overlay__third--v" style={{ left: '66.667%' }} />
        <div className="crop-overlay__third crop-overlay__third--h" style={{ top: '33.333%' }} />
        <div className="crop-overlay__third crop-overlay__third--h" style={{ top: '66.667%' }} />
        {GRIPS.map((grip) => (
          <div
            key={grip.name}
            className={`crop-overlay__grip crop-overlay__grip--${grip.name}`}
            data-testid={`crop-grip-${grip.name}`}
            onPointerDown={drag(grip)}
          />
        ))}
      </div>
    </div>
  );
});
