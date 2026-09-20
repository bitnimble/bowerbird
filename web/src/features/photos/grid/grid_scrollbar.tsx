import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import type { ScrollRailStore } from './scroll_rail_store';
import { PhotoGridStrings } from './photo_grid.strings';
import { bar } from './photo_grid_styles';

// Shortest the thumb is drawn: a screenful of a hundred thousand photos is a
// thumb a fraction of a pixel tall. In pixels rather than a fraction of the
// track, because it is also the pointer target (WCAG 2.5.8) and a fraction that
// clears 24px on a tall window does not on a short one.
const THUMB_MIN_PX = 24;

/**
 * The scroll position, drawn, because the native scrollbar describes the rail
 * rather than the collection and is hidden (§18.3.2).
 *
 * **The only way to seek**, which is why it is not the gallery's alone: the rail
 * is a hundred thousand pixels of a collection that may be fifteen million, so a
 * native bar reaches a few hundred photographs and this one reaches all of them.
 * The strip takes the same bar lying down.
 *
 * Its own component because it is the one thing that does read the scroll position
 * every sampled frame: kept inside the scroller, the thumb moving would re-render
 * every mounted tile with it.
 */
export const GridScrollbar = observer(function GridScrollbar({
  rail,
  axis,
  total,
  controls,
  viewport,
  wheelStep,
  onDragged,
  onWheeled,
}: {
  rail: ScrollRailStore;
  axis: 'x' | 'y';
  total: number;
  /** The scroller this bar drives, which a screen reader needs by id. */
  controls: string;
  /** The viewport's own length along `axis`, which floors the thumb. */
  viewport: number;
  /** One line of a wheel in this view's terms, for the mice that report lines. */
  wheelStep: number;
  /** Where in the collection the reader dragged to, as a fraction. */
  onDragged: (progress: number) => void;
  /** A wheel notch over the bar, in pixels. */
  onWheeled: (delta: number) => void;
}): JSX.Element | null {
  // The grabbed point, as the progress the drag started from plus where in the
  // track the pointer was, so the thumb keeps hold of the point it was taken by
  // rather than snapping its middle to the pointer. A progress rather than an
  // offset within the thumb, because the thumb's own length changes mid-drag
  // whenever a masonry block measures.
  const grab = useRef({ at: 0, progress: 0, start: 0, span: 1 });

  // Nothing to scroll, so nothing to draw. Safe to unmount because the gutter it
  // floats in belongs to the scroller and stays there either way.
  if (rail.fraction >= 1) return null;

  const down = axis === 'y';
  // Never exactly 1: it is the divisor in `progressAt`, and a viewport shorter than
  // the thumb's own floor would otherwise put NaN into the scroll position.
  const length = Math.min(0.999, Math.max(THUMB_MIN_PX / Math.max(1, viewport), rail.fraction));
  const offset = rail.progress * (1 - length);

  // Off the track measured once at the press, not per move: a drag writes the
  // scroll offset on every move, so reading the rect again each time would force a
  // layout per frame for the length of the drag (§18.2).
  const progressAt = (along: number): number => {
    const held = grab.current;
    return held.progress + ((along - held.start) / held.span - held.at) / (1 - length);
  };

  return (
    <div
      {...stylex.props(bar.track, !down && bar.across)}
      role="scrollbar"
      aria-orientation={down ? 'vertical' : 'horizontal'}
      aria-controls={controls}
      aria-label={PhotoGridStrings.scrollbar()}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(rail.progress * 100)}
      // Off the progress rather than off `visible.from`, which is the first
      // *mounted* index: that is two overscan rows early in the grid and up to a
      // whole block early in masonry, so it named a photo the reader is not at.
      aria-valuetext={PhotoGridStrings.scrollbarPosition(
        Math.round(rail.progress * Math.max(0, total - 1)) + 1,
        total,
      )}
    >
      <div
        {...stylex.props(bar.thumb, !down && bar.thumbAcross)}
        style={
          down
            ? { top: `${offset * 100}%`, height: `${length * 100}%` }
            : { left: `${offset * 100}%`, width: `${length * 100}%` }
        }
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          const box = e.currentTarget.parentElement?.getBoundingClientRect();
          const span = (down ? box?.height : box?.width) ?? 0;
          const start = (down ? box?.top : box?.left) ?? 0;
          const along = down ? e.clientY : e.clientX;
          grab.current = { at: (along - start) / Math.max(1, span), progress: rail.progress, start, span: Math.max(1, span) };
          // Keeps the focus on the scroller: without it the press moves focus to
          // the body, and Page Up/Down and Home/End have nothing to act on after.
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onDragged(progressAt(down ? e.clientY : e.clientX));
        }}
        // The bar is a sibling of the scroller, so a wheel notch over it has
        // nothing scrollable to bubble to and the grid would simply not move.
        // `deltaMode` because Firefox reports a wheel mouse in lines, not pixels.
        onWheel={(e) => onWheeled(e.deltaY * (e.deltaMode === 1 ? wheelStep : e.deltaMode === 2 ? viewport : 1))}
      />
    </div>
  );
});

