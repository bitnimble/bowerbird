import { coarsestLevel, levelForStage, levelSize } from '../../../schemas/prepare_levels';
import { workerEntry } from '../../worker_entry';
import type { PrepareAnswer, PrepareAsk } from './prepare_worker';
import { canvasOf, type StoredRecipe } from '../../../schemas/recipes';

/** A worker prepares are run on, one at a time, held open across a reader's session. */
export interface PrepareWorker {
  run: (ask: PrepareAsk) => Promise<Uint8Array>;
  close: () => void;
}

/** What a client can show, which is all it has to say for this side to pick a level and a window. */
export interface Shown {
  /** The rectangle of the picture on screen, as fractions of the canvas. */
  region: { x: number; y: number; width: number; height: number };
  /** The stage's long edge in device pixels. */
  stage: number;
}

/**
 * The tiles a client is missing, named in the level it already holds tiles of.
 *
 * **The one thing a client is allowed to name a level for.** The rule everywhere else is that it
 * says what it can show and this side picks - because a client choosing a level could ask for a
 * picture no adapter will hold, and would have to ask before it could know the canvas. Neither
 * applies to a tile: it is `TILE` on a side by construction, so there is nothing unbounded to ask
 * for, and the level came out of the header of a picture it is already holding rather than out of
 * a guess. Clamped here regardless, which is what makes that an argument rather than a promise.
 *
 * The *union* rather than a request each. A prepare's fixed cost is a file open and a region decode
 * for every source it touches - 25ms of a source on a 61MP Sony - so a request per tile would pay
 * that per tile and make a pan dearer than the whole window it replaces. One pass over the
 * rectangle the missing tiles span, cut up on the way out.
 */
export interface Missing {
  level: number;
  /** `[left, top, width, height]` in that level's own pixels: the box the squares span. */
  rect: [number, number, number, number];
  /**
   * The squares themselves, or empty for the whole of `rect`.
   *
   * **What makes an L cost an L.** The library decodes each source for the box bounding *that
   * source's* own squares and never opens a source no square reaches, where the box bounding an L
   * holds a corner nobody asked about - which widens every footprint and can pull in a source on
   * its own (`composite_tile::CompositeRequest::parts`).
   */
  tiles: [number, number, number, number][];
}

/** Which level of a picture to prepare, which rectangle of it, and what to size a buffer for. */
export interface PictureAt {
  level: number;
  /** `[left, top, width, height]` of that level, absent where the rectangle is the whole of it. */
  window?: [number, number, number, number];
  /** The squares inside `window` that were actually asked for, empty for the whole of it. */
  parts?: [number, number, number, number][];
  /**
   * A bound on what the level will produce, which is what sizes the reply's buffer.
   *
   * Guessing it high is an allocation and guessing it low is a prepare thrown away, so it is
   * rounded out and given a pixel either way: the library floors each axis to an even number for
   * its own word alignment, and the estimate has to be the larger of the two.
   */
  size: { width: number; height: number };
}

/**
 * Which level and which rectangle of it to prepare, for a client that can show `shown`.
 *
 * **The client says what it can see; every number here is this side's.** A client choosing a level
 * would be a second implementation of the arithmetic and a way to ask for a picture no adapter will
 * hold - and it would have to ask before it could know, the canvas being the recipe's rather than
 * the row's.
 *
 * With nothing said, the coarsest level whole: the largest picture inside a texture limit every
 * adapter has, which is what a reader opens on and pans across. A composite's size is its canvas
 * rather than its row's, the row holding what the align's framing leaves.
 *
 * None for a row with no dimensions at all, which is one nothing has read a header for yet.
 */
export function pictureLevel(
  recipe: StoredRecipe,
  photo: { width: number; height: number },
  shown?: Shown,
  missing?: Missing,
): PictureAt | null {
  const [canvasWide = 0, canvasTall = 0] = canvasOf(recipe) ?? [photo.width, photo.height];
  const long = Math.max(canvasWide, canvasTall);
  if (long <= 0) return null;

  // The tiles a client is short of, in the level it named, clipped to that level. Named rather
  // than derived because the client is the only side that knows what it is already holding.
  if (missing != null) {
    // Zero is the picture's own pixels and `coarsestLevel` is where the whole of it fits, so there
    // is nothing outside that range worth serving.
    const level = Math.min(Math.max(Math.floor(missing.level), 0), coarsestLevel(long));
    const shape = levelSize(canvasWide, canvasTall, level);
    const [askedLeft, askedTop, askedWide, askedTall] = missing.rect;
    const left = Math.min(evenAt(askedLeft), Math.max(shape.width - 2, 0));
    const top = Math.min(Math.max(Math.floor(askedTop), 0), Math.max(shape.height - 1, 0));
    // **Measured to the far edge, not from the near one.** Both offsets round down - the left to an
    // even column - so a span taken from where the client asked would end short of it by however
    // far the origin moved, and the client would mark a tile resident with a strip of it black.
    const width = Math.min(evenSpan(askedLeft + askedWide - left, Math.ceil), shape.width - left);
    const height = Math.min(
      Math.max(Math.ceil(askedTop + askedTall - top), 1),
      shape.height - top,
    );
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    const whole = left === 0 && top === 0 && width >= shape.width && height >= shape.height;
    // Clipped to the same level the box was, so a square past the right-hand edge cannot ask the
    // library for a rectangle off the end of the picture.
    const inside = (tile: [number, number, number, number]): boolean => {
      const [x, y, wide, tall] = tile;
      return x + wide <= shape.width && y + tall <= shape.height;
    };
    return {
      level,
      window: whole ? undefined : [left, top, width, height],
      parts: missing.tiles.filter(inside),
      size: { width: width + 2, height: height + 2 },
    };
  }

  const asked = grown(shown);
  const wide = asked == null ? 1 : clampFraction(asked.width);
  const tall = asked == null ? 1 : clampFraction(asked.height);
  // **From the region on screen, not from the window grown around it.** The margin is slack to
  // pan into and never anything the reader is looking at, so a level picked off it would serve the
  // whole window one rung coarser than the stage can show.
  const level = shown == null
    ? coarsestLevel(long)
    : levelForStage(
        long,
        Math.max(
          clampFraction(shown.region.width) * canvasWide,
          clampFraction(shown.region.height) * canvasTall,
        ),
        Math.max(shown.stage, 1),
      );
  // The level's own shape, from the twin `prepare-levels.txt` holds against the library's: both
  // axes floored to even, and no halving past the size a composite is ever assembled at.
  const { width: levelWide, height: levelTall } = levelSize(canvasWide, canvasTall, level);

  // **Out to even columns, and out rather than in.** A frame is two samples to a word, so a
  // window's stride has to be even for a row to start on one; rounding in would leave a strip of
  // what the reader asked for outside what they are sent.
  const fromLeft = clampFraction(asked?.x ?? 0) * levelWide;
  const fromTop = clampFraction(asked?.y ?? 0) * levelTall;
  const left = Math.min(evenAt(fromLeft), Math.max(levelWide - 2, 0));
  const top = Math.min(Math.floor(fromTop), Math.max(levelTall - 1, 0));
  const width = Math.min(
    evenSpan(fromLeft + wide * levelWide - left, Math.ceil),
    levelWide - left,
  );
  const height = Math.min(
    Math.max(Math.ceil(fromTop + tall * levelTall - top), 1),
    levelTall - top,
  );

  const whole = left === 0 && top === 0 && width >= levelWide && height >= levelTall;
  return {
    level,
    window: whole ? undefined : [left, top, width, height],
    size: whole
      ? { width: levelWide + 2, height: levelTall + 2 }
      : { width: width + 2, height: height + 2 },
  };
}

/**
 * How far past the region a window reaches on each side, as a share of the region.
 *
 * **Slack to pan into.** Served flush with the region, every pan of a single pixel leaves what the
 * client holds and costs it another window - tens of megabytes for a gesture that moved nothing.
 * An eighth each side is a fifth of the viewport in hand before a refetch, for 56% more samples.
 */
const MARGIN_SHARE = 0.125;

/** The region with its margin, clamped to the picture, or null where the whole of it is wanted. */
function grown(shown?: Shown): { x: number; y: number; width: number; height: number } | null {
  if (shown == null) return null;
  const grow = (at: number, span: number): [number, number] => {
    const margin = clampFraction(span) * MARGIN_SHARE;
    const from = Math.max(clampFraction(at) - margin, 0);
    return [from, Math.min(clampFraction(span) + margin * 2, 1 - from)];
  };
  const [x, width] = grow(shown.region.x, shown.region.width);
  const [y, height] = grow(shown.region.y, shown.region.height);
  return { x, y, width, height };
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

/** An offset, floored to an even column. Zero is one. */
function evenAt(value: number): number {
  const whole = Math.max(Math.floor(value), 0);
  return whole - (whole % 2);
}

/** A span, rounded out to an even count, and never under the two a word holds. */
function evenSpan(value: number, round: (value: number) => number): number {
  const whole = Math.max(round(value), 2);
  return whole + (whole % 2);
}

/**
 * Opens the worker prepares run on.
 *
 * Chained rather than concurrent: the far side is one blocking call holding the machine's device.
 * The chain survives a failure, because one reader's error is not a reason the next prepare
 * cannot be posted.
 */
export function openPrepareWorker(): PrepareWorker {
  const worker = new Worker(
    workerEntry('prepare_worker', new URL('./prepare_worker.ts', import.meta.url)),
  );
  let crashed: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const post = (ask: PrepareAsk): Promise<Uint8Array> =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (crashed != null) return reject(new Error(`prepare worker crashed: ${crashed}`));
      worker.onmessage = (event: MessageEvent<PrepareAnswer>) => {
        if (event.data.ok) resolve(event.data.framed);
        // An ordinary error rather than a validation one: what fails in here is a decode or a
        // device, which is this server's problem and not the request's.
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event: ErrorEvent) => {
        crashed = event.message;
        reject(new Error(`prepare worker crashed: ${event.message}`));
      };
      worker.postMessage(ask);
    });

  return {
    run: (ask) => {
      const answer = queue.then(() => post(ask));
      queue = answer.then(
        () => undefined,
        () => undefined,
      );
      return answer;
    },
    close: () => worker.terminate(),
  };
}
