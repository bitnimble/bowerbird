import * as stylex from '@stylexjs/stylex';
import { comparer, reaction, when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useListingStore, useMarksStore, usePresenters, useStacksStore } from '../../../app/stores_context';
import { EmptyState } from '../../../ui/empty_state';
import { focusRing } from '../../../ui/focus_ring';
import { Text } from '../../../ui/text';
import { GRID_GAP } from './grid_layout';
import { asksAnything, gridUrlHref, readGridUrl, type GridUrl } from './grid_url';
import { PhotoGridStrings } from './photo_grid.strings';
import type { ListingStore } from './listing_store';
import type { Span } from '../../../ui/virtual_rows';
import { cells, viewport } from './photo_grid_styles';
import { BandTiles, MasonryBlock, sectionStyle, tilesFor } from './photo_bands';
import { GridScrollbar } from './grid_scrollbar';
import { GridKeys } from './grid_keys';

// The scrollers' ids, so each drawn scrollbar can name what it controls.
const SCROLLER_ID = 'grid-scroller';

const URL_SETTLE_MS = 250;

function gridUrlState(store: ListingStore): GridUrl {
  const { search, takenFrom, takenTo } = store.filters;
  return { at: store.topPosition, filters: { search, takenFrom, takenTo } };
}

function writeGridUrl(state: GridUrl): void {
  const href = gridUrlHref(window.location.href, state);
  if (href === window.location.href) return;
  // Straight at the history entry rather than through the router: a router write
  // re-renders the route, and every mounted tile with it, on every scroll that
  // settles.
  window.history.replaceState(window.history.state, '', href);
}

/**
 * The photos the reader can actually see, as a half-open span of positions, or
 * null when the grid is not on screen at all.
 *
 * Measured, which for once is the only way: the store's `visible` is what is
 * *mounted*, and that is deliberately more - two overscan rows either side in
 * grid and list, and whole hundred-photo blocks in masonry, whose tiles are
 * packed from their own shapes and so have no arithmetic position to test. Read
 * on a click and nowhere else, so the forced layout costs nothing that matters.
 */
export function onScreenSpan(): Span | null {
  const scroller = document.getElementById(SCROLLER_ID);
  if (scroller == null) return null;
  const box = scroller.getBoundingClientRect();
  let from = Infinity;
  let to = -Infinity;
  for (const cell of scroller.querySelectorAll<HTMLElement>('[aria-posinset]')) {
    const rect = cell.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const index = Number(cell.getAttribute('aria-posinset')) - 1;
    from = Math.min(from, index);
    to = Math.max(to, index);
  }
  return from > to ? null : { from, to: to + 1 };
}

export const PhotoGrid = observer(function PhotoGrid({ emptyHint }: { emptyHint: string }): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();

  // Where the reader was and what they were asking, out of the address bar and
  // back into it.
  //
  // Restored only into an empty store, which is what a load of the page is. With
  // a collection already in hand this URL is the one it was left at and the store
  // is already what the URL says, so there is nothing to put back - and this
  // effect does not run again for the collection after, `PhotoGrid` staying
  // mounted from one library to the next, so a restore left armed here would fire
  // against whichever collection was opened next and scroll it to a position out
  // of this one.
  //
  // Here rather than in the scroller, which is not mounted until the collection
  // has arrived, by which time there is nothing left to wait for. The position
  // waits again, for a length and a scroller with a box: it becomes pixels
  // through the row height and the block heights, and a filter renumbers every
  // position there is, so it can only go back once the filter has.
  useEffect(() => {
    const disposers = [
      reaction(() => gridUrlState(store), writeGridUrl, { delay: URL_SETTLE_MS, equals: comparer.structural }),
    ];
    if (store.source == null) {
      const asked = readGridUrl(window.location.search);
      disposers.push(
        when(
          () => store.source != null,
          () => {
            if (asksAnything(asked.filters)) void photos.setFilters({ ...store.filters, ...asked.filters });
            if (asked.at > 0) {
              disposers.push(
                when(
                  () => store.total > 0 && store.viewportHeight > 0,
                  () => photos.scrollToPosition(asked.at),
                ),
              );
            }
          },
        ),
      );
    } else {
      // The reaction only fires on a change, and coming back from the viewer is
      // not one: without this the grid's URL stays the bare path the way out
      // pointed at, and the reload it was all for lands at the top unfiltered.
      writeGridUrl(gridUrlState(store));
    }
    return () => disposers.forEach((dispose) => dispose());
  }, [store, photos]);

  // Count first: short-circuiting leaves a populated grid unsubscribed from
  // `loading`, which toggles for every block a scroll asks for.
  if (store.total === 0 && store.loading) return <Text variant="muted">{PhotoGridStrings.loadingPhotos()}</Text>;

  // A failed fetch also leaves nothing to show, and "Nothing here yet" would be a
  // lie about a library that is merely unreachable.
  if (store.isEmpty && store.error != null) {
    return (
      <EmptyState title={PhotoGridStrings.couldNotLoad()}>
        <Text as="p" variant="muted">
          {store.error}
        </Text>
      </EmptyState>
    );
  }

  if (store.isEmpty) {
    return (
      <EmptyState
        title={store.hasActiveFilters ? PhotoGridStrings.noPhotosMatchFilter() : PhotoGridStrings.nothingHereYet()}
      >
        <Text as="p" variant="muted">
          {store.hasActiveFilters ? PhotoGridStrings.tryADifferentFilter() : emptyHint}
        </Text>
      </EmptyState>
    );
  }

  return (
    <>
      <GridKeys scrollerId={SCROLLER_ID} />
      <GridScroller />
    </>
  );
});

// One scroll over the whole collection, holding only the tiles near the viewport
// (§18.3.2). Everything it renders from - the column count, the row height, the
// span of indices on screen - is read off the store, which the handlers here are
// the only writers of.
//
// It deliberately does not read `store.rail.top`. That is written on every sampled
// frame, and the sections are placed in *content* pixels offset by the anchor,
// which moves only when the rail is recentred - so a scroll that stays within one
// row re-renders nothing at all, and the native scroll does the moving.
const GridScroller = observer(function GridScroller(): JSX.Element {
  const store = useListingStore();
  const marks = useMarksStore();
  const stacks = useStacksStore();
  const { photos } = usePresenters();
  const scroller = useRef<HTMLDivElement>(null);
  // What the scroller last told us it was at, so the writers below can tell a
  // position the store *learnt* from the element from one it wants the element to
  // move to.
  const sampled = useRef(0);

  useEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box != null) photos.setViewport(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [photos]);

  // The scroller follows `store.rail.top`. A reaction rather than an effect, so that
  // observing a value written on every sampled frame does not re-render the grid on
  // every sampled frame.
  //
  // Here as well as in the layout effect below because it lands in the same frame as
  // the anchor change it belongs with, which is what keeps a correction from being
  // visible as a jump. It cannot be the only one: it runs before React has committed
  // the rail's new height, so a position legal against the collection as it now is
  // can still be clamped by the element as it still is.
  useEffect(
    () =>
      reaction(
        () => store.rail.top,
        (railTop) => {
          const element = scroller.current;
          if (element == null || railTop === sampled.current) return;
          element.scrollTop = railTop;
          // What the element took, so the layout effect can tell a write that was
          // clamped - the case it exists for - from one that landed and has since
          // been scrolled past. Left stale, it wrote this position again on the
          // next commit and undid whatever movement had arrived in between.
          sampled.current = element.scrollTop;
        },
      ),
    [store],
  );

  // After every commit the element is as tall as the store says, so a position the
  // reaction could not reach is reachable now.
  //
  // Load-bearing twice over. A `scrollTop` write the browser clamps to where the
  // element already sits fires no scroll event, so without this nothing corrects the
  // store and the grid draws a screenful the scroller is not looking at until the
  // reader scrolls by hand. And it is the only thing that puts a freshly mounted
  // element where the store already is: a collection that empties and refills
  // without going through `resetRows` - an undone bin - mounts a scroller at zero
  // under a store forty thousand pixels down.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    // Past the rail's own reach as well as out of step with the element: a
    // collection that shrank under the reader leaves `railTop` describing a
    // position the rail no longer has, and nothing else clamps it the way
    // `anchorTop` clamps the anchor.
    const reach = Math.max(0, store.rail.length - store.viewportHeight);
    if (store.rail.top === sampled.current && store.rail.top <= reach) return;
    element.scrollTop = store.rail.top;
    sampled.current = element.scrollTop;
    // What the scroller would not take is not a position this collection has.
    if (element.scrollTop !== store.rail.top) photos.rail.setTop(element.scrollTop);
  });

  // Follow the keyboard cursor. Off the store's own geometry rather than the
  // focused tile, which may never have been mounted (`focusContentTop`).
  //
  // Re-run on everything that moves where the cursor is drawn, not just on the
  // cursor itself: a zoom, a mode change or a resize re-lays the whole grid out
  // around a cursor that stays where it is, and the cull went on acting on a tile
  // that had been left off screen.
  useEffect(() => {
    const target = marks.focusContentTop;
    if (target != null) photos.rail.scrollTo(target);
  }, [marks.focusIndex, store.columns, store.rowHeight, store.mode, marks, photos]);

  // The one layout read left in the grid's hot path, and nothing else can answer
  // it: no event carries the scroll position.
  //
  // Read in the handler rather than deferred to the next frame, and it is cheap
  // there because a scroll event is dispatched after the scroll has been committed
  // - nothing is invalidated, so this forces no layout. Deferring it left the store
  // up to a frame behind the element, and a correction landing in that window -
  // a band whose members arrive mid-fling - was measured from where the reader had
  // been rather than where they are, and threw them back by the difference.
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const top = e.currentTarget.scrollTop;
    sampled.current = top;
    photos.rail.setTop(top);
  };

  // Home and End have to be handled rather than left to the scroller: natively
  // they go to the ends of the *rail*, which is a hundred thousand pixels
  // somewhere in the middle of the collection, so End advanced the reader by a
  // rail's worth and stopped. Page Up/Down are relative and need nothing.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'Home' && e.key !== 'End') return;
    photos.rail.scrollToProgress(e.key === 'Home' ? 0 : 1);
    e.preventDefault();
  };

  const blocks: number[] = [];
  if (store.mode === 'masonry') for (let b = store.mountedBlocks.from; b < store.mountedBlocks.to; b++) blocks.push(b);

  return (
    // The scrollbar comes first in the DOM and is floated to the right edge from
    // there: after the scroller, a screen reader in browse mode would have to cross
    // every mounted tile to reach it, and `scrollbar` is in no quick-nav list.
    <div {...stylex.props(viewport.gallery)}>
      <GridScrollbar
        rail={store.rail}
        axis="y"
        total={store.total}
        controls={SCROLLER_ID}
        viewport={store.viewportHeight}
        wheelStep={store.rowHeight}
        onDragged={photos.rail.scrollToProgress}
        // Straight at the element, not through the store: the store is only as
        // fresh as the last scroll event, and a notch computed from behind rewinds
        // the reader by whatever the compositor has already moved. The scroll event
        // this provokes brings the store along.
        onWheeled={(deltaY) => scroller.current?.scrollBy({ top: deltaY })}
      />
      {/* Focusable and labelled because it is a scrollable region holding content
          no tab stop of its own would reach: without it Page Up/Down, Home and End
          have nothing to act on until a tile happens to be focused. */}
      <div
        // Room under the last row for the bar floating over it, which is drawn exactly when a
        // cull is going on and would otherwise sit on the bottom row's own verdict and stars.
        {...stylex.props(viewport.scroller, marks.hasSelection && viewport.barred, focusRing.ring)}
        id={SCROLLER_ID}
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="list"
        aria-label={PhotoGridStrings.gridLabel(store.total)}
      >
        {/* The rail and the window are scaffolding for the scroll, not structure:
            announced, they would sit between the list and its items. */}
        <div {...stylex.props(viewport.content, viewport.railHeight(store.rail.length))} role="presentation">
          {store.mode === 'masonry' ? (
            blocks.map((block) => (
              <MasonryBlock
                key={block}
                block={block}
                top={store.rail.positionOf(store.blockTops[block] ?? 0)}
                onMeasured={photos.measuredBlock}
                onPacked={photos.packedBlock}
              />
            ))
          ) : (
            // One element per section rather than one window over a contiguous
            // run: an open stack's band sits between rows of the collection, and a
            // band several rows tall has to be one bordered box rather than one
            // per row (§19.6).
            store.sections.map((section) =>
              section.kind === 'grid' ? (
                <div
                  key={section.key}
                  {...stylex.props(
                    sectionStyle(store.mode, store.columns),
                    cells.window,
                    cells.down(store.rail.positionOf(section.top)),
                    cells.rows(store.rowHeight - GRID_GAP),
                  )}
                  role="presentation"
                >
                  {tilesFor(store, marks, stacks, section.from, section.to, store.mode)}
                </div>
              ) : (
                <BandTiles
                  key={section.key}
                  expansion={section}
                  top={section.top}
                  fused={store.fusedStacks.has(section.stackId)}
                />
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
});
