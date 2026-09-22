import { computed, observable } from 'mobx';
import { type Span, visibleRows } from '../../../ui/virtual_rows';
import { type Band, type Expansion, type GridSection, sectionsIn, totalRows } from '../grid/bands';
import { GRID_GAP, gridRowHeight, stripCellWidth } from '../grid/grid_layout';
import type { ListingStore } from '../grid/listing_store';
import type { StacksStore } from '../grid/stacks_store';
import type { ViewerStore } from './viewer_store';
import { ScrollRailStore } from '../grid/scroll_rail_store';

/** How thick the strip is across its cells, and so how big a cell is. The range its edge drags over. */
export const STRIP_MIN_THICKNESS = 64;
export const STRIP_MAX_THICKNESS = 260;
export const STRIP_DEFAULT_THICKNESS = 104;

/**
 * How much of the strip an open stack's own cell keeps.
 *
 * The one cell of the strip that is not a photograph: a stack's tile shows the
 * frame the band beside it opens with, so drawn full width it is the same
 * photograph twice in a row of a hundred thousand.
 */
export const STRIP_SPINE = 20;

/**
 * The viewer's filmstrip: the whole collection, one row of it, scrolled along
 * whichever edge leaves the photograph biggest (DESIGN §18.5).
 *
 * **The gallery's geometry with a column count of one.** The rail that makes a
 * hundred thousand photographs scrollable, the band arithmetic that opens a stack
 * in place, the walk that turns a span of display rows into sections to draw - all
 * of it takes the count as a parameter, so the strip is those same functions asked
 * a one-column question rather than a second implementation of them. What it adds
 * is which axis, and even that is mostly a name: `visibleRows` counts rows of a
 * pitch, and a strip's pitch is a width when it lies along the foot.
 *
 * A peer of the photo stores rather than part of them: the two views scroll the same
 * collection to different places, and one set of rail observables between them
 * would land the gallery wherever the strip had been left.
 *
 * Observables and computeds only. Every mutation is on StripViewPresenter.
 */
export class StripViewStore {
  constructor(
    private readonly listing: ListingStore,
    private readonly stacks: StacksStore,
    private readonly viewer: ViewerStore,
  ) {}

  readonly rail = new ScrollRailStore(
    () => this.contentLength,
    () => this.viewportLength,
  );

  /**
   * Which way the strip runs: `x` along the foot, `y` down the side.
   *
   * The trade the metadata panels are placed by, priced for a strip and taken
   * over the whole frame (`stripEdge`): a hundred pixels of thickness buys its
   * way under a frame that a 320px column could not fit beneath, and the panels
   * place themselves in what is left.
   */
  @observable accessor axis: 'x' | 'y' = 'x';

  /** How thick the strip is drawn, across its cells. What `StripResizer` moves. */
  @observable accessor thickness = STRIP_DEFAULT_THICKNESS;

  // The strip's own box, from its ResizeObserver. The cell is sized from whichever
  // of these is across the cells, so the reader gets the cell the strip actually
  // has room for rather than the one the setting asked for.
  @observable accessor viewportWidth = 0;
  @observable accessor viewportHeight = 0;

  /** One row, which is what makes every band function above answer for a strip. */
  readonly columns = 1;

  /** How much of the collection the viewport shows, along the axis it scrolls. */
  @computed get viewportLength(): number {
    return this.axis === 'x' ? this.viewportWidth : this.viewportHeight;
  }

  /** The strip's measured extent across its cells, which is what sizes one. */
  @computed get across(): number {
    return this.axis === 'x' ? this.viewportHeight : this.viewportWidth;
  }

  /** One cell plus the gap after it, along the axis the strip scrolls. */
  @computed get pitch(): number {
    return this.axis === 'x' ? stripCellWidth(this.across) : gridRowHeight(this.across, this.columns);
  }

  @computed get bands(): Band[] {
    return this.listing.bands;
  }

  /** Cells in the strip: the collection, plus the members every open stack inserts. */
  @computed get cellCount(): number {
    return totalRows(this.listing.total, this.bands, this.columns);
  }

  /** The cells drawn as a spine rather than a photograph: every open stack's own. */
  @computed get spines(): number[] {
    return [...this.stacks.expansions.values()].map((open) => this.displayCellOf(open.position));
  }

  /** What one spine takes off the strip, and off everything drawn after it. */
  @computed private get spineSaving(): number {
    return Math.max(0, this.pitch - (STRIP_SPINE + GRID_GAP));
  }

  @computed get contentLength(): number {
    if (this.cellCount === 0) return 0;
    return this.cellCount * this.pitch - GRID_GAP - this.spines.length * this.spineSaving;
  }

  /**
   * Where a cell is drawn, in content pixels: a multiplication, less whatever the
   * spines before it gave back.
   */
  offsetOfCell(cell: number): number {
    let at = cell * this.pitch;
    for (const spine of this.spines) if (spine < cell) at -= this.spineSaving;
    return at;
  }

  // A span of cells wide enough to cover the viewport whatever the spines have
  // pulled back into it. Uniform arithmetic over a strip whose cells are not all
  // one width answers a cell early at the leading edge and a cell short at the
  // trailing one, so the viewport is asked about as though every spine's saving
  // were still in front of it: a superset, which costs a mounted tile or two.
  @computed get visibleSpan(): Span {
    const reach = this.viewportLength + this.spines.length * this.spineSaving;
    return visibleRows(this.rail.at, reach, this.pitch, this.cellCount);
  }

  @computed get sections(): GridSection[] {
    const sections = sectionsIn(this.visibleSpan, {
      bands: this.bands,
      columns: this.columns,
      total: this.listing.total,
      rowHeight: this.pitch,
      expansionAt: (position) => this.stacks.expansionAt(position),
    });
    if (this.pitch <= 0) return sections;
    // One row is one cell here, so a section's top names the cell it starts at.
    return sections.map((section) => ({ ...section, top: this.offsetOfCell(section.top / this.pitch) }));
  }

  /** The positions the strip actually renders, which is what its rows are fetched for. */
  @computed get visible(): Span {
    const runs = this.sections.filter((section): section is Extract<GridSection, { kind: 'grid' }> => section.kind === 'grid');
    const first = runs[0];
    const last = runs.at(-1);
    if (first == null || last == null) {
      // A band long enough to fill the strip leaves no run of the collection to
      // read a span from; the stack's own row is the one the reader is inside.
      const anchor = this.sections[0];
      const position = anchor?.kind === 'band' ? anchor.position : 0;
      return { from: position, to: Math.min(this.listing.total, position + 1) };
    }
    return { from: first.from, to: last.to };
  }

  /** Where a position is drawn, in content pixels, with the open bands in. */
  offsetOf(position: number): number {
    return this.offsetOfCell(this.displayCellOf(position));
  }

  /** Which cell of the strip a photograph is drawn in: its own, or its band's. */
  displayCellOf(position: number): number {
    let cell = position;
    for (const band of this.bands) if (band.position < position) cell += band.members;
    return cell;
  }

  /** Where in an open band a photo id sits, or null for one that is not in a band. */
  memberCellOf(photoId: string): number | null {
    for (const open of this.stacks.expansions.values()) {
      const at = open.photos.findIndex((photo) => photo.id === photoId);
      if (at >= 0) return this.displayCellOf(open.position) + 1 + at;
    }
    return null;
  }

  /**
   * Which cell holds the photograph the viewer has open, or null where the strip
   * cannot place it - a collapsed row this client has not loaded.
   */
  cellOf(photoId: string): number | null {
    const member = this.memberCellOf(photoId);
    if (member != null) return member;
    const position = this.listing.indexOf(photoId);
    return position < 0 ? null : this.displayCellOf(position);
  }

  expansionAt(position: number): Expansion | null {
    return this.stacks.expansionAt(position);
  }

  /**
   * The stack the viewer's photograph belongs to, whose band has to be open for
   * the strip to have a cell for it at all (`StripViewPresenter.watch`).
   *
   * Null in an uncollapsed listing, where every member has a row of its own
   * (§19.5.4) and there are no bands to open.
   */
  @computed get openPhotoStack(): string | null {
    if (this.listing.expandStacks) return null;
    const photoId = this.viewer.open?.id;
    if (photoId == null) return null;
    return this.viewer.photoFor(photoId)?.stack_id ?? null;
  }
}
