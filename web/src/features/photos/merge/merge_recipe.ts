import { MOST_FEATHER, type Takes } from '../../../../../src/schemas/assembly';
import { type AssemblyRecipe } from '../../../../../src/schemas/assembly';
import { cornersOf, type Rect } from './merge_rect';
import { takesOf } from './merge_store';

/**
 * `takes`, or nothing where every tile asks for its subject: a merge that never removes anything
 * stores the recipe it always did, and a click that took nothing leaves the recipe as it found it.
 */
function stated(takes: Takes[]): Takes[] | undefined {
  return takes.every((asked) => asked === 'subject') ? undefined : takes;
}

export function withSeed(recipe: AssemblyRecipe, rect: Rect, pick: number, takes: Takes): AssemblyRecipe {
  const first = recipe.vertices.length;
  return {
    ...recipe,
    vertices: [...recipe.vertices, ...cornersOf(rect)],
    tiles: [...recipe.tiles, [first, first + 1, first + 2, first + 3]],
    pick: [...recipe.pick, pick],
    takes: stated([...recipe.tiles.map((_, tile) => takesOf(recipe, tile)), takes]),
  };
}

export function withoutLastTile(recipe: AssemblyRecipe): AssemblyRecipe {
  const last = recipe.tiles.length - 1;
  return {
    ...recipe,
    vertices: recipe.vertices.slice(0, Math.min(...recipe.tiles[last]!)),
    tiles: recipe.tiles.slice(0, last),
    pick: recipe.pick.slice(0, last),
    takes: recipe.takes == null ? undefined : stated(recipe.takes.slice(0, last)),
  };
}

export function featherWithin(share: number): number {
  return Math.min(Math.max(share, 0), MOST_FEATHER);
}

export function pauseMergePoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
