import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, ThumbsDown, ThumbsUp } from 'lucide-react';
import { thumbnailUrl, type PhotoSummary } from '../../api/client';
import { usePhotosStore, usePresenters } from '../../app/stores_context';
import { Button, ICON, Text } from '../../ui/ui';

function filename(filePath: string, id: string): string {
  return filePath.split('/').pop() ?? id.slice(0, 8);
}

// Split out so a rating change repaints five dots, not the whole tile.
const Rating = observer(function Rating({ value }: { value: number }): JSX.Element {
  return (
    <span className="rating" aria-label={`rating ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} className={n <= value ? 'on' : undefined} />
      ))}
    </span>
  );
});

const Tile = observer(function Tile({ photo, index }: { photo: PhotoSummary; index: number }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  // Which list generation this tile's thumbnail request failed on. A thumbnail
  // 404s while processing is still writing it, so a failure is only believed
  // until the next refresh; after that the tile asks again with a fresh URL
  // (the query param defeats the browser's cache of the 404).
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const token = store.reloadToken;
  const failed = failedAt === token;
  // A failed request retries against the current list generation; a rebuild
  // changes the file behind the same URL and needs its own version.
  const src = failedAt == null ? thumbnailUrl(photo.id, 'small', store.rebuiltAt) : `${thumbnailUrl(photo.id, 'small')}?r=${token}`;
  const selected = store.selected.has(photo.id);
  // The keyboard cursor is meaningless once a selection is being assembled by
  // mouse: two rings on the same tile only raises "why is this one different".
  const focused = store.focusIndex === index && !store.hasSelection;
  const ref = useRef<HTMLDivElement>(null);

  // Keep the keyboard cursor on screen when it walks off the visible rows.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  return (
    <div
      ref={ref}
      className={`tile${selected ? ' tile--selected' : ''}${focused ? ' tile--focused' : ''}`}
      data-triage={photo.triage}
    >
      <button
        type="button"
        className="tile__hit"
        onClick={(e) => {
          photos.focusAt(index);
          if (e.shiftKey) photos.extendTo(photo.id);
          // Once a selection exists the grid is in "choose things" mode, so a
          // plain click keeps building it instead of navigating away from it.
          else if (e.metaKey || e.ctrlKey || store.hasSelection) photos.toggle(photo.id);
          else navigate(`/photos/${photo.id}`);
        }}
        aria-label={`photo ${filename(photo.file_path, photo.id)}`}
      >
        {failed ? (
          <span className="tile__pending">no thumbnail yet</span>
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            className={loaded ? 'is-loaded' : undefined}
            onLoad={() => setLoaded(true)}
            onError={() => setFailedAt(token)}
          />
        )}
      </button>

      <div className="tile__badges">
        {photo.triage === 'picked' && (
          <span className="badge badge--pick">
            <ThumbsUp size={9} /> pick
          </span>
        )}
        {photo.triage === 'rejected' && (
          <span className="badge badge--reject">
            <ThumbsDown size={9} /> rej
          </span>
        )}
        {photo.is_missing && <span className="badge badge--missing">missing</span>}
        {photo.is_deleted && <span className="badge badge--deleted">binned</span>}
      </div>

      <button
        type="button"
        className="tile__check"
        onClick={() => photos.toggle(photo.id)}
        aria-label={selected ? 'Deselect photo' : 'Select photo'}
        aria-pressed={selected}
      >
        <Check size={12} strokeWidth={3} />
      </button>

      <div className="tile__foot">
        <span className="tile__name" title={photo.file_path}>
          {filename(photo.file_path, photo.id)}
        </span>
        <Rating value={photo.rating} />
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

  if (store.loading && store.photos.length === 0) return <Text variant="muted">Loading photos…</Text>;

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
      <div className="grid" style={{ '--tile': `${store.thumbSize}px` } as React.CSSProperties}>
        {store.photos.map((p, i) => (
          <Tile key={p.id} photo={p} index={i} />
        ))}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <Text variant="mono">
          {store.pageStart}–{store.pageEnd} of {store.total}
        </Text>
        <div className="spacer" />
        <Pager />
      </div>
    </>
  );
});
