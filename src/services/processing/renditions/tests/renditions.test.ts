// The rule every recipe's copies are decided by: which picture they are built from, and which of
// them are owed at all. A photograph and a panorama differ in what they compose, not in how this
// is answered, so both are held to it here.
import { describe, expect, it } from 'bun:test';
import { fileRecipe, type StoredRecipe } from '../../../../schemas/recipes';
import { owedOf, sourceFor, type Buildable } from '../renditions';

const PANORAMA: StoredRecipe = {
  kind: 'panorama',
  version: 1,
  sources: [
    { photoId: 'a', size: [6000, 4000], rotation: [1, 0, 0, 0], focal: 5200, lens: { crop: 1 }, gain: 1 },
    { photoId: 'b', size: [6000, 4000], rotation: [1, 0, 0, 0], focal: 5200, lens: { crop: 1 }, gain: 1 },
  ],
  projection: 'cylindrical',
  canvas: [9000, 4200],
  centre: [4500, 2100],
  radiansPerPixel: 1 / 5200,
  crop: [0, 0, 1, 1],
  reference: 0,
};

/** A row on an `embedded` library, which is the case every rule below has to overrule. */
function row(over: Partial<Buildable> = {}): Buildable {
  return {
    recipe: fileRecipe('a.arw'),
    inputs: ['a.arw'],
    edited: false,
    photoSource: null,
    librarySource: 'embedded',
    hdr: false,
    ...over,
  };
}

describe('sourceFor', () => {
  it('follows the library where nothing is edited and every input has a camera rendering', () => {
    expect(sourceFor(row())).toBe('embedded');
    expect(sourceFor(row({ librarySource: 'render' }))).toBe('render');
    // The photograph's own setting outranks it: that is what the column is for.
    expect(sourceFor(row({ photoSource: 'render' }))).toBe('render');
  });

  it('renders anything edited, whatever the library serves', () => {
    expect(sourceFor(row({ edited: true }))).toBe('render');
    // Which for a composite includes a frame someone developed rather than the canvas itself.
    expect(sourceFor(row({ recipe: PANORAMA, inputs: ['a.arw', 'b.arw'], edited: true }))).toBe('render');
  });

  it('renders where an input has no camera rendering to take', () => {
    expect(sourceFor(row({ recipe: fileRecipe('a.png'), inputs: ['a.png'] }))).toBe('render');
    // All or none: a composite missing one frame's JPEG is a canvas with a hole in it.
    expect(sourceFor(row({ recipe: PANORAMA, inputs: ['a.arw', 'b.png'] }))).toBe('render');
    // And a row with no inputs at all - a recipe this build cannot read - is not served as
    // somebody's JPEG on the strength of having none.
    expect(sourceFor(row({ recipe: { kind: 'unreadable' }, inputs: [] }))).toBe('render');
  });
});

describe('owedOf', () => {
  it('owes a photograph served as its own JPEG nothing but the tile', () => {
    expect(owedOf(row())).toEqual([{ rendition: 'grid', hdr: false, from: 'embedded' }]);
  });

  it('owes the viewer a render wherever ours is what it will be shown', () => {
    expect(owedOf(row({ librarySource: 'render', hdr: true }))).toEqual([
      { rendition: 'grid', hdr: false, from: 'render' },
      { rendition: 'full', hdr: true, from: 'render' },
    ]);
  });

  /**
   * There is no camera JPEG of a canvas, so an `embedded` library cannot be served one whole - it
   * is served one composited from its frames', and that is done when a reader opens it. Queued
   * instead, every pan anybody merges is a canvas composited and encoded at up to
   * `panorama_full_rendition_size` before anyone has asked to see it.
   */
  it('owes a composite nothing but the tile where the cameras pictures are what it is shown', () => {
    expect(owedOf(row({ recipe: PANORAMA, inputs: ['a.arw', 'b.arw'], hdr: true }))).toEqual([
      { rendition: 'grid', hdr: false, from: 'embedded' },
    ]);
  });

  // And a frame someone has developed takes both back to a render, the cameras' JPEGs having no
  // way to carry the edit (`sourceFor`).
  it('renders a composite whose frames are edited, whatever the library serves', () => {
    expect(owedOf(row({ recipe: PANORAMA, inputs: ['a.arw', 'b.arw'], edited: true, hdr: true }))).toEqual([
      { rendition: 'grid', hdr: false, from: 'render' },
      { rendition: 'full', hdr: true, from: 'render' },
    ]);
  });

  // A library that renders is the case where the viewer's copy is worth having in hand: the
  // reader who opens the panorama should not be the one to wait for a demosaic per frame.
  it('owes a composite the viewers copy where the library renders', () => {
    expect(owedOf(row({ recipe: PANORAMA, inputs: ['a.arw', 'b.arw'], librarySource: 'render', hdr: true }))).toEqual([
      { rendition: 'grid', hdr: false, from: 'render' },
      { rendition: 'full', hdr: true, from: 'render' },
    ]);
  });

  it('never keeps the grid tile in HDR', () => {
    for (const librarySource of ['embedded', 'render'] as const) {
      const owed = owedOf(row({ librarySource, hdr: true, recipe: PANORAMA, inputs: ['a.arw', 'b.arw'] }));
      expect(owed.filter((want) => want.rendition === 'grid').map((want) => want.hdr)).toEqual([false]);
    }
  });
});
