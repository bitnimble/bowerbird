import { describe, expect, test } from 'bun:test';
import { marginChoices, printLayout, printResolution } from '../print_layout';
import { colourPath, type Media, type PrinterColour } from '../printing';

const A4: Media = {
  key: 'iso_a4_210x297mm',
  name: 'A4',
  widthMm: 210,
  heightMm: 297,
  margins: { top: 3.4, right: 3.4, bottom: 3.4, left: 3.4 },
  borderless: true,
};

const FOUR_BY_SIX: Media = {
  key: 'na_index-4x6_4x6in',
  name: '4 x 6',
  widthMm: 101.6,
  heightMm: 152.4,
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  borderless: true,
};

function colour(transports: PrinterColour['transports']): PrinterColour {
  return { transports, profiles: [] };
}

describe('colourPath', () => {
  const lustre = { from: 'printer', name: 'PRO-200 Lustre' } as const;

  test('device RGB with a profile is matched to the paper at the deepest bits offered', () => {
    const offered = colour([
      { space: 'device', bits: 8 },
      { space: 'device', bits: 16 },
      { space: 'adobe-rgb', bits: 8 },
    ]);
    expect(colourPath(offered, lustre)).toEqual({ kind: 'profile', bits: 16, profile: lustre });
  });

  test('device RGB with no profile chosen falls to Adobe RGB', () => {
    const offered = colour([
      { space: 'device', bits: 16 },
      { space: 'adobe-rgb', bits: 16 },
      { space: 'srgb', bits: 8 },
    ]);
    expect(colourPath(offered, null)).toEqual({ kind: 'adobe-rgb', bits: 16 });
  });

  test('a profile is no use to a printer that takes no device RGB', () => {
    expect(colourPath(colour([{ space: 'adobe-rgb', bits: 8 }]), lustre)).toEqual({
      kind: 'adobe-rgb',
      bits: 8,
    });
  });

  test('sRGB is the floor, at 16 bits where offered and 8 where nothing is listed', () => {
    expect(
      colourPath(
        colour([
          { space: 'device', bits: 8 },
          { space: 'srgb', bits: 16 },
        ]),
        null,
      ),
    ).toEqual({
      kind: 'srgb',
      bits: 16,
    });
    expect(colourPath(colour([]), lustre)).toEqual({ kind: 'srgb', bits: 8 });
  });
});

describe('printLayout', () => {
  test('a landscape photo turns onto portrait A4 and fits inside the printer margins', () => {
    expect(
      printLayout({
        media: A4,
        margin: 'minimum',
        fit: 'fit',
        dpi: 300,
        photo: { width: 6000, height: 4000 },
      }),
    ).toEqual({
      page: { widthPx: 2480, heightPx: 3508 },
      place: { x: 97, y: 40, width: 2285, height: 3428 },
      quarterTurns: 1,
    });
  });

  test('fill covers the whole printable area', () => {
    expect(
      printLayout({
        media: A4,
        margin: 10,
        fit: 'fill',
        dpi: 300,
        photo: { width: 6000, height: 4000 },
      }),
    ).toEqual({
      page: { widthPx: 2480, heightPx: 3508 },
      place: { x: 118, y: 118, width: 2244, height: 3272 },
      quarterTurns: 1,
    });
  });

  test('a portrait 3:2 photo borderless on 4 x 6 fills the sheet unturned', () => {
    expect(
      printLayout({
        media: FOUR_BY_SIX,
        margin: 'borderless',
        fit: 'fit',
        dpi: 300,
        photo: { width: 4000, height: 6000 },
      }),
    ).toEqual({
      page: { widthPx: 1200, heightPx: 1800 },
      place: { x: 0, y: 0, width: 1200, height: 1800 },
      quarterTurns: 0,
    });
  });

  test('a square photo is never turned', () => {
    expect(
      printLayout({
        media: A4,
        margin: 'borderless',
        fit: 'fit',
        dpi: 300,
        photo: { width: 10, height: 10 },
      }).quarterTurns,
    ).toBe(0);
  });
});

describe('marginChoices', () => {
  test('offers borderless where the paper allows it, then steps wider than the printer minimum', () => {
    expect(marginChoices(A4)).toEqual(['borderless', 'minimum', 5, 10, 15, 20, 25]);
    expect(
      marginChoices({
        ...A4,
        borderless: false,
        margins: { top: 3, right: 3, bottom: 12.7, left: 3 },
      }),
    ).toEqual(['minimum', 15, 20, 25]);
  });
});

describe('printResolution', () => {
  test('takes the finest up to 360 dpi, else the coarsest offered, else 300', () => {
    expect(printResolution([300, 600])).toBe(300);
    expect(printResolution([360, 720])).toBe(360);
    expect(printResolution([600, 1200])).toBe(600);
    expect(printResolution([])).toBe(300);
  });
});
