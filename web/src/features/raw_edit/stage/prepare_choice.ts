import type { StoredRecipe } from '../../../../../src/schemas/recipes';

// Which device prepares the picture the editor grades.
//
// The prepare is the same Rust and the same shaders wherever it runs, so the only question here
// is whether this tab can do it - and nothing above the open knows the answer, the module taking
// a coded frame either way.

/** How large a picture a tab will prepare for itself, in pixels. */
const PREPARES_HERE_AT_MOST = 10_000 * 10_000;

/**
 * A device whose memory makes a frame of this size a bad idea whatever its area says.
 *
 * `deviceMemory` is Chromium's and rounded to a power of two, so 4 means "4GB or less", where a
 * 61MP open's 0.55GB of tab and 1GB of GPU memory is most of what the browser is allowed. Undefined
 * elsewhere, and then the tab prepares for itself.
 */
const SMALL_MEMORY_GB = 4;

declare global {
  interface Navigator {
    /** Chromium only, rounded to a power of two. */
    readonly deviceMemory?: number;
  }
}

/** What this build is running on, as far as the question below is concerned. */
export interface Client {
  /** Chromium's, where it reports one. */
  memoryGb?: number;
}

/** Whether this tab can prepare the picture itself, or has to ask the server for it. */
export function preparesOnTheBackend(
  recipe: StoredRecipe,
  photo: { width: number; height: number },
  client: Client = describeClient(),
): boolean {
  // **A composite has no file to open**, which is the first reason this exists and does not
  // depend on how large the picture is: the tab's open downloads the photograph's own bytes, and
  // a recipe over several others has none. Ahead of the ceiling, because a two-frame pan of small
  // frames is well inside it and still has nothing to download.
  //
  // A recipe this build cannot read goes the same way, and for the same reason: there is no file
  // named in it either.
  if (recipe.kind !== 'file') return true;
  if (photo.width * photo.height > PREPARES_HERE_AT_MOST) return true;
  if (client.memoryGb != null && client.memoryGb <= SMALL_MEMORY_GB) return true;
  // **The shell is not asked about**, though it could be: a prepare answers one level, and the
  // coarsest level of a 61MP photograph is softer at 100% than the full-sensor open the editor
  // already does - so routing the desktop app here would make it worse at the thing it is best
  // at. It becomes a question again with the level ladder, where a backend open loses nothing.
  return false;
}

/** What this build is running in, read once: the answer does not change while a photograph is open. */
export function describeClient(): Client {
  return { memoryGb: globalThis.navigator?.deviceMemory };
}
