/**
 * The rendition-quality tiles the loupe magnifies, built and kept.
 *
 * The editor's own denoise is the sRGB one, which is cruder than the mosaic denoise a rendition
 * gets - deliberately, since it has to run per tick in a browser (DESIGN 10.9.1). A loupe is
 * where that difference matters, so the glass shows the *export's* pixels: the rendition pipeline
 * runs over that crop and this holds what came back. In a tab that pipeline is the wasm module in
 * this page; under the desktop shell it is the shell's own process, over its own transport.
 *
 * **Tiles are larger than the glass, and that is what hides the latency.** A tile costs tens of
 * milliseconds decoded here and about 110ms fetched, so asking for exactly what is under the
 * pointer would mean a request on every move. A tile grown past the loupe's own span is one
 * request per sweep of that margin, and the moves in between are answered from what is here.
 *
 * Nothing here decides *when* to show a tile. The presenter draws its own render underneath and
 * the tile over it once it lands, so a move that outruns the decode is a picture that sharpens
 * rather than a hole.
 */
import type { LocalTile } from './local_open';

/**
 * How much larger than the loupe's own span a tile is, on each axis.
 *
 * The slack either side is what a reader spends before anything is fetched: at 1.5 a 400px glass
 * comes back on a 600px tile, so the pointer has 100 source pixels in every direction before the
 * tile it is holding stops covering it.
 */
const TILE_MARGIN = 1.5;

/**
 * How many tiles to keep.
 *
 * The ones worth keeping are the ones around wherever the reader has been looking, so this is "a
 * sweep across a photograph and back" rather than a memory budget: at the widest the glass goes, a
 * window is about 2MB of samples, against the hundreds the frame itself occupies.
 */
const KEPT = 24;

export interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * What a tile arrived as, which is not the same thing on both hosts.
 *
 * **Pixels where the tab decoded it, a picture where something else did.** A tile the page built
 * itself is the window the grade reads, and handing it to the pipeline is one upload; the desktop
 * shell renders through its own process and answers with an HDR AVIF, and that has to stay an
 * `<img>` - a 2D canvas composites in SDR, so drawing it there would clip exactly the highlights a
 * loupe is held over the stage to inspect, where an `<img>` goes through the same compositing path
 * the grid's renditions do.
 */
export type TileArt = { url: string; tile?: undefined } | { tile: LocalTile; url?: undefined };

/** A tile that has arrived, and the part of the frame it holds. */
export interface LoupeTile {
  rect: TileRect;
  art: TileArt;
}

/**
 * Whether a tile still holds everything the glass is showing.
 *
 * **This is what saves the fetch, and the grid is not.** Quantising a tile's origin means two
 * positions a few pixels apart can still fall either side of a grid line, so "names the same
 * tile" is not a property a reader's hand can rely on. What they can rely on is the margin: a
 * tile is half again as wide as the glass, so the glass keeps landing inside the one already
 * held until the pointer has travelled most of that slack.
 */
export function covers(
  tile: TileRect,
  centre: { x: number; y: number },
  span: number,
  frame: { width: number; height: number },
): boolean {
  // Only the part of the glass that is *on the photograph*. Held over a corner it hangs off
  // the edge, and no tile can hold what is not there - demanding it would mean re-fetching for
  // every position near a border and never being satisfied.
  const half = span / 2;
  const left = Math.max(centre.x - half, 0);
  const top = Math.max(centre.y - half, 0);
  const right = Math.min(centre.x + half, frame.width);
  const bottom = Math.min(centre.y + half, frame.height);
  return (
    left >= tile.left &&
    top >= tile.top &&
    right <= tile.left + tile.width &&
    bottom <= tile.top + tile.height
  );
}

/**
 * The rectangle to ask for, given where the loupe is and how far it is magnifying.
 *
 * **Centred on the pointer rather than snapped to a grid.** Quantising the origin looked like
 * the way to make nearby positions share a tile, and it is worse than not doing it: flooring the
 * start to the grid pushes the glass against the tile's far edge, so at some positions there is
 * the whole margin of slack on one side and *none* on the other, and a one-pixel move refetches.
 * Centred, the slack is symmetric and the whole margin is usable in every direction.
 *
 * Nothing is lost by giving up the shared addresses, because a held tile is found by asking
 * which one covers the glass rather than by naming it - so returning to somewhere already
 * fetched still costs nothing.
 */
export function tileFor(
  centre: { x: number; y: number },
  span: number,
  frame: { width: number; height: number },
): TileRect {
  const width = Math.min(Math.round(span * TILE_MARGIN), frame.width);
  const height = Math.min(Math.round(span * TILE_MARGIN), frame.height);
  const start = (value: number, side: number, limit: number): number =>
    Math.round(Math.min(Math.max(value - side / 2, 0), Math.max(limit - side, 0)));
  return {
    left: start(centre.x, width, frame.width),
    top: start(centre.y, height, frame.height),
    width,
    height,
  };
}

export class LoupeTiles {
  /** Insertion-ordered, which a `Map` gives, so the oldest key is the first one. */
  private readonly held = new Map<string, LoupeTile>();
  /**
   * The one request in flight, and the handle that stops it.
   *
   * One rather than a set: see `want`. A pointer outruns the renderer, so anything more than
   * one is a backlog of pictures of places nobody is looking at any more.
   */
  private asking: { at: string; stop: AbortController } | null = null;
  /**
   * What the tiles were rendered against.
   *
   * A tile is a pure function of the photo, the rectangle and the reader's edits, so an edit
   * that would change one makes every held tile wrong at once. Rather than track which, the
   * whole lot goes: they cost 110ms each and an edit is not a thing a reader does between two
   * pointer moves.
   */
  private revision = '';

  constructor(
    private readonly photoId: string,
    /** A `Blob` from a host that encoded one, or the window this tab decoded for itself. */
    private readonly fetchTile: (
      photoId: string,
      rect: TileRect,
      signal: AbortSignal,
    ) => Promise<Blob | LocalTile>,
    private readonly onArrived: () => void,
    /** Whether anything is in flight, so the reader can be told the glass is still sharpening. */
    private readonly onBusy: (busy: boolean) => void = () => {},
  ) {}

  /** Whether anything is in flight, which is all a spinner needs. */
  private settle(): void {
    this.onBusy(this.asking != null);
  }

  /**
   * A tile already here that holds everything the glass is showing, if any.
   *
   * By coverage rather than by name, which is what lets the rectangles be centred on the
   * pointer: two fetches a few pixels apart are different rectangles and either of them answers
   * for both positions.
   *
   * Newest first, so a sweep back and forth finds the tile it just used rather than walking the
   * whole history to reach it.
   */
  covering(
    centre: { x: number; y: number },
    span: number,
    frame: { width: number; height: number },
  ): LoupeTile | null {
    const held = [...this.held.values()];
    for (let at = held.length - 1; at >= 0; at--) {
      const tile = held[at];
      if (tile != null && covers(tile.rect, centre, span, frame)) return tile;
    }
    return null;
  }

  /**
   * Asks for `rect`, replacing whatever was being asked for before.
   *
   * **One request at a time, and a new area supersedes the old one rather than queueing behind
   * it.** A pointer crosses tile boundaries far faster than a tile renders, so a queue is a
   * backlog of pictures of places the reader has already left - and the server renders each in
   * turn whether anyone still wants it, which is 110ms of its time per abandoned tile. The one
   * in flight is aborted when it is superseded, so what is being rendered is always where the
   * glass currently is.
   *
   * Fire and forget: the caller draws whatever it has now, and `onArrived` brings it back when
   * there is something better to draw.
   */
  want(rect: TileRect): void {
    const at = key(rect);
    if (this.held.has(at) || this.asking?.at === at) return;
    // Whatever was in flight is for somewhere the glass has left.
    this.asking?.stop.abort();

    const stop = new AbortController();
    this.asking = { at, stop };
    this.settle();
    // What it is being rendered against, captured now: an edit can land while it is in flight,
    // and what comes back then describes a photograph nobody is looking at any more.
    const against = this.revision;
    void this.fetchTile(this.photoId, rect, stop.signal)
      .then(async (answer): Promise<TileArt> =>
        answer instanceof Blob
          ? { url: await decoded(URL.createObjectURL(answer)) }
          : { tile: answer },
      )
      .then((art) => {
        // Superseded while it was decoding, which the abort cannot reach: whatever is in flight
        // now is the answer, and this one is a picture of the wrong place.
        if (this.asking?.at !== at || against !== this.revision) {
          release(art);
          return;
        }
        this.asking = null;
        this.settle();
        this.held.set(at, { rect, art });
        while (this.held.size > KEPT) {
          const oldest = this.held.keys().next().value;
          if (oldest == null) break;
          const going = this.held.get(oldest);
          if (going != null) release(going.art);
          this.held.delete(oldest);
        }
        this.onArrived();
      })
      .catch(() => {
        // An abort lands here too, and neither it nor a tile that will not render is worth
        // reporting: the editor's own draw is underneath and the reader sees the picture either
        // way. Only the request that is still the current one may clear the slot.
        if (this.asking?.at !== at) return;
        this.asking = null;
        this.settle();
      });
  }

  /**
   * Throws everything away when the edits change.
   *
   * `revision` is whatever the caller says describes the document; any change to it means every
   * held tile was rendered against settings nobody is looking at any more.
   */
  invalidate(revision: string): void {
    if (revision === this.revision) return;
    this.revision = revision;
    this.clear();
  }

  clear(): void {
    for (const tile of this.held.values()) release(tile.art);
    this.held.clear();
    this.asking?.stop.abort();
    this.asking = null;
    this.settle();
  }
}

function key(rect: TileRect): string {
  return `${rect.left},${rect.top},${rect.width},${rect.height}`;
}

/** Pixels are garbage; a picture behind an object URL is not, and is leaked until it is revoked. */
function release(art: TileArt): void {
  if (art.url != null) URL.revokeObjectURL(art.url);
}

/**
 * The URL back, once the picture behind it is decoded and ready to paint.
 *
 * Held here rather than left to the `<img>` in the glass: the tile replaces a picture already on
 * screen, and an element that is handed an undecoded `src` paints nothing until it is ready -
 * which is a blink of the editor's own render at the moment the sharper one arrives.
 */
async function decoded(url: string): Promise<string> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (failed) {
    URL.revokeObjectURL(url);
    throw failed;
  }
  return url;
}
