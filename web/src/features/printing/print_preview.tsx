import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useId } from 'react';
import type { Fit, PrintLayout } from '../../../../src/schemas/print_layout';
import { usePrintDialogStore } from '../../app/stores_context';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { PrintPreviewStrings as strings } from './print_preview.strings';

const PAPER = '#ffffff';

const styles = stylex.create({
  preview: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    position: 'sticky',
    top: 0,
  },
  stage: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '420px',
  },
  page: {
    maxWidth: '100%',
    maxHeight: '100%',
    filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5))',
  },
  busy: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const SHORTFALL = {
  srgb: strings.srgbLimits,
  'eight-bit': strings.eightBit,
} as const;

/** Where the photo lands on the page and how much of it shows, in page pixels. */
function pictureOn(
  layout: PrintLayout,
  fit: Fit,
  photo: { width: number; height: number },
): { x: number; y: number; width: number; height: number; turn: number } {
  const { place, quarterTurns } = layout;
  const sideways = quarterTurns % 2 === 1;
  const shown = sideways ? { width: photo.height, height: photo.width } : photo;
  const scales = [place.width / shown.width, place.height / shown.height];
  const scale = fit === 'fill' ? Math.max(...scales) : Math.min(...scales);
  const width = photo.width * scale;
  const height = photo.height * scale;
  return {
    x: place.x + (place.width - width) / 2,
    y: place.y + (place.height - height) / 2,
    width,
    height,
    turn: quarterTurns * 90,
  };
}

export const PrintPreview = observer(function PrintPreview(): JSX.Element | null {
  const store = usePrintDialogStore();
  const clip = useId();
  const { layout, photo, previewUrl, previewState, colourShortfall } = store;
  if (layout == null || photo == null) return null;
  const { page, place } = layout;
  const picture = pictureOn(layout, store.settings.fit, photo);
  const centre = { x: place.x + place.width / 2, y: place.y + place.height / 2 };
  return (
    <section {...stylex.props(styles.preview)} aria-label={strings.printPreview()}>
      <div {...stylex.props(styles.stage)}>
        <svg
          {...stylex.props(styles.page)}
          viewBox={`0 0 ${page.widthPx} ${page.heightPx}`}
          width={page.widthPx}
          height={page.heightPx}
          role="img"
          aria-label={photo.name}
          aria-busy={previewState === 'loading'}
        >
          <clipPath id={clip}>
            <rect x={place.x} y={place.y} width={place.width} height={place.height} />
          </clipPath>
          <rect width={page.widthPx} height={page.heightPx} fill={PAPER} />
          {previewUrl != null && (
            <g clipPath={`url(#${clip})`}>
              <image
                href={previewUrl}
                x={picture.x}
                y={picture.y}
                width={picture.width}
                height={picture.height}
                preserveAspectRatio="none"
                transform={`rotate(${picture.turn} ${centre.x} ${centre.y})`}
              />
            </g>
          )}
        </svg>
        {previewState === 'loading' && (
          <div {...stylex.props(styles.busy)}>
            <Spinner />
          </div>
        )}
      </div>
      {previewState === 'failed' && (
        <Text variant="muted" as="p">
          {strings.noPreview()}
        </Text>
      )}
      {colourShortfall != null && (
        <Text variant="mono" as="p">
          {SHORTFALL[colourShortfall]()}
        </Text>
      )}
    </section>
  );
});
