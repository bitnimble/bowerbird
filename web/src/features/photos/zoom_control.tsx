import { ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { MIN_SCALE, STOP_EPSILON, type ZoomPan } from './zoom_pan';

/**
 * The scale readout and the button that steps through the stops.
 *
 * Beside `zoom_pan.ts` for the same reason: two surfaces show a photograph and the control
 * over it should be the same control, not one that resembles it. The editor's canvas and the
 * viewer's `<img>` differ in what a view *does*, not in what the reader presses.
 *
 * `variant` is the only thing either caller decides: ghost over the photograph, where the
 * chip behind it is the frame, and plain in a page's own bar beside the plain buttons
 * already there.
 */
export function ZoomControl({
  zoom,
  variant,
}: {
  zoom: ZoomPan;
  variant: 'ghost' | 'default';
}): JSX.Element {
  // Against the frame's own pixels rather than the fitted size, so the readout
  // answers "am I looking at this at 1:1" - which is the question a cull asks of
  // a render - instead of restating the zoom factor.
  const scalePercent = zoom.fit == null ? null : Math.round(zoom.fit * zoom.view.scale * 100);

  const label =
    zoom.nextStop === MIN_SCALE
      ? 'Zoom out to fit'
      : Math.abs(zoom.nextStop - zoom.nativeScale) < STOP_EPSILON
        ? 'Zoom to 100%'
        : 'Zoom in';

  return (
    <>
      {scalePercent != null && (
        <Text variant="mono" className="stage__scale">{`${scalePercent}%`}</Text>
      )}
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
    </>
  );
}
