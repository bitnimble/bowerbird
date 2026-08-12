/**
 * The rendition-quality tiles the loupe magnifies, fetched and kept.
 *
 * The editor's own denoise is the sRGB one, which is cruder than the mosaic denoise a rendition
 * gets - deliberately, since it has to run per tick in a browser (DESIGN 10.9.1). A loupe is
 * where that difference matters, so the glass shows the *export's* pixels: the server renders
 * the crop through the rendition pipeline and this holds what came back.
 *
 * **Tiles are larger than the glass, and that is what hides the latency.** A tile costs about
 * 110ms, so fetching exactly what is under the pointer would mean a fetch on every move. A tile
 * quantised to a grid and grown past the loupe's own span is one fetch per grid square, and the
 * moves in between are answered from what is already here.
 *
 * Nothing here decides *when* to show a tile. The presenter draws its own render underneath and
 * the tile over it once it lands, so a move that outruns the network is a picture that sharpens
 * rather than a hole.
 */

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
 * A tile is a few hundred kilobytes of decoded bitmap, and the ones worth keeping are the ones
 * around wherever the reader has been looking - so this is "a sweep across a photograph and
 * back" rather than a memory budget.
 */
const KEPT = 24;

export interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A tile that has arrived, and the part of the frame it holds. */
export interface LoupeTile {
  rect: TileRect;
  bitmap: ImageBitmap;
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
  private readonly asking = new Set<string>();
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
    private readonly fetchTile: (photoId: string, rect: TileRect) => Promise<Blob>,
    private readonly onArrived: () => void,
  ) {}

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
   * Asks for `rect` unless it is held or already in flight.
   *
   * Fire and forget: the caller draws whatever it has now, and `onArrived` brings it back when
   * there is something better to draw.
   */
  want(rect: TileRect): void {
    const at = key(rect);
    if (this.held.has(at) || this.asking.has(at)) return;
    this.asking.add(at);
    // What it is being rendered against, captured now: an edit can land while it is in flight,
    // and what comes back then describes a photograph nobody is looking at any more.
    const against = this.revision;
    void this.fetchTile(this.photoId, rect)
      .then(async (blob) => createImageBitmap(blob))
      .then((bitmap) => {
        this.asking.delete(at);
        if (against !== this.revision) {
          bitmap.close();
          return;
        }
        this.held.set(at, { rect, bitmap });
        while (this.held.size > KEPT) {
          const oldest = this.held.keys().next().value;
          if (oldest == null) break;
          this.held.get(oldest)?.bitmap.close();
          this.held.delete(oldest);
        }
        this.onArrived();
      })
      .catch(() => {
        // A tile that will not render is not worth reporting: the editor's own draw is
        // underneath it and the reader sees the picture either way.
        this.asking.delete(at);
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
    for (const tile of this.held.values()) tile.bitmap.close();
    this.held.clear();
    this.asking.clear();
  }
}

function key(rect: TileRect): string {
  return `${rect.left},${rect.top},${rect.width},${rect.height}`;
}
