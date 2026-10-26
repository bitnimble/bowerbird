import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { stopFlings } from '../../../ui/stop_flings';
import {
  fitScale,
  framePointOf,
  stagePointOf,
  type Size,
  type View,
} from '../../photos/viewer/zoom_pan';
import { overlayColour } from '../overlay.stylex';
import type { ReflectionPresenter } from './reflection_presenter';
import type { BrushMode, ReflectionStore } from './reflection_store';
import { ReflectionOverlayStrings } from './reflection_overlay.strings';

const styles = stylex.create({
  overlay: {
    position: 'absolute',
    inset: 0,
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
  // On the group rather than each stroke, so where strokes of one kind cross reads no darker.
  strokes: {
    opacity: 0.4,
  },
  stroke: {
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  remove: {
    stroke: overlayColour.remove,
  },
  keep: {
    stroke: overlayColour.keep,
  },
});

type Point = { x: number; y: number };

/**
 * The reflection brush on the picture: a drag paints a stroke, and the strokes already painted
 * show beneath it. Points are fractions of the output, as `RepairOverlay` holds its loops.
 */
export const ReflectionOverlay = observer(function ReflectionOverlay({
  store,
  presenter,
  view,
  box,
  natural,
}: {
  store: ReflectionStore;
  presenter: ReflectionPresenter;
  view: View;
  /** The viewport's box, observed by the zoom hook, so nothing here reads layout. */
  box: Size;
  /** The output's size, which the view is a view of. */
  natural: Size;
}): JSX.Element | null {
  /** The gesture in flight, as the way to end it. Null between gestures. */
  const held = useRef<(() => void) | null>(null);
  const [drawn, setDrawn] = useState<Point[] | null>(null);
  /** The view as it is now, for a gesture that began before a wheel moved it. */
  const shown = useRef({ view, box, natural });
  shown.current = { view, box, natural };

  useEffect(
    () => () => {
      held.current?.();
      setDrawn(null);
    },
    [presenter],
  );
  // The surface unmounts with the gesture held, and its capture loss never reaches a listener.
  const painting = store.painting;
  useEffect(() => {
    if (painting) return;
    held.current?.();
    setDrawn(null);
  }, [painting]);

  if (!store.painting || natural.width === 0 || box.width === 0) return null;

  const covered = fitScale(box, natural) * view.scale;
  const onOutput = (event: { offsetX: number; offsetY: number }): Point => {
    const now = shown.current;
    const at = framePointOf({ x: event.offsetX, y: event.offsetY }, now.view, now.box, now.natural);
    return { x: at.x / now.natural.width, y: at.y / now.natural.height };
  };
  const onStage = (points: readonly Point[]): string =>
    // A lone point is a zero-length line, which a round cap draws as a dot.
    (points.length === 1 ? [points[0]!, points[0]!] : points)
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

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // A second finger is a pinch, which the stage's own gesture takes from here.
    if (!event.isPrimary) {
      held.current?.();
      return;
    }
    // Every other button is the stage's: the middle one pans.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (held.current != null) return;
    event.preventDefault();
    const surface = event.currentTarget;
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      /* Not captured, so a stroke that leaves the stage ends early. Better than none. */
    }
    const points = [onOutput(event.nativeEvent)];
    setDrawn([...points]);
    const moved = (move: PointerEvent): void => {
      points.push(onOutput(move));
      setDrawn([...points]);
    };
    const release = (): void => {
      surface.removeEventListener('pointermove', moved);
      surface.removeEventListener('pointerup', lifted);
      surface.removeEventListener('pointercancel', cancelled);
      surface.removeEventListener('lostpointercapture', cancelled);
      held.current = null;
    };
    const cancelled = (): void => {
      release();
      setDrawn(null);
    };
    const lifted = (up: PointerEvent): void => {
      release();
      points.push(onOutput(up));
      setDrawn(null);
      void presenter.paint(points);
    };
    held.current = cancelled;
    surface.addEventListener('pointermove', moved);
    surface.addEventListener('pointerup', lifted);
    surface.addEventListener('pointercancel', cancelled);
    surface.addEventListener('lostpointercapture', cancelled);
  };

  const strokesOf = (kind: BrushMode): JSX.Element => (
    <g {...stylex.props(styles.strokes)}>
      {store.outlines.map((outline, index) =>
        outline.kind === kind ? (
          <polyline
            key={index}
            {...stylex.props(styles.stroke, styles[kind])}
            role="img"
            aria-label={
              kind === 'remove'
                ? ReflectionOverlayStrings.areaToRemove(index + 1)
                : ReflectionOverlayStrings.areaToKeep(index + 1)
            }
            strokeWidth={2 * outline.radius * covered}
            points={onStage(outline.points)}
          />
        ) : null,
      )}
      {drawn != null && store.mode === kind && (
        <polyline
          {...stylex.props(styles.stroke, styles[kind])}
          role="img"
          aria-label={ReflectionOverlayStrings.strokeBeingDrawn()}
          strokeWidth={2 * store.brushRadius * covered}
          points={onStage(drawn)}
        />
      )}
    </g>
  );

  return (
    <div ref={stopFlings} {...stylex.props(styles.overlay)} onPointerDown={down}>
      <svg
        {...stylex.props(styles.lines)}
        viewBox={`0 0 ${box.width} ${box.height}`}
        role="group"
        aria-label={ReflectionOverlayStrings.strokes()}
      >
        {strokesOf('remove')}
        {strokesOf('keep')}
      </svg>
    </div>
  );
});
