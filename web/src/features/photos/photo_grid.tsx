import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronUp, EyeOff, Layers, ThumbsDown, ThumbsUp } from 'lucide-react';
import { captureDateTime, localDateTime } from '../../api/dates';
import { renditionUrl, type PhotoSummary } from '../../api/client';
import { usePhotosStore, usePresenters } from '../../app/stores_context';
import { Text } from '../../ui/ui';
import { BLOCK, GRID_GAP, TILE_ASPECT, bandRowHeight, masonryLineStarts } from './grid_layout';
import { bandRows } from './bands';
import { renditionVersion, type Expansion, type PhotosStore } from './photos_store';
import type { Span } from '../../ui/virtual_rows';

function filename(filePath: string, id: string): string {
  return filePath.split('/').pop() ?? id.slice(0, 8);
}

// The scroller's id, so the grid's own scrollbar can name what it controls.
const SCROLLER_ID = 'grid-scroller';

// Shortest the thumb is drawn: a screenful of a hundred thousand photos is a
// thumb a fraction of a pixel tall. In pixels rather than a fraction of the
// track, because it is also the pointer target (WCAG 2.5.8) and a fraction that
// clears 24px on a tall window does not on a short one.
const THUMB_MIN_PX = 24;

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
  for (const cell of scroller.querySelectorAll<HTMLElement>('[data-position]')) {
    const rect = cell.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const index = Number(cell.dataset.position);
    from = Math.min(from, index);
    to = Math.max(to, index);
  }
  return from > to ? null : { from, to: to + 1 };
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
  const frame = useRef<HTMLDivElement>(null);
  // Masonry packs its lines from each photo's own shape, so the store can only
  // scroll the cursor's *block* into view (`focusContentTop`) - and a block is a
  // hundred photos, so the cursor spent most of a cull off screen with the
  // verdict keys still acting on it. The tile is the only thing that knows where
  // the packing put it.
  //
  // On the two inputs that packing is a function of as well as on the cursor: a
  // zoom or a resize moves the tile without moving the cursor, and the block it
  // is in stays visible, so nothing upstream reports anything to correct.
  useEffect(() => {
    if (!isFocused || store.mode !== 'masonry') return;
    frame.current?.scrollIntoView({ block: 'nearest' });
  }, [isFocused, store.mode, store.tileSize, store.viewportWidth]);
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
  // One ring for one idea: the selection. The cursor is kept inside it by every
  // gesture that moves either - an arrow key selects what it lands on, a click
  // focuses what it selected - so a second ring for the cursor only ever raised
  // "why is this one different". Off the selection alone rather than "or the
  // cursor", because cmd-clicking a selected photo moves the cursor onto the very
  // photo it deselects, and that left a ring on a photo nothing would act on.
  const selected = store.selection.has(index);
  const expanded = photo.stack_id != null && store.expansions.has(photo.stack_id);
  const stacked = photo.stack_id != null && photo.stack_size > 1;
  const fused = expanded && store.fusedStacks.has(photo.stack_id!);

  return (
    // The set size and position are stated because only a few dozen tiles are in
    // the DOM at once: without them a reader is told it is on "photo 4 of 30"
    // somewhere in a hundred thousand (§18.3.2).
    <div
      ref={frame}
      className={`tile${selected ? ' tile--selected' : ''}`}
      role="listitem"
      aria-setsize={store.total}
      aria-posinset={index + 1}
      // Which position this cell holds, for the one question no arithmetic can
      // answer: which photos are actually on screen (`onScreenSpan`).
      data-position={index}
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
          if (e.metaKey || e.ctrlKey) return photos.toggle(index);
          photos.selectOnly(index);
          // A stack's tile stands for the whole stack, so selecting it opens the
          // band of members below this row rather than the one photo it happens to
          // show; a member is reached from the band. On the first click, not the
          // second: the band is how you see what you have just selected.
          if (stacked) void photos.toggleBand(photo.stack_id!, index);
        }}
        // Opening a photo is the second click, so the first can select: choosing
        // photographs is what a grid is mostly for, and a tick box per tile to
        // spare the frame for navigation is a control on every tile paying for a
        // gesture used once per photo.
        onDoubleClick={(e) => {
          // A stack never opens a member's detail view, and its band is already
          // this gesture's business - the two clicks open it and close it again.
          if (stacked || e.shiftKey || e.metaKey || e.ctrlKey) return;
          navigate(`/photos/${photo.id}`);
        }}
        aria-expanded={stacked ? expanded : undefined}
        // The selected state rides on the name because there is no box carrying
        // it any more, and a listitem cannot take aria-selected.
        aria-label={`${selected ? 'selected, ' : ''}${stacked ? `stack of ${photo.stack_size}, ` : ''}photo ${filename(photo.file_path, photo.id)}`}
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

      {/* Marks the tile as a stack and says which way it is; the tile itself is
          the control. Not a target of its own: `pointer-events: none` hands the
          click to the frame underneath so both halves of the tile do the same
          thing (§19.6). */}
      {stacked && (
        <span
          // Fused: this tile's band is the one immediately below its row, so the
          // two share the edge between them and neither draws it (§19.6).
          className={`tile__stack${expanded ? ' tile__stack--open' : ''}${fused ? ' tile__stack--fused' : ''}`}
          // Open, the tile is ringed in the colour of the band it opened, which
          // is what pairs the two when several stacks on one row are open.
          data-band={expanded ? store.bandColours.get(photo.stack_id!) : undefined}
          aria-hidden="true"
        >
          {expanded ? <ChevronUp size={22} /> : <Layers size={12} />}
          {!expanded && <span className="tile__stack-count">{photo.stack_size}</span>}
        </span>
      )}

      <TileFoot photo={photo} />
    </div>
  );
});

// The row of names and marks under a tile. Shared so a band member in list mode
// says as much about itself as any other row does.
const TileFoot = observer(function TileFoot({ photo }: { photo: PhotoSummary }): JSX.Element {
  const store = usePhotosStore();
  // ordering_date is date_taken under a taken_* ordering and date_added otherwise,
  // and those are not the same kind of timestamp (§11.1).
  // A tile only exists once a page has landed, so the ordering is known by now;
  // reading it as a capture date is the right guess for the one that never is.
  const orderingDate = store.ordering?.startsWith('added_')
    ? localDateTime(photo.ordering_date)
    : captureDateTime(photo.ordering_date);

  return (
    <div className="tile__foot">
      <span className="tile__name" title={photo.file_path}>
        {filename(photo.file_path, photo.id)}
      </span>
      {store.mode === 'list' && <Text variant="mono">{orderingDate ?? 'no date'}</Text>}
      <span className="tile__marks">
        <TriageButtons photo={photo} />
        <Rating photo={photo} />
      </span>
    </div>
  );
});

// One member of an open stack.
//
// Selected by id rather than by position, because a collapsed listing numbers
// one row per stack and a member has no position at all. Legitimate because a
// band's members are loaded and on screen: what the virtual grid forbids is an
// id standing in for a row this client has never held (§19.6).
const BandMember = observer(function BandMember({ photo }: { photo: PhotoSummary }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  const selected = store.selectedMembers.has(photo.id);
  const src = renditionUrl(photo.id, 'grid', renditionVersion(photo, 'grid'));
  // A shoot shows the whole stack and dims the members that are not in it, which
  // is the one place a photo appears in a collection it does not belong to.
  const source = store.source;
  const outside = source?.kind === 'shoot' && photo.shoot_id !== source.shootId;

  return (
    <div
      className={`tile tile--member${selected ? ' tile--selected' : ''}${outside ? ' tile--outside' : ''}`}
      role="listitem"
      data-triage={photo.triage}
      style={{ '--ar': String(photo.width / photo.height) } as React.CSSProperties}
    >
      <button
        type="button"
        className="tile__hit"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) photos.toggleMember(photo.id);
          else photos.selectOnlyMember(photo.id);
        }}
        onDoubleClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          navigate(`/photos/${photo.id}`);
        }}
        aria-label={`${selected ? 'selected, ' : ''}photo ${filename(photo.file_path, photo.id)}`}
      >
        <img src={src} alt="" loading="lazy" className={loaded ? 'is-loaded' : undefined} onLoad={() => setLoaded(true)} />
      </button>

      {outside && (
        <div className="tile__outside" aria-hidden>
          <EyeOff size={14} />
          <span>not in this shoot</span>
        </div>
      )}

      <TileFoot photo={photo} />
    </div>
  );
});

// The tiles for one span of the collection. A row the client is not holding -
// evicted behind the scroll, or still in flight - keeps its place as an empty
// cell rather than closing the gap, so nothing shifts under the reader when it
// lands.
function tilesFor(store: PhotosStore, from: number, to: number): JSX.Element[] {
  const tiles: JSX.Element[] = [];
  // Masonry has no row model to hang a band off, so an open stack's members take
  // a full-width band on the block's own flex line. It waits for the end of the
  // line its tile sits on rather than following that tile straight away: a band
  // in the middle of a line cuts it short, and the tiles left on it take the
  // space the band walked off with (§19.6). Which tile ends a line is the one
  // thing the shapes decide rather than the row arithmetic, so it is replayed
  // from them - still no measurement.
  const masonry = store.mode === 'masonry';
  const lineStarts = masonry
    ? masonryLineStarts(ratiosFor(store, from, to), store.viewportWidth, store.tileSize)
    : new Set<number>();
  const pending: Expansion[] = [];
  const flush = (last: boolean): void => {
    if (pending.length === 0) return;
    // The block's own ::after is what leaves its last line at the size the photos
    // want rather than stretched across the width; a band after that line takes
    // the ::after off it, so the line is given one of its own.
    if (last) tiles.push(<span key="line-end" className="grid__line-end" aria-hidden="true" />);
    for (const open of pending.splice(0)) tiles.push(<BandTiles key={`band-${open.stackId}`} expansion={open} />);
  };

  for (let index = from; index < to; index++) {
    if (lineStarts.has(index - from)) flush(false);
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
          data-position={index}
          style={{ '--ar': '1.5' } as React.CSSProperties}
        />,
      );
      continue;
    }
    tiles.push(<Tile key={photo.id} photo={photo} index={index} isFocused={store.focusIndex === index} />);
    const open = masonry ? store.expansionAt(index) : null;
    if (open != null) pending.push(open);
  }
  // Whatever is still open on the block's last line, which has no line after it
  // to be flushed by.
  flush(true);
  return tiles;
}

// The shapes the wrap is replayed from. A row the client is not holding is the
// 3:2 its waiting cell is drawn at, so a page landing under the reader does not
// move a line break that was already decided.
function ratiosFor(store: PhotosStore, from: number, to: number): number[] {
  const ratios: number[] = [];
  for (let index = from; index < to; index++) {
    const photo = store.rows.get(index);
    ratios.push(photo == null ? TILE_ASPECT : photo.width / photo.height);
  }
  return ratios;
}

// The members of one open stack, as a band. Without a top it is masonry's: a
// full-width item inside the block's own flex line, rather than a section the
// row arithmetic placed at a height of its own.
const BandTiles = observer(function BandTiles({
  expansion,
  top,
}: {
  expansion: Expansion;
  top?: number;
}): JSX.Element {
  const store = usePhotosStore();
  const rows = bandRows(expansion.photos.length, store.columns);
  const placed = top != null;
  const fused = store.fusedStacks.has(expansion.stackId);

  return (
    <div
      className={`grid grid--${store.mode} grid__band${placed ? ' grid__window' : ' grid__band--inline'}${
        fused ? ' grid__band--fused' : ''
      }`}
      data-band={store.bandColours.get(expansion.stackId)}
      role="group"
      aria-label={`${expansion.photos.length} photos in this stack`}
      style={
        {
          ...(placed ? { transform: `translateY(${store.railPositionOf(top)}px)` } : {}),
          '--cols': store.columns,
          // Which column the stack's own tile sits in, so the joined edge leaves a
          // gap exactly that wide (§19.6). The width itself is arithmetic CSS can
          // do from the column count, so nothing here is measured.
          ...(fused ? { '--fuse-col': expansion.position % store.columns } : {}),
          // A band gets exactly the display rows the row arithmetic gave it, so
          // the padding inside its outline comes out of its own cells rather than
          // out of the collection below it.
          '--row-h': `${bandRowHeight(rows, store.rowHeight)}px`,
        } as React.CSSProperties
      }
    >
      {expansion.photos.map((photo) => (
        <BandMember key={photo.id} photo={photo} />
      ))}
    </div>
  );
});

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
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Arrowing the cursor is the reader taking the grid over, so the focus comes
      // with it: it is what makes Enter unambiguously the grid's rather than the
      // rail link they came in by, and it leaves the tab order where they are.
      // preventScroll because the scroller is the thing being focused, and letting
      // the browser bring it into view fights the rail (§18.3.2).
      if (e.key.startsWith('Arrow')) {
        const scroller = document.getElementById(SCROLLER_ID);
        if (scroller != null && !scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true });
      }

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
        // What double-click does, for the keyboard.
        case 'Enter': {
          // Only from the grid: every other button, menu item and dialog owns its
          // own Enter, and the preventDefault below - which is what stops a
          // focused tile's click firing behind this and cutting the selection
          // down to that one photo - would swallow the activation.
          const fromGrid = target == null || target === document.body || target.closest(`#${SCROLLER_ID}`) != null;
          if (!fromGrid || (target?.tagName === 'BUTTON' && !target.classList.contains('tile__hit'))) return;
          const focused = store.focusedPhoto;
          if (focused == null) return;
          if (focused.stack_id != null && focused.stack_size > 1) void photos.toggleBand(focused.stack_id, store.focusIndex);
          else navigate(`/photos/${focused.id}`);
          break;
        }
        case 'Escape':
          // With nothing selected there is nothing to clear, and Escape belongs to
          // whatever else is listening for it - a menu, a dialog.
          if (!store.hasSelection && store.selectedMembers.size === 0 && store.focusIndex < 0) return;
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
  }, [photos, store, navigate]);

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

// The scroll position, drawn, because the native scrollbar now describes the rail
// rather than the collection and is hidden (§18.3.2).
//
// Its own component because it is the one thing that does read the scroll position
// every sampled frame: kept inside GridScroller, the thumb moving would re-render
// every mounted tile with it.
const GridScrollbar = observer(function GridScrollbar({
  onDragged,
  onWheeled,
}: {
  /** Where in the collection the reader dragged to, as a fraction. */
  onDragged: (progress: number) => void;
  /** A wheel notch over the bar, in pixels. */
  onWheeled: (deltaY: number) => void;
}): JSX.Element | null {
  const store = usePhotosStore();
  // The grabbed point, as the progress the drag started from plus where in the
  // track the pointer was, so the thumb keeps hold of the point it was taken by
  // rather than snapping its middle to the pointer. A progress rather than an
  // offset within the thumb, because the thumb's own length changes mid-drag
  // whenever a masonry block measures.
  const grab = useRef({ at: 0, progress: 0, top: 0, height: 1 });

  // Nothing to scroll, so nothing to draw. Safe to unmount because the gutter it
  // floats in belongs to the scroller and stays there either way.
  if (store.viewportFraction >= 1) return null;

  // Never exactly 1: it is the divisor in `progressAt`, and a viewport shorter than
  // the thumb's own floor would otherwise put NaN into the scroll position.
  const length = Math.min(0.999, Math.max(THUMB_MIN_PX / Math.max(1, store.viewportHeight), store.viewportFraction));
  const offset = store.scrollProgress * (1 - length);

  // Off the track measured once at the press, not per move: a drag writes
  // `scrollTop` on every move, so reading the rect again each time would force a
  // layout per frame for the length of the drag (§18.2).
  const progressAt = (clientY: number): number => {
    const held = grab.current;
    return held.progress + ((clientY - held.top) / held.height - held.at) / (1 - length);
  };

  return (
    <div
      className="grid__bar"
      role="scrollbar"
      aria-orientation="vertical"
      aria-controls={SCROLLER_ID}
      aria-label="Scroll through the collection"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(store.scrollProgress * 100)}
      // Off the progress rather than off `visible.from`, which is the first
      // *mounted* index: that is two overscan rows early in the grid and up to a
      // whole block early in masonry, so it named a photo the reader is not at.
      aria-valuetext={`photo ${Math.round(store.scrollProgress * Math.max(0, store.total - 1)) + 1} of ${store.total}`}
    >
      <div
        className="grid__bar-thumb"
        style={{ top: `${offset * 100}%`, height: `${length * 100}%` }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          const box = e.currentTarget.parentElement?.getBoundingClientRect();
          const height = box != null && box.height > 0 ? box.height : 1;
          const top = box?.top ?? 0;
          grab.current = { at: (e.clientY - top) / height, progress: store.scrollProgress, top, height };
          // Keeps the focus on the scroller: without it the press moves focus to
          // the body, and Page Up/Down and Home/End have nothing to act on after.
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onDragged(progressAt(e.clientY));
        }}
        // The bar is a sibling of the scroller, so a wheel notch over it has
        // nothing scrollable to bubble to and the grid would simply not move.
        // `deltaMode` because Firefox reports a wheel mouse in lines, not pixels.
        onWheel={(e) => onWheeled(e.deltaY * (e.deltaMode === 1 ? store.rowHeight : e.deltaMode === 2 ? store.viewportHeight : 1))}
      />
    </div>
  );
});

// One scroll over the whole collection, holding only the tiles near the viewport
// (§18.3.2). Everything it renders from - the column count, the row height, the
// span of indices on screen - is read off the store, which the handlers here are
// the only writers of.
//
// It deliberately does not read `store.railTop`. That is written on every sampled
// frame, and the sections are placed in *content* pixels offset by the anchor,
// which moves only when the rail is recentred - so a scroll that stays within one
// row re-renders nothing at all, and the native scroll does the moving.
const GridScroller = observer(function GridScroller(): JSX.Element {
  const store = usePhotosStore();
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

  // The scroller follows `store.railTop`. A reaction rather than an effect, so that
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
        () => store.railTop,
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
    const reach = Math.max(0, store.railHeight - store.viewportHeight);
    if (store.railTop === sampled.current && store.railTop <= reach) return;
    element.scrollTop = store.railTop;
    sampled.current = element.scrollTop;
    // What the scroller would not take is not a position this collection has.
    if (element.scrollTop !== store.railTop) photos.setRailTop(element.scrollTop);
  });

  // Follow the keyboard cursor. Off the store's own geometry rather than the
  // focused tile, which may never have been mounted (`focusContentTop`).
  //
  // Re-run on everything that moves where the cursor is drawn, not just on the
  // cursor itself: a zoom, a mode change or a resize re-lays the whole grid out
  // around a cursor that stays where it is, and the cull went on acting on a tile
  // that had been left off screen.
  useEffect(() => {
    const target = store.focusContentTop;
    if (target != null) photos.scrollTo(target);
  }, [store.focusIndex, store.columns, store.rowHeight, store.mode, store, photos]);

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
    photos.setRailTop(top);
  };

  const onMeasured = useCallback(
    (block: number, height: number): void => {
      // Against the height already recorded for this block, never against the
      // estimate: a block that lays out at exactly what was guessed for it is a
      // real measurement, and skipping it left the guess in place to be replaced
      // by the next one.
      const known = store.blockHeights.get(block);
      if (known != null && Math.abs(known - height) < 0.5) return;
      photos.measuredBlock(block, height);
    },
    [store, photos],
  );

  // Home and End have to be handled rather than left to the scroller: natively
  // they go to the ends of the *rail*, which is a hundred thousand pixels
  // somewhere in the middle of the collection, so End advanced the reader by a
  // rail's worth and stopped. Page Up/Down are relative and need nothing.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'Home' && e.key !== 'End') return;
    photos.scrollToProgress(e.key === 'Home' ? 0 : 1);
    e.preventDefault();
  };

  const blocks: number[] = [];
  if (store.mode === 'masonry') for (let b = store.visibleBlocks.from; b < store.visibleBlocks.to; b++) blocks.push(b);

  return (
    // The scrollbar comes first in the DOM and is floated to the right edge from
    // there: after the scroller, a screen reader in browse mode would have to cross
    // every mounted tile to reach it, and `scrollbar` is in no quick-nav list.
    <div className="grid__viewport">
      <GridScrollbar
        onDragged={photos.scrollToProgress}
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
        className="grid__scroller"
        id={SCROLLER_ID}
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="list"
        aria-label={`${store.total} photos`}
        style={{ '--tile': `${store.tileSize}px` } as React.CSSProperties}
      >
        {/* The rail and the window are scaffolding for the scroll, not structure:
            announced, they would sit between the list and its items. */}
        <div className="grid__content" role="presentation" style={{ height: store.railHeight }}>
          {store.mode === 'masonry' ? (
            blocks.map((block) => (
              <MasonryBlock
                key={block}
                block={block}
                top={store.railPositionOf(store.blockTops[block] ?? 0)}
                onMeasured={onMeasured}
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
                  className={`grid grid--${store.mode} grid__window`}
                  role="presentation"
                  style={
                    {
                      transform: `translateY(${store.railPositionOf(section.top)}px)`,
                      '--cols': store.columns,
                      '--row-h': `${store.rowHeight - GRID_GAP}px`,
                    } as React.CSSProperties
                  }
                >
                  {tilesFor(store, section.from, section.to)}
                </div>
              ) : (
                <BandTiles key={section.key} expansion={section} top={section.top} />
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
});
