import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, ThumbsDown, ThumbsUp } from 'lucide-react';
import { captureDateTime, localDateTime } from '../../api/dates';
import { renditionUrl, type PhotoSummary } from '../../api/client';
import { useEventsStore, usePhotosStore, usePresenters } from '../../app/stores_context';
import { Button, ICON, Text } from '../../ui/ui';
import { RETRY_DELAYS_MS } from './retry_delays';

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
  const events = useEventsStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  // A thumbnail 404s while processing is still writing it. The version comes off
  // the server's own "this photo was built" announcement, keyed by photo, so the
  // retry is this tile asking again for itself the moment there is something to
  // fetch - and nothing else in the grid hears about it.
  //
  // Backed by a retry on a backoff, because being told is not guaranteed: the
  // stream can be down, or connect a moment after this tile asked, or the client
  // can be asleep past the replay buffer. Without a floor under it a single
  // missed announcement leaves a tile blank for the life of the page.
  const [attempt, setAttempt] = useState(0);
  const src = renditionUrl(photo.id, 'grid', events.version(photo.id) + attempt);
  const [failed, setFailed] = useState(false);
  // A tile that failed and has since been told to try again is not failed any
  // more; without this the placeholder outlives the thumbnail arriving.
  useEffect(() => setFailed(false), [src]);
  useEffect(() => {
    if (!failed) return;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay == null) return;
    const timer = setTimeout(() => setAttempt((a) => a + 1), delay);
    return () => clearTimeout(timer);
  }, [failed, attempt]);
  const selected = store.selected.has(photo.id);
  const ref = useRef<HTMLDivElement>(null);
  const list = store.mode === 'list';
  // ordering_date is date_taken under a taken_* ordering and date_added otherwise,
  // and those are not the same kind of timestamp (§11.1).
  const orderingDate = store.ordering.startsWith('taken_') ? captureDateTime(photo.ordering_date) : localDateTime(photo.ordering_date);

  // Keep the keyboard cursor on screen when it walks off the visible rows.
  useEffect(() => {
    if (isFocused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isFocused]);

  return (
    <div
      ref={ref}
      className={`tile${selected ? ' tile--selected' : ''}${isFocused ? ' tile--focused' : ''}`}
      data-triage={photo.triage}
    >
      <button
        type="button"
        className="tile__hit"
        onClick={(e) => {
          // extendTo moves the cursor itself, so it is not preceded by focusAt.
          if (e.shiftKey) return photos.extendTo(photo.id);
          photos.focusAt(index);
          // Once a selection exists the grid is in "choose things" mode, so a
          // plain click keeps building it instead of navigating away from it.
          if (e.metaKey || e.ctrlKey || store.hasSelection) photos.toggle(photo.id);
          else navigate(`/photos/${photo.id}`);
        }}
        aria-label={`photo ${filename(photo.file_path, photo.id)}`}
      >
        {/* The image is always mounted and the placeholder sits behind it until
            something decodes. Swapping the two on every retry made each list
            refresh blink every un-thumbnailed tile: the placeholder came down,
            the request 404'd again, and it went back up. */}
        <img
          src={src}
          alt=""
          loading="lazy"
          className={loaded ? 'is-loaded' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
        {!loaded && <span className="tile__pending">{failed ? 'no thumbnail yet' : null}</span>}
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
          if (e.shiftKey) return photos.extendTo(photo.id);
          photos.focusAt(index);
          photos.toggle(photo.id);
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

const Pager = observer(function Pager(): JSX.Element | null {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  if (store.pageCount <= 1) return null;

  // A window around the current page, so 400 pages don't render 400 buttons.
  const current = store.pageIndex;
  const from = Math.max(0, Math.min(current - 2, store.pageCount - 5));
  const pages = Array.from({ length: Math.min(5, store.pageCount) }, (_, i) => from + i);

  return (
    <div className="pager">
      <Button iconOnly aria-label="Previous page" disabled={!store.hasPrevPage} onClick={() => void photos.prevPage()}>
        <ChevronLeft size={ICON} />
      </Button>
      {from > 0 && <Text variant="muted">…</Text>}
      {pages.map((p) => (
        <Button
          key={p}
          variant={p === current ? 'primary' : 'default'}
          aria-current={p === current ? 'page' : undefined}
          onClick={() => void photos.goToPage(p)}
        >
          {p + 1}
        </Button>
      ))}
      {from + pages.length < store.pageCount && <Text variant="muted">…</Text>}
      <Button iconOnly aria-label="Next page" disabled={!store.hasNextPage} onClick={() => void photos.nextPage()}>
        <ChevronRight size={ICON} />
      </Button>
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

      const columns = 6; // matches the grid's auto-fill minimum at the common width
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
          if (store.focusedPhoto != null) photos.toggle(store.focusedPhoto.id);
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

  // Length first: short-circuiting leaves a populated grid unsubscribed from
  // `loading`, which toggles twice on every refetch.
  if (store.photos.length === 0 && store.loading) return <Text variant="muted">Loading photos…</Text>;

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
      <div className={`grid grid--${store.mode}`} style={{ '--tile': `${store.thumbSize}px` } as React.CSSProperties}>
        {store.photos.map((p, i) => (
          // The keyboard cursor is meaningless once a selection is being assembled
          // by mouse: two rings on the same tile only raises "why is this one
          // different".
          <Tile key={p.id} photo={p} index={i} isFocused={store.focusIndex === i && !store.hasSelection} />
        ))}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div className="spacer" />
        <Pager />
      </div>
    </>
  );
});
