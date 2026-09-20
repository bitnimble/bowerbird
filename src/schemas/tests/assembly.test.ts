import { describe, expect, test } from 'bun:test';
import { AssemblyRecipeSchema, MOST_SOURCES, MOST_TILES, MOST_VERTICES } from '../assembly';
import { CompositionSchema } from '../composition';
import { canvasOf, RecipeSchema, sourcesOf } from '../recipes';

// Every value distinct and off zero, as test/fixtures/panorama-recipe.json is, so two fields of one
// type exchanged fail rather than passing on symmetry.
function sample() {
  const source = (photoId: string, gain: number) => ({
    photoId,
    size: [6000, 4000],
    rotation: [0.9998, 0.011, -0.017, 0.003],
    focal: 5200.5,
    lens: { distortion: [0, -0.004, -0.011], crop: 1.03, falloff: [0.21, -0.07], tca: null },
    gain,
  });
  return {
    version: 1,
    sources: [source('photo00000000001', 1.0), source('photo00000000002', 1.21)],
    projection: 'rectilinear',
    canvas: [5900, 3900],
    centre: [2950.5, 1950.25],
    radiansPerPixel: 0.0001925,
    crop: [0.013, 0.077, 0.988, 0.945],
    reference: 1,
    seamRmsPx: 1.75,
    vertices: [[100, 100], [400, 100], [400, 400], [100, 400], [700, 100], [700, 400]],
    tiles: [[0, 1, 2, 3], [1, 4, 5, 2]],
    pick: [1, 0],
    base: 0,
    seams: {
      pick: [1, 0],
      base: 0,
      vertices: [[100, 100], [400, 100], [400, 400], [100, 400], [700, 100], [700, 400]],
      tiles: [[0, 1, 2, 3], [1, 4, 5]],
      source: [1, 1],
      zone: [0, 1],
      corridor: [0.031, 0.0125],
      warp: [[1.002, 0.013, -0.004, 0.998, 2.5, -1.25], [1, 0, 0, 1, 0, 0]],
      exposure: [1.043, 0.972],
    },
  };
}

const seamsWith = (change: object) => ({ seams: { ...sample().seams, ...change } });

const loops = (n: number) => Array.from({ length: n }, () => [0, 1, 2]);
const points = (n: number) => Array.from({ length: n }, (_, i) => [i, i]);

describe('the assembly recipe', () => {
  test('round-trips, and its sources are what sourcesOf answers', () => {
    const recipe = AssemblyRecipeSchema.parse(sample());
    expect(recipe.tiles).toHaveLength(2);
    expect(sourcesOf({ ...recipe, kind: 'assembly' })).toEqual(['photo00000000001', 'photo00000000002']);
  });

  test('a tile naming a vertex that does not exist is refused', () => {
    expect(() => AssemblyRecipeSchema.parse({ ...sample(), tiles: [[0, 1, 99], [1, 4, 5, 2]] })).toThrow();
  });

  // Each case is otherwise whole, and asserts its own refusal: a bare throw passes on any other.
  test.each([
    ['too many tiles', { tiles: loops(MOST_TILES + 1), pick: Array(MOST_TILES + 1).fill(0) }, 'tiles'],
    ['too many vertices', { vertices: points(MOST_VERTICES + 1) }, 'vertices'],
    ['too many sources', { sources: Array(MOST_SOURCES + 1).fill(sample().sources[0]) }, `an assembly is made of at most ${MOST_SOURCES} photographs`],
    ['a base past the sources', { base: 2 }, 'the base names no source'],
    ['a short pick', { pick: [1] }, 'pick has to have one entry a tile'],
    ['a piece short of an exposure', seamsWith({ exposure: [1.043] }), 'the seams have to have one exposure a piece'],
    ['a piece short of a warp', seamsWith({ warp: [[1, 0, 0, 1, 0, 0]] }), 'the seams have to have one warp a piece'],
    ['a piece under no tile', seamsWith({ zone: [0, 2] }), 'a piece names no tile'],
    ['a piece of no source', seamsWith({ source: [1, 2] }), 'a piece names no source'],
    ['a negative feather', { feather: -0.01 }, 'feather'],
    ['a feather past any the page offered', { feather: 0.2 }, 'feather'],
    ['a volume key that is a path', { seamVolume: '../x' }, 'seamVolume'],
  ])('refuses %s', (_, change, refusal) => {
    const parsed = AssemblyRecipeSchema.safeParse({ ...sample(), ...change });
    const said = parsed.error?.issues.flatMap((issue) => [issue.path.join('.'), issue.message]) ?? [];
    expect(said).toContain(refusal);
  });

  test('takes as many sources as it bounds', () => {
    const sources = Array(MOST_SOURCES).fill(sample().sources[0]);
    expect(AssemblyRecipeSchema.safeParse({ ...sample(), sources }).success).toBe(true);
  });

  test('the union knows the kind', () => {
    expect(RecipeSchema.parse({ ...sample(), kind: 'assembly' }).kind).toBe('assembly');
  });

  test('sourcesOf answers nothing for a recipe this build cannot read', () => {
    expect(sourcesOf({ kind: 'unreadable' })).toEqual([]);
  });

  // Both composite kinds are composited onto a canvas, and everything downstream that lays one
  // out - the row's displayed size, the level a prepare picks - has to read it off either.
  test('canvasOf answers a panorama and an assembly alike, and nothing for a photograph', () => {
    // Parsed through `CompositionSchema` first, which strips the tiles: the same geometry as the
    // assembly beside it, so the two answers being equal is the claim rather than a coincidence.
    const panorama = RecipeSchema.parse({ ...CompositionSchema.parse(sample()), kind: 'panorama' });
    expect(canvasOf(panorama)).toEqual([5900, 3900]);
    expect(canvasOf(RecipeSchema.parse({ ...sample(), kind: 'assembly' }))).toEqual([5900, 3900]);
    expect(canvasOf({ kind: 'file', path: 'a.arw' })).toBeNull();
    expect(canvasOf({ kind: 'unreadable' })).toBeNull();
  });
});
