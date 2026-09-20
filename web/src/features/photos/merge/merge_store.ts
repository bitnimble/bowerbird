import { comparer, computed, observable } from 'mobx';
import { DEFAULT_FEATHER, type AssemblyRecipe, type Seams, type Takes } from '../../../../../src/schemas/assembly';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { layersOf, type Drawing, type Piece } from './merge_layers';
import { NO_SHIFT, shiftOf, type Shift } from './merge_rect';
import type { Decoded } from '../viewer/stage_bitmaps';

export interface Swatch {
  source: number;
  photoId: string;
  /** The frame's own file, or its id where the summary naming it has not arrived. */
  name: string;
}

type Loop = [number, number][];

/** What `MergeStore.solved` is keyed by. */
export function seamsKey(geometry: string, feather: number, base: number, picks: readonly number[]): string {
  return `${geometry}|${feather}|${base}:${picks.join(',')}`;
}

/** What tile `tile` asks its pick for, a recipe written before removal existed asking for its subject. */
export function takesOf(recipe: AssemblyRecipe, tile: number): Takes {
  return recipe.takes?.[tile] ?? 'subject';
}

/** Seams, and the `MergeStore.geometry` they were solved over. */
export interface Solved {
  seams: Seams;
  geometry: string;
}

/** A drawn piece's outline, and the tile a click on it opens. */
export interface PiecePath {
  tile: number | null;
  d: string;
}

/** Observables and computeds only. Every mutation is on MergePresenter. */
export class MergeStore {
  @observable.ref accessor recipe: AssemblyRecipe | null = null;
  /**
   * Per tile, the source index it currently draws from. Independent of `recipe.pick`, which is
   * only ever the analysis's own starting point.
   */
  @observable accessor picks: number[] = [];
  @observable accessor base = 0;
  /** Every seams solved this visit, by `seamsKey` of the geometry, base and picks they were solved for. */
  @observable.shallow accessor solved = new Map<string, Solved>();
  /** Pick sets the server refused to solve, which asking again would only have refused again. */
  @observable.shallow accessor unsolvable = new Set<string>();
  /** Pick sets whose request failed, asked for again at the next draw. */
  @observable.shallow accessor unanswered = new Set<string>();
  /** Nothing can be solved - no volume, or it was reaped - so the tiles are drawn as they are. */
  @observable accessor unseamed = false;
  /** The analysis found the frames were not taken from one place (§3.1). */
  @observable accessor unaligned = false;
  @observable accessor hoveredTile: number | null = null;
  @observable accessor hoveredSwatch: number | null = null;
  @observable accessor openTile: number | null = null;
  @observable accessor canUndo = false;
  @observable accessor canRedo = false;
  @observable accessor readOnly = false;
  @observable accessor showingLines = true;
  /** Whether a click seeds a tile asking for the ground in place of what is there. */
  @observable accessor removing = false;
  @observable accessor status: 'loading' | 'analysing' | 'ready' | 'error' | 'read-only' = 'loading';
  @observable accessor loadError: string | null = null;
  /** `[0, 1]` while `status === 'analysing'`. */
  @observable accessor progress = 0;
  /** By photograph id, which is what names a swatch after the file its frame came from. */
  @observable.shallow accessor frames = new Map<string, PhotoSummary>();
  /** By source index, the decoded analysis plane the compositor draws. */
  @observable.shallow accessor layers = new Map<number, Decoded>();
  /** The same planes as pictures the browser loads for itself, which is what a swatch is cut from. */
  @observable accessor layerUrls: string[] = [];
  /** Sources a finished assembly named that no longer exist or are binned. */
  @observable accessor missingSources: string[] = [];
  /**
   * The first loaded layer's own pixel size, which is the analysis scale the SVG overlay and the
   * mask draw at - read off a decoded `VideoFrame`/`ImageBitmap`, never off the DOM.
   */
  @observable.ref accessor layerSize: { width: number; height: number } | null = null;

  /**
   * Analysis-plane pixels per recipe-canvas pixel. 1 where nothing has decoded yet, so outlines
   * degrade to the recipe's own (larger) coordinates rather than dividing by zero.
   */
  @computed get layerScale(): { x: number; y: number } {
    const canvas = this.recipe?.canvas;
    const size = this.layerSize;
    if (canvas == null || size == null) return { x: 1, y: 1 };
    return { x: size.width / canvas[0], y: size.height / canvas[1] };
  }

  /**
   * The feather the page's seams are balanced over: the slider's once it is let go, where
   * `feather` follows it while it moves.
   */
  @observable accessor balancedFeather = DEFAULT_FEATHER;

  /** `AssemblyRecipe.feather`, as the render reads it. */
  @computed get feather(): number {
    return this.recipe?.feather ?? DEFAULT_FEATHER;
  }

  /** `seamsKey` of `picks` over the tiles, feather and base the page has now. */
  keyOf(picks: readonly number[]): string {
    return seamsKey(this.geometry, this.balancedFeather, this.base, picks);
  }

  /**
   * The tiles, hashed: what a solve is a function of besides the picks.
   *
   * What each asks for as well as its outline, since a tile is seeded as one or the other and never
   * changes - and a seam solved for a subject is another shape from one solved for the ground.
   */
  @computed get geometry(): string {
    const recipe = this.recipe;
    if (recipe == null) return '';
    const tiles = recipe.tiles.map((loop, tile) => [loop.map((v) => recipe.vertices[v]), takesOf(recipe, tile)]);
    return hashOf(JSON.stringify(tiles));
  }

  /** One tile outline per tile, in the decoded layer's own pixels. */
  @computed get tilePolygons(): Loop[] {
    const recipe = this.recipe;
    if (recipe == null) return [];
    return recipe.tiles.map((loop) => this.onLayer(recipe.vertices, loop));
  }

  /** Each tile's pick, with the hovered swatch standing in for the open tile's: what the canvas shows. */
  @computed get shownPicks(): number[] {
    const hovered = this.hoveredSwatch;
    const open = this.openTile;
    if (open == null || hovered == null) return this.picks;
    return this.picks.map((source, tile) => (tile === open ? hovered : source));
  }

  /**
   * The seams the canvas draws: exactly what is shown where that is solved, else the page's own
   * picks', else either balanced for another feather, else the latest solved over these tiles, else
   * the latest over any - so a swatch, a seed or a feather not yet solved leaves the picture as it
   * stands rather than showing an unsolved tile.
   */
  @computed get drawnSeams(): Solved | null {
    const { geometry, base } = this;
    const exact = this.solved.get(this.keyOf(this.shownPicks));
    const own = this.solved.get(this.keyOf(this.picks));
    if (exact != null || own != null) return exact ?? own!;
    const wanted = [this.shownPicks.join(), this.picks.join()];
    let rebalancing: Solved | null = null;
    let here: Solved | null = null;
    let anywhere: Solved | null = null;
    for (const held of this.solved.values()) {
      if (held.seams.base !== base) continue;
      anywhere = held;
      if (held.geometry !== geometry) continue;
      here = held;
      if (wanted.includes(held.seams.pick.join())) rebalancing = held;
    }
    return rebalancing ?? here ?? anywhere;
  }

  /**
   * What the canvas shows: the base layer, then each source something picks, masked to where it is
   * taken in `drawnSeams` - with the hovered swatch substituted for the open tile's own pick, which
   * is what makes a hover a preview rather than a commit - or the tiles themselves where nothing can
   * be solved.
   */
  @computed({ equals: comparer.structural }) get drawing(): Drawing {
    const { recipe, base, drawnSeams: drawn } = this;
    if (recipe == null) return { base, layers: [] };
    const picks = this.shownPicks;
    // In the analysis plane's pixels, which is what the compositor rasterises onto: the same ratio
    // `pieces` scales the SVG overlay by, so the mask and the outline agree.
    const { x: sx, y: sy } = this.layerScale;
    // A tile has no corridor of its own, as `Assembly::rendered` draws one.
    const pieces: Piece[] =
      this.unseamed ?
        recipe.tiles.map((loop, t) => ({
          source: picks[t]!,
          loop: this.onLayer(recipe.vertices, loop),
          shift: NO_SHIFT,
          gain: 1,
          corridor: 0,
        }))
      : drawn == null ? []
      : drawn.seams.tiles.map((loop, p) => ({
          source: drawn.seams.source[p]!,
          loop: this.onLayer(drawn.seams.vertices, loop),
          shift: shiftOf(drawn.seams.warp[p]!, sx, sy),
          gain: drawn.seams.exposure[p]!,
          corridor: drawn.seams.corridor[p]!,
        }));
    const long = Math.max(this.layerSize?.width ?? 0, this.layerSize?.height ?? 0);
    return { base, layers: layersOf(pieces, base, long, this.feather) };
  }

  /**
   * What the overlay outlines and a click opens: the solved pieces, each opening the tile it lies
   * under while that tile still exists - or the tiles themselves where nothing can be solved.
   */
  @computed get pieces(): PiecePath[] {
    if (this.unseamed) return this.tilePolygons.map((loop, tile) => ({ tile, d: pathOf(loop) }));
    const drawn = this.drawnSeams;
    if (drawn == null) return [];
    const current = drawn.geometry === this.geometry;
    return drawn.seams.tiles.map((loop, piece) => ({
      tile: current ? drawn.seams.zone[piece]! : null,
      d: pathOf(this.onLayer(drawn.seams.vertices, loop)),
    }));
  }

  /** The open tile's swatches, one per source, in capture order (`recipe.sources`' own order). */
  @computed get swatches(): Swatch[] {
    const recipe = this.recipe;
    if (recipe == null || this.openTile == null) return [];
    return recipe.sources.map((source, index) => {
      const path = this.frames.get(source.photoId)?.file_path;
      const name = path?.split('/').pop() ?? source.photoId;
      return { source: index, photoId: source.photoId, name };
    });
  }

  /** Whether some frame's growth of the open tile is still being solved, so its swatches would be the seed's. */
  @computed get searching(): boolean {
    const recipe = this.recipe;
    const tile = this.openTile;
    if (recipe?.seamVolume == null || tile == null || this.readOnly || this.unseamed) return false;
    return recipe.sources.some((_, source) => {
      const key = this.keyOf(this.picks.map((held, at) => (at === tile ? source : held)));
      return !this.solved.has(key) && !this.unsolvable.has(key) && !this.unanswered.has(key);
    });
  }

  /**
   * The open tile as `source` would grow it, in the layer's pixels: its piece in the seams solved
   * for that pick, else the largest any other frame's solve grew it to, else its seed.
   */
  outlineFor(source: number): Loop {
    const tile = this.openTile;
    if (tile == null) return [];
    return this.grownBy(tile, source)?.loop ?? this.grownOpen ?? this.tilePolygons[tile] ?? [];
  }

  /** `outlineFor(source)` where `source`'s layer is read for it: moved by its piece's shift. */
  readFor(source: number): Loop {
    const tile = this.openTile;
    const shift = tile == null ? NO_SHIFT : (this.grownBy(tile, source)?.shift ?? NO_SHIFT);
    return this.outlineFor(source).map(([x, y]) => [x + shift[0], y + shift[1]]);
  }

  /** The open tile at its largest across every frame solved for it, which the flyout keeps clear of. */
  @computed get grownOpen(): Loop | null {
    const sources = this.recipe?.sources.length ?? 0;
    const tile = this.openTile;
    if (tile == null) return null;
    let largest: Loop | null = null;
    for (let source = 0; source < sources; source++) {
      const loop = this.grownBy(tile, source)?.loop;
      if (loop != null && (largest == null || areaOf(loop) > areaOf(largest))) largest = loop;
    }
    return largest;
  }

  /** `tile`'s largest piece in the seams solved with it on `source`, and where that piece is read. */
  private grownBy(tile: number, source: number): { loop: Loop; shift: Shift } | null {
    const picks = this.picks.map((held, at) => (at === tile ? source : held));
    const seams = this.solved.get(this.keyOf(picks))?.seams;
    if (seams == null) return null;
    const { x: sx, y: sy } = this.layerScale;
    let largest: { loop: Loop; shift: Shift } | null = null;
    seams.tiles.forEach((loop, piece) => {
      if (seams.zone[piece] !== tile) return;
      const outline = this.onLayer(seams.vertices, loop);
      if (largest != null && areaOf(outline) <= areaOf(largest.loop)) return;
      largest = { loop: outline, shift: shiftOf(seams.warp[piece]!, sx, sy) };
    });
    return largest;
  }

  private onLayer(vertices: readonly (readonly [number, number])[], loop: readonly number[]): Loop {
    const { x: sx, y: sy } = this.layerScale;
    return loop.map((v) => [vertices[v]![0] * sx, vertices[v]![1] * sy]);
  }
}

/** cyrb53, a 53-bit string hash. */
function hashOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function pathOf(loop: Loop): string {
  return `M${loop.map(([x, y]) => `${x},${y}`).join('L')}Z`;
}

function areaOf(loop: Loop): number {
  let sum = 0;
  loop.forEach(([x0, y0], at) => {
    const [x1, y1] = loop[(at + 1) % loop.length]!;
    sum += x0 * y1 - x1 * y0;
  });
  return Math.abs(sum) / 2;
}
