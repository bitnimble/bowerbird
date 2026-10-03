import type { Media } from './printing';

/** Millimetres on every side, the printer's own smallest, or none at all. */
export type Margin = 'borderless' | 'minimum' | number;
export type Fit = 'fit' | 'fill';

export interface PrintLayout {
  page: { widthPx: number; heightPx: number };
  place: { x: number; y: number; width: number; height: number };
  quarterTurns: 0 | 1 | 2 | 3;
}

const MARGIN_STEPS_MM = [5, 10, 15, 20, 25];
const MAX_DPI = 360;
const DEFAULT_DPI = 300;

export function marginChoices(media: Media): Margin[] {
  const least = Math.max(...Object.values(media.margins));
  return [
    ...(media.borderless ? (['borderless'] as const) : []),
    'minimum',
    ...MARGIN_STEPS_MM.filter((mm) => mm > least),
  ];
}

/** The finest resolution the printer takes up to 360 dpi, past which a photo only grows the file. */
export function printResolution(resolutionsDpi: number[]): number {
  const usable = resolutionsDpi.filter((dpi) => dpi <= MAX_DPI);
  if (usable.length > 0) return Math.max(...usable);
  return resolutionsDpi.length > 0 ? Math.min(...resolutionsDpi) : DEFAULT_DPI;
}

/**
 * Where a photo of `photo`'s displayed size lands on the sheet, turned a quarter where that
 * matches its orientation to the printable area's.
 */
export function printLayout({
  media,
  margin,
  fit,
  dpi,
  photo,
}: {
  media: Media;
  margin: Margin;
  fit: Fit;
  dpi: number;
  photo: { width: number; height: number };
}): PrintLayout {
  const px = (mm: number): number => Math.round((mm * dpi) / 25.4);
  const inset = (side: keyof Media['margins']): number =>
    margin === 'borderless'
      ? 0
      : px(margin === 'minimum' ? media.margins[side] : Math.max(margin, media.margins[side]));
  const page = { widthPx: px(media.widthMm), heightPx: px(media.heightMm) };
  const area = {
    x: inset('left'),
    y: inset('top'),
    width: Math.max(1, page.widthPx - inset('left') - inset('right')),
    height: Math.max(1, page.heightPx - inset('top') - inset('bottom')),
  };
  const sideways = (photo.width - photo.height) * (area.width - area.height) < 0;
  const quarterTurns = sideways ? 1 : 0;
  if (fit === 'fill') return { page, place: area, quarterTurns };

  const shown = sideways ? { width: photo.height, height: photo.width } : photo;
  const scale = Math.min(area.width / shown.width, area.height / shown.height);
  const width = Math.max(1, Math.round(shown.width * scale));
  const height = Math.max(1, Math.round(shown.height * scale));
  return {
    page,
    place: {
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    },
    quarterTurns,
  };
}
