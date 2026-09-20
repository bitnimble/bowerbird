// How far down a picture's own halvings a prepare goes, on this side of the FFI.
//
// **The Rust twin is `composition::coarsest_level`, and `prepare-levels.txt` holds the two
// together.** This side picks the level and sizes the buffer the library will write into; the
// library produces the picture at that level. A disagreement is a buffer that does not fit the
// picture it was sized for, which at least fails naming the size it wanted - or a level too
// shallow to hold a texture of, which the client refuses after paying to fetch it.

/**
 * The long edge of the coarsest level a picture is prepared at.
 *
 * A whole 300MP canvas is 1.8GB of samples and no adapter's texture limit reaches it, so the
 * picture a reader opens on is this one.
 */
export const COARSEST_LONG = 4096;

/** The deepest level of a picture, which is the first one inside {@link COARSEST_LONG}. */
export function coarsestLevel(long: number): number {
  let level = 0;
  while (long >> level > COARSEST_LONG) level += 1;
  return level;
}

/** What a picture's long edge measures at `level`, which is a halving of its own. */
export function longEdgeAt(long: number, level: number): number {
  return Math.max(1, long >> level);
}

/**
 * The largest a composite is ever assembled, which is `composite_job::MAX_LONG_EDGE`.
 *
 * Levels stop halving here: a 33804px canvas measures the same at level 1 and level 0, because
 * neither is ever composed wider than this.
 */
export const MAX_LONG_EDGE = 16384;

/**
 * What shape a picture is at `level`, which is the space a window of it is stated in.
 *
 * **The Rust twin is `composite_job::level_shape`, and `prepare-levels.txt` holds the two together.**
 * A window is refused where it is not inside its level, so rounding either axis differently from
 * that side asks for a rectangle off the end of the picture - and a reader zoomed into the
 * right-hand end of a panorama is shown an error instead.
 *
 * Both axes floored to even and neither derived from the other, because a frame is two samples to
 * a word and a row has to start on one.
 */
export function levelSize(
  width: number,
  height: number,
  level: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  const want = Math.min(longEdgeAt(long, level), long, MAX_LONG_EDGE);
  const scale = long / Math.max(want, 1);
  const even = (value: number): number => {
    const scaled = Math.max(Math.round(value / scale), 2);
    return scaled - (scaled % 2);
  };
  return { width: even(width), height: even(height) };
}

/**
 * How much finer than the stage a picture is prepared.
 *
 * A stage draws its frame through a bilinear tap, so a picture prepared at exactly the stage's
 * size is sampled one-to-one and every straight edge in it aliases on the half pixel. A quarter
 * over costs 56% more samples and is what gives the downscale something to average.
 */
export const STAGE_SUPERSAMPLE = 1.25;

/**
 * Which level shows `regionLong` pixels of a picture on a stage `stageLong` pixels across.
 *
 * The coarsest that still has a sample per stage pixel: finer is bytes the downscale throws away,
 * coarser is a picture the stage magnifies.
 *
 * **And never so fine that what comes back will not fit a texture.** The bound is on the rectangle
 * asked for rather than on the picture, which is the whole difference a window makes: a reader
 * zoomed out asks for all of a 33804px canvas and is given a level of it that fits, and a reader
 * zoomed in asks for 1700px of the same canvas and is given those at level 0.
 */
export function levelForStage(long: number, regionLong: number, stageLong: number): number {
  // Bounded rather than clamped at the caller, because `longEdgeAt` floors at one: a stage of
  // zero pixels makes every level deep enough and the first loop below never ends.
  const wanted = Math.max(stageLong * STAGE_SUPERSAMPLE, 2);
  let level = 0;
  while (longEdgeAt(regionLong, level + 1) >= wanted) level += 1;
  while (longEdgeAt(regionLong, level) > COARSEST_LONG && longEdgeAt(long, level) > 1) level += 1;
  return level;
}
