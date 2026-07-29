import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import { captureDateTime, localDateTime } from '../../api/dates';
import { renditionUrl, type PhotoSummary } from '../../api/client';
import { usePhotosStore, usePresenters } from '../../app/stores_context';
import { Text } from '../../ui/ui';
import { BLOCK, GRID_GAP } from './grid_layout';
import { renditionVersion, type PhotosStore } from './photos_store';

function filename(filePath: string, id: string): string {
  return filePath.split('/').pop() ?? id.slice(0, 8);
}

// Rating and verdict are set straight from the tile: a cull is mostly these two
// decisions, and making them cost a round trip through the detail view is what
// turns a ten-minute pass into an hour.
const Rating = observer(function Rating({ photo }: { photo: PhotoSummary }): JSX.Element {
  const { photos } = usePresenters();
  return (
    <span className="rating" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= photo.rating ? 'on' : undefined}
          aria-label={`Set rating to ${n}`}
          aria-pressed={n <= photo.rating}
          onClick={(e) => {
            e.stopPropagation();
            // Clicking the star a photo already sits on clears the rating, so one
            // control both sets and unsets without a separate "no rating" target.
            void photos.setRating(photo.id, n === photo.rating ? 0 : n);
          }}
        />
      ))}
    </span>
  );
});

const TriageButtons = observer(function TriageButtons({ photo }: { photo: PhotoSummary }): JSX.Element {
  const { photos } = usePresenters();
  return (
    <span className="verdict">
      <button
        type="button"
        className={`verdict__btn${photo.triage === 'rejected' ? ' is-on verdict__btn--reject' : ''}`}
        aria-label={photo.triage === 'rejected' ? 'Clear reject' : 'Reject'}
        aria-pressed={photo.triage === 'rejected'}
        onClick={(e) => {
          e.stopPropagation();
          void photos.toggleTriage(photo.id, 'rejected');
        }}
      >
        <ThumbsDown size={12} />
      </button>
      <button
        type="button"
        className={`verdict__btn${photo.triage === 'picked' ? ' is-on verdict__btn--pick' : ''}`}
        aria-label={photo.triage === 'picked' ? 'Clear pick' : 'Pick'}
        aria-pressed={photo.triage === 'picked'}
        onClick={(e) => {
          e.stopPropagation();
          void photos.toggleTriage(photo.id, 'picked');
        }}
      >
        <ThumbsUp size={12} />
      </button>
    </span>
  );
});

// isFocused arrives as a prop rather than being read from the store here. Every
// tile reading store.focusIndex meant one shared scalar changing re-rendered the
// whole grid on every arrow key; as a prop, observer's memo lets through only the
// two tiles whose value actually changed.
const Tile = observer(function Tile({
  photo,
  index,
  isFocused,
}: {
  photo: PhotoSummary;
  index: number;
  isFocused: boolean;
}): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  // A rendition 404s while processing is still writing it, and the announcement
  // is what brings it back: the version is this row's own `date_reprocessed`,
  // which the announcement for this photo writes into it, so a new URL is one
  // tile asking again for itself the moment there is something to fetch. No
  // other tile in the grid observes that field.
  //
  // Nothing polls behind that. A tile whose announcement never arrives stays
  // blank until the user rebuilds it or reloads, which is the cheap failure; a
  // backoff here meant a library whose tiles were all 404ing - one bad path, one
  // cleared data directory - re-requested every tile on screen forever.
  const version = renditionVersion(photo, 'grid');
  const src = renditionUrl(photo.id, 'grid', version);
  const [failed, setFailed] = useState(false);
  // A tile that failed and has since been told to try again is not failed any
  // more; without this the placeholder outlives the rendition arriving.
  useEffect(() => setFailed(false), [src]);
  const selected = store.selection.has(index);
  const list = store.mode === 'list';
  // ordering_date is date_taken under a taken_* ordering and date_added otherwise,
  // and those are not the same kind of timestamp (§11.1).
  // A tile only exists once a page has landed, so the ordering is known by now;
  // reading it as a capture date is the right guess for the one that never is.
  const orderingDate = store.ordering?.startsWith('added_')
    ? localDateTime(photo.ordering_date)
    : captureDateTime(photo.ordering_date);

  return (
    // The set size and position are stated because only a few dozen tiles are in
    // the DOM at once: without them a reader is told it is on "photo 4 of 30"
    // somewhere in a hundred thousand (§18.3.2).
    <div
      className={`tile${selected ? ' tile--selected' : ''}${isFocused ? ' tile--focused' : ''}`}
      role="listitem"
      aria-setsize={store.total}
      aria-posinset={index + 1}
      data-triage={photo.triage}
      // Masonry sizes a tile from the photo's own shape. Off the stored
      // dimensions, so no layout is ever read back to lay the rows out.
      style={{ '--ar': String(photo.width / photo.height) } as React.CSSProperties}
    >
      <button
        type="button"
        className="tile__hit"
        onClick={(e) => {
          // extendTo moves the cursor itself, so it is not preceded by focusAt.
          if (e.shiftKey) return photos.extendTo(index);
          photos.focusAt(index);
          // Once a selection exists the grid is in "choose things" mode, so a
          // plain click keeps building it instead of navigating away from it.
          if (e.metaKey || e.ctrlKey || store.hasSelection) photos.toggle(index);
          else navigate(`/photos/${photo.id}`);
        }}
        aria-label={`photo ${filename(photo.file_path, photo.id)}`}
      >
        {/* The image is always mounted and the placeholder sits behind it until
            something decodes. Swapping the two made each list refresh blink every
            un-rendered tile: the placeholder came down, the request 404'd
            again, and it went back up. */}
        <img
          src={src}
          alt=""
          loading="lazy"
          className={loaded ? 'is-loaded' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
        {!loaded && <span className="tile__pending">{failed ? 'no rendition yet' : null}</span>}
      </button>

      <div className="tile__badges">
        {photo.is_missing && <span className="badge badge--missing">missing</span>}
        {photo.is_deleted && <span className="badge badge--deleted">binned</span>}
      </div>

      <button
        type="button"
        className="tile__check"
        // Shift works on the box as well as on the frame: it is the visible
        // handle for selecting, so it is where a range gets built from.
        onClick={(e) => {
          if (e.shiftKey) return photos.extendTo(index);
          photos.focusAt(index);
          photos.toggle(index);
        }}
        aria-label={selected ? 'Deselect photo' : 'Select photo'}
        aria-pressed={selected}
      >
        <Check size={12} strokeWidth={3} />
      </button>

      <div className="tile__foot">
        <span className="tile__name" title={photo.file_path}>
          {filename(photo.file_path, photo.id)}
        </span>
        {list && <Text variant="mono">{orderingDate ?? 'no date'}</Text>}
        <span className="tile__marks">
          <TriageButtons photo={photo} />
          <Rating photo={photo} />
        </span>
      </div>
    </div>
  );
});

// The tiles for one span of the collection. A row the client is not holding -
// evicted behind the scroll, or still in flight - keeps its place as an empty
// cell rather than closing the gap, so nothing shifts under the reader when it
// lands.
function tilesFor(store: PhotosStore, from: number, to: number): JSX.Element[] {
  const tiles: JSX.Element[] = [];
  for (let index = from; index < to; index++) {
    const photo = store.rows.get(index);
    if (photo == null) {
      // Still carries the selection ring: the selection is positions, so it
      // covers rows this client has never held, and a blank cell reading as
      // unselected in the middle of "select all" would be a lie about what the
      // next action is going to touch.
      const selected = store.selection.has(index) ? ' tile--selected' : '';
      tiles.push(
        <div
          key={index}
          className={`tile tile--waiting${selected}`}
          role="listitem"
          aria-busy
          aria-setsize={store.total}
          aria-posinset={index + 1}
          style={{ '--ar': '1.5' } as React.CSSProperties}
        />,
      );
      continue;
    }
    // The keyboard cursor is meaningless once a selection is being assembled by
    // mouse: two rings on the same tile only raises "why is this one different".
    tiles.push(
      <Tile key={photo.id} photo={photo} index={index} isFocused={store.focusIndex === index && !store.hasSelection} />,
    );
  }
  return tiles;
}

// Masonry packs its lines from each photo's own shape, so a block's height is
// not arithmetic the way a uniform row's is - it has to be laid out to be known.
// One block is one flex container, exactly as the whole grid used to be, and it
// reports the height it settled at so the scroll above and below it is built
// from a measurement rather than a guess (§18.3.2).
const MasonryBlock = observer(function MasonryBlock({
  block,
  top,
  onMeasured,
}: {
  block: number;
  top: number;
  onMeasured: (block: number, height: number) => void;
}): JSX.Element {
  const store = usePhotosStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element == null) return;
    // An observer rather than a read after paint: the height arrives in the
    // entry, so learning what masonry packed never forces a layout.
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height;
      if (height != null && height > 0) onMeasured(block, height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [block, onMeasured]);

  return (
    <div ref={ref} className="grid grid--masonry grid__block" role="presentation" style={{ top }}>
      {tilesFor(store, block * BLOCK, Math.min(store.total, (block + 1) * BLOCK))}
    </div>
  );
});

// The grid's keyboard layer. Separate component so a keystroke that only moves
// the cursor re-renders the two affected tiles, not the page.
const GridKeys = observer(function GridKeys(): null {
  const store = usePhotosStore();
  const { photos } = usePresenters();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // The real count, which the grid is laid out from rather than guessed at:
      // a fixed six sent the cursor to the wrong row at every other zoom.
      const columns = store.columns;
      switch (e.key) {
        case 'ArrowRight':
          photos.moveFocus(1);
          break;
        case 'ArrowLeft':
          photos.moveFocus(-1);
          break;
        case 'ArrowDown':
          photos.moveFocus(columns);
          break;
        case 'ArrowUp':
          photos.moveFocus(-columns);
          break;
        case 'z':
          void photos.setFocusedTriage('untriaged');
          break;
        case 'c':
          void photos.togglePickFocused();
          break;
        case 'x':
          void photos.toggleRejectFocused();
          break;
        case 'Delete':
        case 'Backspace':
          void photos.binFocused();
          break;
        case ' ':
          photos.toggle(store.focusIndex);
          break;
        case 'Escape':
          photos.clearSelection();
          break;
        default:
          if (/^[0-5]$/.test(e.key)) void photos.rateFocused(Number(e.key));
          else return;
      }
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos, store]);

  return null;
});

export const PhotoGrid = observer(function PhotoGrid({ emptyHint }: { emptyHint: string }): JSX.Element {
  const store = usePhotosStore();

  // Count first: short-circuiting leaves a populated grid unsubscribed from
  // `loading`, which toggles for every block a scroll asks for.
  if (store.total === 0 && store.loading) return <Text variant="muted">Loading photos…</Text>;

  // A failed fetch also leaves nothing to show, and "Nothing here yet" would be a
  // lie about a library that is merely unreachable.
  if (store.isEmpty && store.error != null) {
    return (
      <div className="empty">
        <div className="empty__title">Could not load these photos</div>
        <Text as="p" variant="muted">
          {store.error}
        </Text>
      </div>
    );
  }

  if (store.isEmpty) {
    return (
      <div className="empty">
        <div className="empty__title">{store.hasActiveFilters ? 'No photos match this filter' : 'Nothing here yet'}</div>
        <Text as="p" variant="muted">
          {store.hasActiveFilters ? 'Try a different filter, or pick All to see everything.' : emptyHint}
        </Text>
      </div>
    );
  }

  return (
    <>
      <GridKeys />
      <GridScroller />
    </>
  );
});

// One scroll over the whole collection, holding only the tiles near the viewport
// (§18.3.2). Everything it renders from - the column count, the row height, the
// span of indices on screen - is read off the store, which the two handlers here
// are the only writers of.
const GridScroller = observer(function GridScroller(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const scroller = useRef<HTMLDivElement>(null);
  const sampling = useRef(false);

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

  // Back to the top when the collection changes under the scroll: position four
  // thousand of a library says nothing about position four thousand of a filter.
  useEffect(() => {
    if (scroller.current != null) scroller.current.scrollTop = 0;
  }, [store.source, store.filters]);

  // Follow the keyboard cursor. Off the store's own geometry rather than the
  // focused tile, which may never have been mounted (`focusScrollTop`).
  useEffect(() => {
    const target = store.focusScrollTop;
    if (scroller.current != null && target != null) scroller.current.scrollTop = target;
  }, [store.focusIndex, store]);

  const onScroll = (): void => {
    if (sampling.current) return;
    sampling.current = true;
    // The one layout read left in the app, and nothing else can answer it: no
    // event carries the scroll position. Sampled once per frame, from inside the
    // frame, where the layout has already settled - and written straight into
    // the store, which is where every consumer reads it from.
    requestAnimationFrame(() => {
      sampling.current = false;
      if (scroller.current != null) photos.setScrollTop(scroller.current.scrollTop);
    });
  };

  const onMeasured = useCallback(
    (block: number, height: number): void => {
      if (Math.abs((store.blockHeights.get(block) ?? store.estimatedBlockHeight) - height) < 0.5) return;
      // Anchored on the first block on screen rather than on the block that
      // measured. One measurement moves the average, and the average is what
      // every *unmeasured* block's height is - so a block reporting 600 where
      // 200 was assumed lifts every unmeasured block above the reader too, which
      // is a far larger push than its own difference. The anchor's top before
      // and after already accounts for all of it.
      const anchor = store.visibleBlocks.from;
      const before = store.blockTops[anchor] ?? 0;
      photos.measuredBlock(block, height);
      const shifted = ((store.blockTops[anchor] ?? 0) - before) * store.scrollScale;
      const element = scroller.current;
      if (element != null && shifted !== 0) element.scrollTop = Math.max(0, store.scrollTop + shifted);
    },
    [store, photos],
  );

  const blocks: number[] = [];
  if (store.mode === 'masonry') for (let b = store.visibleBlocks.from; b < store.visibleBlocks.to; b++) blocks.push(b);

  return (
    // Focusable and labelled because it is a scrollable region holding content
    // no tab stop of its own would reach: without it Page Up/Down, Home and End
    // have nothing to act on until a tile happens to be focused.
    <div
      className="grid__scroller"
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="list"
      aria-label={`${store.total} photos`}
      style={{ '--tile': `${store.tileSize}px` } as React.CSSProperties}
    >
      {/* The spacer and the window are scaffolding for the scroll, not structure:
          announced, they would sit between the list and its items. */}
      <div className="grid__content" role="presentation" style={{ height: store.scrollHeight }}>
        {store.mode === 'masonry' ? (
          blocks.map((block) => (
            <MasonryBlock key={block} block={block} top={store.domTop(store.blockTops[block] ?? 0)} onMeasured={onMeasured} />
          ))
        ) : (
          <div
            className={`grid grid--${store.mode} grid__window`}
            role="presentation"
            style={
              {
                transform: `translateY(${store.visibleTop}px)`,
                '--cols': store.columns,
                '--row-h': `${store.rowHeight - GRID_GAP}px`,
              } as React.CSSProperties
            }
          >
            {tilesFor(store, store.visible.from, store.visible.to)}
          </div>
        )}
      </div>
    </div>
  );
});
