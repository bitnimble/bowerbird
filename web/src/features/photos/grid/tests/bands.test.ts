import { describe, expect, test } from 'bun:test';
import { type Band, type Expansion, bandRows, displayRowOf, rowAt, rowsInsertedAbove, sectionsIn, totalRows } from '../bands';

const COLUMNS = 4;

// A panorama is explicitly not a stack, and the band is the one place the two look alike on
// screen - so the flag has to reach the section, or the group announces a reader's frames as
// "photos in this stack".
describe('sectionsIn', () => {
  const expansion = (composite: Expansion['composite']): Expansion => ({
    stackId: 'pano',
    composite,
    position: 0,
    photos: [],
  });

  test('carries whether a band stands for frames rather than a stack', () => {
    const layout = (open: Expansion) => ({
      bands: [{ position: 0, members: 2 }],
      columns: COLUMNS,
      total: 4,
      rowHeight: 100,
      expansionAt: (position: number) => (position === 0 ? open : null),
    });

    const frames = sectionsIn({ from: 0, to: 3 }, layout(expansion('assembly')));
    const members = sectionsIn({ from: 0, to: 3 }, layout(expansion(null)));

    expect(frames.find((section) => section.kind === 'band')?.composite).toBe('assembly');
    expect(members.find((section) => section.kind === 'band')?.composite).toBeNull();
  });
});

describe('bandRows', () => {
  test('a band takes whole rows, however few members it has', () => {
    expect(bandRows(1, COLUMNS)).toBe(1);
    expect(bandRows(4, COLUMNS)).toBe(1);
    expect(bandRows(5, COLUMNS)).toBe(2);
  });
});

describe('totalRows', () => {
  test('is the collection plus every open band', () => {
    const bands: Band[] = [{ position: 1, members: 6 }];
    expect(totalRows(10, [], COLUMNS)).toBe(10);
    expect(totalRows(10, bands, COLUMNS)).toBe(12);
  });
});

describe('rowAt', () => {
  const band: Band = { position: 5, members: 6 }; // row 1 of a 4-column grid

  test('rows above the band are the collection, unshifted', () => {
    expect(rowAt(0, [band], COLUMNS)).toEqual({ kind: 'grid', row: 0 });
    expect(rowAt(1, [band], COLUMNS)).toEqual({ kind: 'grid', row: 1 });
  });

  test('the band occupies the rows immediately below its tile', () => {
    expect(rowAt(2, [band], COLUMNS)).toEqual({ kind: 'band', band, offset: 0 });
    expect(rowAt(3, [band], COLUMNS)).toEqual({ kind: 'band', band, offset: 1 });
  });

  test('rows below the band are the collection, displaced', () => {
    expect(rowAt(4, [band], COLUMNS)).toEqual({ kind: 'grid', row: 2 });
  });

  test('two bands each displace what follows them', () => {
    const bands: Band[] = [
      { position: 1, members: 4 }, // row 0, one row of members
      { position: 9, members: 4 }, // row 2, one row of members
    ];
    expect(rowAt(0, bands, COLUMNS)).toEqual({ kind: 'grid', row: 0 });
    expect(rowAt(1, bands, COLUMNS)).toEqual({ kind: 'band', band: bands[0]!, offset: 0 });
    expect(rowAt(2, bands, COLUMNS)).toEqual({ kind: 'grid', row: 1 });
    expect(rowAt(3, bands, COLUMNS)).toEqual({ kind: 'grid', row: 2 });
    expect(rowAt(4, bands, COLUMNS)).toEqual({ kind: 'band', band: bands[1]!, offset: 0 });
    expect(rowAt(5, bands, COLUMNS)).toEqual({ kind: 'grid', row: 3 });
  });

  test('two stacks open on one row give it two bands, left to right', () => {
    const bands: Band[] = [
      { position: 2, members: 2 },
      { position: 0, members: 2 },
    ];
    expect(rowAt(1, bands, COLUMNS)).toEqual({ kind: 'band', band: bands[1]!, offset: 0 });
    expect(rowAt(2, bands, COLUMNS)).toEqual({ kind: 'band', band: bands[0]!, offset: 0 });
    expect(rowAt(3, bands, COLUMNS)).toEqual({ kind: 'grid', row: 1 });
  });
});

describe('displayRowOf', () => {
  test('inverts rowAt for every row of the collection', () => {
    const bands: Band[] = [
      { position: 1, members: 5 },
      { position: 11, members: 3 },
    ];
    for (let gridRow = 0; gridRow < 8; gridRow++) {
      const display = displayRowOf(gridRow, bands, COLUMNS);
      expect(rowAt(display, bands, COLUMNS)).toEqual({ kind: 'grid', row: gridRow });
    }
  });

  test('a row is unmoved by a band that opens below it', () => {
    expect(displayRowOf(0, [{ position: 8, members: 4 }], COLUMNS)).toBe(0);
  });
});

describe('rowAt and displayRowOf agree over a wide sweep', () => {
  // The two arithmetic bugs found in review were both a caller mixing a row of
  // the collection with a row of the display. Brute-forcing the inverse across
  // column counts and band shapes is what makes that class of mistake loud.
  test('every collection row round-trips, for every column count and band shape', () => {
    const shapes: Band[][] = [
      [],
      [{ position: 0, members: 2 }],
      [{ position: 0, members: 9 }],
      [{ position: 3, members: 1 }],
      [
        { position: 2, members: 5 },
        { position: 0, members: 3 },
      ],
      [
        { position: 0, members: 4 },
        { position: 1, members: 4 },
      ],
      [{ position: 40, members: 6 }],
    ];
    for (const columns of [1, 2, 3, 4, 6]) {
      for (const bands of shapes) {
        for (let gridRow = 0; gridRow < 15; gridRow++) {
          const display = displayRowOf(gridRow, bands, columns);
          expect(rowAt(display, bands, columns)).toEqual({ kind: 'grid', row: gridRow });
        }
      }
    }
  });

  test('a band offset counts from the band, so its first row is recoverable', () => {
    const bands: Band[] = [{ position: 0, members: 9 }];
    // Whichever row of the band is looked at, subtracting its offset gives the
    // band's own first display row - which is where its members are drawn from.
    for (let display = 1; display <= 3; display++) {
      const at = rowAt(display, bands, 4);
      expect(at.kind).toBe('band');
      if (at.kind === 'band') expect(display - at.offset).toBe(1);
    }
  });
});

describe('rowsInsertedAbove', () => {
  test('counts the bands that displace a position, and not the ones below it', () => {
    const bands: Band[] = [
      { position: 0, members: 4 },
      { position: 20, members: 4 },
    ];
    // The band on row 0 pushes position 8 (row 2) down; the one on row 5 does not.
    expect(rowsInsertedAbove(8, bands, COLUMNS)).toBe(1);
    expect(rowsInsertedAbove(0, bands, COLUMNS)).toBe(1);
  });
});
