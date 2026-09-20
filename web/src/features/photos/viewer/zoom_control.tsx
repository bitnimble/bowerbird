import * as stylex from '@stylexjs/stylex';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useIsTouch } from '../../../app/device';
import { Button } from '../../../ui/button';
import { ICON } from '../../../ui/icon';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { MIN_SCALE, percentOf, scaleOf, STOP_EPSILON, type ZoomPan } from './zoom_pan';
import { ZoomControlStrings } from './zoom_control.strings';

const styles = stylex.create({
  scale: {
    paddingBlock: 0,
    paddingInline: '5px',
  },
  range: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    // The items' own text column, so the track lines up under the heading.
    paddingTop: '2px',
    paddingInline: '9px',
    paddingBottom: '4px',
  },
  // The popup is as wide as its longest item either way, and a fixed track leaves a ragged gap
  // on the wide ones.
  track: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
});

/**
 * The scale readout and the button that steps through the stops.
 *
 * Beside `zoom_pan.ts` for the same reason: two surfaces show a photograph and the control
 * over it should be the same control, not one that resembles it. The editor's canvas and the
 * viewer's `<img>` differ in what a view *does*, not in what the reader presses.
 *
 * `variant` is ghost over the photograph, where the chip behind it is the frame, and plain
 * in a page's own bar beside the plain buttons already there.
 */
export function ZoomControl({
  zoom,
  variant,
  stepper = true,
}: {
  zoom: ZoomPan;
  variant: 'ghost' | 'default';
  /** Off where the page offers the whole range in a menu instead. A finger never gets it. */
  stepper?: boolean;
}): JSX.Element {
  const touch = useIsTouch();
  // Against the frame's own pixels rather than the fitted size, so the readout
  // answers "am I looking at this at 1:1" - which is the question a cull asks of
  // a render - instead of restating the zoom factor.
  const scalePercent = zoom.fit == null ? null : percentOf(zoom.view.scale, zoom.fit);

  const label =
    zoom.nextStop === MIN_SCALE
      ? ZoomControlStrings.zoomOutToFit()
      : Math.abs(zoom.nextStop - zoom.nativeScale) < STOP_EPSILON
        ? ZoomControlStrings.zoomTo100()
        : ZoomControlStrings.zoomIn();

  return (
    <>
      {scalePercent != null && (
        <Text variant="mono" style={styles.scale}>
          {ZoomControlStrings.scale(scalePercent)}
        </Text>
      )}
      {stepper && !touch && (
        <Button
          variant={variant}
          iconOnly
          aria-pressed={zoom.zoomed}
          aria-label={label}
          title={label}
          onClick={() => zoom.zoomTo(zoom.stopAfter, null)}
        >
          {zoom.nextStop === MIN_SCALE ? <ZoomOut size={ICON} /> : <ZoomIn size={ICON} />}
        </Button>
      )}
    </>
  );
}

/**
 * The whole range rather than the three stops, for a menu with room for a track.
 *
 * In percent of the frame's own pixels, which is what the readout in the bar says and what
 * the reader is choosing between: fitted at one end, `maxScaleFor`'s ceiling at the other.
 *
 * Neither control takes the focus, which is what keeps the menu around it navigable - see
 * `Slider`'s `focusable`. The keys that zoom are on the stage instead.
 */
export function ZoomSlider({ zoom }: { zoom: ZoomPan }): JSX.Element | null {
  const fit = zoom.fit;
  if (fit == null) return null;

  return (
    <div {...stylex.props(styles.range)}>
      <Slider
        value={percentOf(zoom.view.scale, fit)}
        min={percentOf(MIN_SCALE, fit)}
        max={percentOf(zoom.maxScale, fit)}
        step={1}
        label={ZoomControlStrings.zoom()}
        focusable={false}
        onChange={(next) => zoom.zoomTo(() => scaleOf(next, fit), null)}
        style={styles.track}
      />
      <Button tabIndex={-1} disabled={!zoom.zoomed} onClick={zoom.reset}>
        {ZoomControlStrings.fit()}
      </Button>
    </div>
  );
}
