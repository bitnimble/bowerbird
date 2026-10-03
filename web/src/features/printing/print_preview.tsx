import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useId } from 'react';
import type { PrintLayout } from '../../../../src/schemas/print_layout';
import { usePrintDialogStore } from '../../app/stores_context';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { size } from '../../ui/tokens.stylex';
import type { PrintPhoto } from './print_dialog_store';
import { PrintPreviewStrings as strings } from './print_preview.strings';

const PAPER = '#ffffff';
const SURROUND = '#808080';

const styles = stylex.create({
  preview: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
  },
  stage: {
    position: 'relative',
    flexGrow: 1,
    minHeight: '320px',
    backgroundColor: SURROUND,
    borderRadius: size.radius,
  },
  // Absolute, so the page's own pixel size never sets the column's height.
  sheet: {
    position: 'absolute',
    inset: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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

/** Where the unturned photo goes, before turning about the place's centre, in page pixels. */
export function pictureOn(
  layout: PrintLayout,
  photo: { width: number; height: number },
): { x: number; y: number; width: number; height: number; turn: number } {
  const { place, quarterTurns } = layout;
  const sideways = quarterTurns % 2 === 1;
  const shown = sideways ? { width: photo.height, height: photo.width } : photo;
  // Cover even when fitting, as the print does: a fitted place is only rounded off the photo's shape.
  const scale = Math.max(place.width / shown.width, place.height / shown.height);
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

export const PrintPreview = observer(function PrintPreview(): JSX.Element {
  const store = usePrintDialogStore();
  const { layout, photo, previewBusy, previewFailed, colourShortfall } = store;
  return (
    <section
      {...stylex.props(styles.preview)}
      aria-label={strings.printPreview()}
      aria-live="polite"
      aria-busy={previewBusy}
    >
      <div {...stylex.props(styles.stage)}>
        {layout != null && photo != null && (
          <div {...stylex.props(styles.sheet)}>
            <Page layout={layout} photo={photo} url={store.preview?.url ?? null} />
          </div>
        )}
        {previewBusy && (
          <div {...stylex.props(styles.busy)}>
            <Spinner />
          </div>
        )}
      </div>
      {previewFailed && (
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

function Page({
  layout,
  photo,
  url,
}: {
  layout: PrintLayout;
  photo: PrintPhoto;
  url: string | null;
}): JSX.Element {
  const clip = useId();
  const { page, place } = layout;
  const picture = pictureOn(layout, photo);
  const centre = { x: place.x + place.width / 2, y: place.y + place.height / 2 };
  return (
    <svg
      {...stylex.props(styles.page)}
      viewBox={`0 0 ${page.widthPx} ${page.heightPx}`}
      width={page.widthPx}
      height={page.heightPx}
      role="img"
      aria-label={photo.name}
    >
      <clipPath id={clip}>
        <rect x={place.x} y={place.y} width={place.width} height={place.height} />
      </clipPath>
      <rect width={page.widthPx} height={page.heightPx} fill={PAPER} />
      {url != null && (
        <g clipPath={`url(#${clip})`}>
          <image
            href={url}
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
  );
}
