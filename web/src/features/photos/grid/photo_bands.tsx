import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { useListingStore, useMarksStore, useStacksStore } from '../../../app/stores_context';
import type { ListingStore } from './listing_store';
import type { MarksStore } from './marks_store';
import type { StacksStore } from './stacks_store';
import type { Expansion } from './bands';
import {
  BAND_LINE_CAP,
  BLOCK,
  GRID_GAP,
  TILE_ASPECT,
  TILE_PAD,
  masonryBlockEnd,
  masonryLineStarts,
} from './grid_layout';
import { PhotoGridStrings } from './photo_grid.strings';
import { band, bandColourOf, cells, tile, type Layout } from './photo_grid_styles';
import { BandMember, PhotoTile, aspectOf, cellStyle, ringStyle } from './photo_tile';

// The tiles for one span of the collection. A row the client is not holding -
// evicted behind the scroll, or still in flight - keeps its place as an empty
// cell rather than closing the gap, so nothing shifts under the reader when it
// lands.
export function tilesFor(
  listing: ListingStore,
  marks: MarksStore,
  stacks: StacksStore,
  from: number,
  to: number,
  layout: Layout,
  final = true,
): JSX.Element[] {
  const tiles: JSX.Element[] = [];
  const masonry = layout === 'masonry';
  // Masonry has no row model to hang a band off, so an open stack's members take
  // a full-width band on the block's own flex line. It waits for the end of the
  // line its tile sits on rather than following that tile straight away: a band
  // in the middle of a line cuts it short, and the tiles left on it take the
  // space the band walked off with (§19.6). Which tile ends a line is the one
  // thing the shapes decide rather than the row arithmetic, so it is replayed
  // from them - still no measurement.
  const lineStarts = masonry
    ? masonryLineStarts(ratiosFor(listing, from, to), listing.viewportWidth, listing.tileSize)
    : new Set<number>();
  const pending: Expansion[] = [];
  const flush = (last: boolean): void => {
    if (pending.length === 0) return;
    // The block's own ::after is what leaves its last line at the size the photos
    // want rather than stretched across the width; a band after that line takes
    // the ::after off it, so the line is given one of its own.
    if (last) tiles.push(<span key="line-end" {...stylex.props(cells.lineEnd)} aria-hidden="true" />);
    // The first of a line's bands is the one drawn joined to its tile: the others
    // are separated from theirs by a band, and their colour is what pairs them.
    for (const [i, open] of pending.splice(0).entries())
      tiles.push(<BandTiles key={`band-${open.stackId}`} expansion={open} fused={i === 0} />);
  };

  for (let index = from; index < to; index++) {
    if (lineStarts.has(index - from)) flush(false);
    const photo = listing.rows.get(index);
    if (photo == null) {
      // Still carries the selection ring: the selection is positions, so it
      // covers rows this client has never held, and a blank cell reading as
      // unselected in the middle of "select all" would be a lie about what the
      // next action is going to touch.
      tiles.push(
        <div
          key={index}
          {...stylex.props(
            cellStyle(layout, TILE_ASPECT, listing.tileSize),
            tile.waiting,
            ringStyle(marks.selection.has(index), false, false, false),
          )}
          role="listitem"
          aria-busy
          aria-setsize={listing.total}
          aria-posinset={index + 1}
        />,
      );
      continue;
    }
    const open = masonry ? stacks.expansionAt(index) : null;
    // In masonry the joined band is the first one open on the line, since a line's
    // bands follow it in a run; with a row model the store answers it (§19.6).
    const fused = masonry
      ? open != null && pending.length === 0
      : photo.stack_id != null && listing.fusedStacks.has(photo.stack_id);
    tiles.push(<PhotoTile key={photo.id} photo={photo} index={index} isFocused={marks.focusIndex === index} fused={fused} />);
    if (open != null) pending.push(open);
  }
  // Whatever is still open on the block's last line, which has no line after it
  // to be flushed by. Only a *final* block's last line wants an end of its own:
  // the rest justify, so there is no ::after for a band to walk off with.
  flush(final);
  return tiles;
}

// The shapes the wrap is replayed from. A row the client is not holding is the
// 3:2 its waiting cell is drawn at, so a page landing under the reader does not
// move a line break that was already decided.
function ratiosFor(store: ListingStore, from: number, to: number): number[] {
  const ratios: number[] = [];
  for (let index = from; index < to; index++) ratios.push(ratioAt(store, index));
  return ratios;
}

function ratioAt(store: ListingStore, index: number): number {
  const photo = store.rows.get(index);
  return photo == null ? TILE_ASPECT : aspectOf(photo);
}

/**
 * Where a joined band cuts the gap in its top edge, and whether that cut reaches
 * either end of the band (§19.6).
 *
 * At an end, the tile's own edge and the band's are the same edge: the line runs
 * straight through, so that corner squares off and there is no fillet to make room
 * for. In the middle, both junctions are interior corners.
 *
 * Two ways of knowing where the tile is. With a row model it is a column, so the
 * offsets are arithmetic CSS can do from the count alone. In masonry it is whatever
 * the line's packing made it, which the tile measures and reports
 * (`stackTileBoxes`); until that lands there is nothing to cut, so the band is
 * drawn whole for a frame.
 */
function joinTo(
  listing: ListingStore,
  stacks: StacksStore,
  expansion: Expansion,
  placed: boolean,
): { first: boolean; last: boolean; at: stylex.StyleXStyles } | null {
  if (!placed) {
    const box = stacks.stackTileBoxes.get(expansion.stackId);
    if (box == null) return null;
    return {
      first: box.x <= 0.5,
      last: box.x + box.width >= listing.viewportWidth - 0.5,
      at: band.measured(box.x, box.width),
    };
  }
  const column = expansion.position % listing.columns;
  return {
    first: column === 0,
    last: column === listing.columns - 1,
    at: band.column(listing.columns, column),
  };
}

export function sectionStyle(layout: Layout, columns: number): stylex.StyleXStyles {
  switch (layout) {
    case 'grid':
      return [cells.section, cells.grid, cells.columns(columns)];
    case 'masonry':
      return [cells.section, cells.masonry];
    case 'list':
      return [cells.section, cells.list];
    case 'x':
      return [cells.section, cells.x];
    case 'y':
      return [cells.section, cells.y];
  }
}

// The members of one open stack, as a band. Without a top it is masonry's: a
// full-width item inside the block's own flex line, rather than a section the
// row arithmetic placed at a height of its own.
export const BandTiles = observer(function BandTiles({
  expansion,
  top,
  fused,
}: {
  expansion: Expansion;
  top?: number;
  /** Whether this band is the one drawn joined to its own tile (§19.6). */
  fused: boolean;
}): JSX.Element {
  const store = useListingStore();
  const stacks = useStacksStore();
  const placed = top != null;
  const join = fused ? joinTo(store, stacks, expansion, placed) : null;
  // How tall a line of members may get, in masonry only: nothing there bounds one,
  // so a band of two portrait frames stretched to the width of the grid and drew
  // the stack several times the size of the collection around it. Against the
  // stack's own tile, which is the size the reader is already looking at.
  const cap = placed ? null : stacks.stackTileBoxes.get(expansion.stackId)?.height;

  return (
    <div
      {...stylex.props(
        sectionStyle(store.mode, store.columns),
        band.band,
        placed ? [cells.window, cells.down(store.rail.positionOf(top))] : band.inline,
        store.mode === 'list' && band.list,
        bandColourOf(store.bandColours.get(expansion.stackId)),
        join != null && [band.fused, join.at, join.first && band.fuseFirst, join.last && band.fuseLast],
        // Photograph against photograph: masonry's cap bounds the picture inside the
        // cell, so the tile's own pad comes off before the comparison.
        cap != null && band.cap((cap - 2 * TILE_PAD) * BAND_LINE_CAP),
        // A band gets exactly the display rows the row arithmetic gave it, and its
        // cells are the collection's own.
        cells.rows(store.rowHeight - GRID_GAP),
      )}
      role="group"
      aria-label={
        expansion.composite != null
          ? PhotoGridStrings.frameBandLabel(expansion.photos.length, expansion.composite)
          : PhotoGridStrings.bandLabel(expansion.photos.length)
      }
    >
      {/* The interior corners of the join, which are concave and so cannot be a
          radius on either box (§19.6). Out of the grid's flow, being absolute, and
          only on a side that has one: at an end of the band the line runs straight
          through. */}
      {join != null && !join.first && <span {...stylex.props(band.join, band.joinLeft)} aria-hidden="true" />}
      {join != null && !join.last && <span {...stylex.props(band.join, band.joinRight)} aria-hidden="true" />}
      {expansion.photos.map((photo) => (
        <BandMember key={photo.id} photo={photo} />
      ))}
    </div>
  );
});

// Masonry packs its lines from each photo's own shape, so a block's height is
// not arithmetic the way a uniform row's is - it has to be laid out to be known.
// One block is one flex container, the shape the whole grid would be, and it
// reports the height it settled at so the scroll above and below it is built
// from a measurement rather than a guess (§18.3.2).
export const MasonryBlock = observer(function MasonryBlock({
  block,
  top,
  onMeasured,
  onPacked,
}: {
  block: number;
  top: number;
  onMeasured: (block: number, height: number, width: number) => void;
  onPacked: (block: number, end: number) => void;
}): JSX.Element {
  const store = useListingStore();
  const marks = useMarksStore();
  const stacks = useStacksStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element == null) return;
    // An observer rather than a read after paint: the height arrives in the
    // entry, so learning what masonry packed never forces a layout.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box != null && box.height > 0) onMeasured(block, box.height, box.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [block, onMeasured]);

  const from = store.startOf(block);
  const last = block >= store.blockCount - 1;
  const end = last
    ? store.total
    : Math.min(
        // Never past where the block after next starts by default, which a line of
        // more than BLOCK tiles would otherwise reach: two blocks would then draw
        // the same photographs, at the same keys.
        (block + 2) * BLOCK,
        from +
          masonryBlockEnd(
            (offset) => ratioAt(store, from + offset),
            store.total - from,
            store.viewportWidth,
            store.tileSize,
            (block + 1) * BLOCK - from,
          ),
      );

  useEffect(() => {
    // A width of zero packs one tile per line, and a block start recorded from that
    // outlives the measurement that would correct it.
    if (!last && store.viewportWidth > 0) onPacked(block, end);
  }, [block, end, last, store.viewportWidth, onPacked]);

  return (
    <div
      ref={ref}
      {...stylex.props(sectionStyle('masonry', store.columns), cells.block, !last && cells.continues, cells.top(top))}
      role="presentation"
    >
      {tilesFor(store, marks, stacks, from, end, 'masonry', last)}
    </div>
  );
});
