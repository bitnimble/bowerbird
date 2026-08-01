import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderPlus, Images, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { renditionUrl } from '../../api/client';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ActionMenu } from '../../ui/action_menu';
import { Button } from '../../ui/button';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { libraryLabel } from '../libraries/library_label';
import { AddShootDialog } from './add_shoot_dialog';
import { DeleteShootDialog } from './delete_shoot_dialog';
import { SHOOT_ROW_H, type FolderRow, type ShootView } from './shoots_store';

const VIEWS: Option<ShootView>[] = [
  { value: 'flat', label: 'Flat' },
  { value: 'tree', label: 'Tree' },
  { value: 'tree_full', label: 'All folders' },
];

type RowAction = 'adopt' | 'subfolder';

// The library's folders, with the shoots among them, rather than the shoots
// alone (§18.3.2). An empty list beside a library full of subfolders was the
// catalogue lying by omission: the photographs had imported, the folders were
// right there on disk, and nothing on screen said so.
export const ShootsPage = observer(function ShootsPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const store = useShootsStore();
  const libraries = useLibrariesStore();
  const { shoots, libraries: librariesPresenter } = usePresenters();
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The one height everything else is arithmetic over. Taken from the observer's
  // own entry rather than by reading the element back, which would be a layout
  // read in a resize handler.
  useEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) shoots.setViewport(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shoots]);

  // Sampled once per frame rather than per event: the scroll position is the one
  // number here read back off the DOM, and a wheel spin fires far more events
  // than there are frames to render them in.
  const pending = useRef(false);
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const element = e.currentTarget;
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      shoots.setScrollTop(element.scrollTop);
    });
  };

  // The element keeps its own scroll position across a re-render, and row four
  // thousand of one reading says nothing about row four thousand of another, so
  // both readings start from the top. Written to the store as well as to the
  // element: assigning 0 to something already at 0 fires no scroll event, so the
  // store would keep the old offset and translate the window somewhere the
  // scrollbar is not.
  useEffect(() => {
    if (scroller.current != null) scroller.current.scrollTop = 0;
    shoots.setScrollTop(0);
  }, [libraryId, store.view, shoots]);

  // Follow the cursor, on every command rather than on the index changing: Flat
  // and Tree list the same shoots in the same order, so switching between them
  // leaves the index alone, and scrolling away from the cursor changes nothing at
  // all - yet both want the list brought back. Declared after the reset above so
  // a view change with a cursor set lands on the folder rather than at the top.
  useEffect(() => {
    const target = store.cursorScrollTop;
    if (scroller.current != null && target != null) scroller.current.scrollTop = target;
  }, [store.cursorSeq, store.view, store]);

  useEffect(() => {
    shoots.restoreView();
    void shoots.load(libraryId);
    // The root row names the library, which the rail has usually loaded already
    // but a deep link has not.
    void librariesPresenter.load();
  }, [libraryId, shoots, librariesPresenter]);

  const library = libraries.byId.get(libraryId);

  return (
    <div className="pad pad--fill">
      <ShootKeys />
      <div className="row page__head">
        <Heading>Shoots</Heading>
        <span className="spacer" />
        <SegmentedControl label="How to show the folders" options={VIEWS} value={store.view} onChange={shoots.setView} />
      </div>
      <Text variant="mono" as="p">
        A shoot is a real folder on disk. Adding photos to one moves the files into it.
      </Text>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={shoots.clearError}>Dismiss</Button>
        </div>
      )}

      <AddShootDialog
        libraryId={libraryId}
        parentPath={creatingIn ?? ''}
        open={creatingIn != null}
        onOpenChange={(open) => !open && setCreatingIn(null)}
      />
      <DeleteShootDialog
        shoot={deleting?.shoot ?? null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={(photos) => {
          const shoot = deleting?.shoot;
          setDeleting(null);
          if (shoot != null) void shoots.remove(shoot.id, photos);
        }}
      />

      <div className="list list--fill">
        {/* Permanent, undeletable, and the answer to "one photo at the root and
            one in a subfolder" reading as an empty page. */}
        <div className="list__row list__row--root">
          <span className="list__body">
            <span className="list__name">{library == null ? 'Library root' : libraryLabel(library)}</span>
            <Text variant="mono" as="div">
              {store.rootPhotoCount} {store.rootPhotoCount === 1 ? 'photo' : 'photos'} in no shoot
            </Text>
          </span>
          <ActionMenu
            trigger={<Plus size={ICON} />}
            label="Add to the library root"
            options={[{ value: 'subfolder', label: 'Create shoot in subfolder', icon: <FolderPlus size={ICON} /> }]}
            onSelect={() => setCreatingIn('')}
          />
        </div>

        {/* Mirroring makes this list as long as the folder tree, so only the rows
            near the viewport are mounted (§18.3.4). The spacer carries the full
            height and the window is translated into place; both are scaffolding
            for the scroll rather than structure, so neither is announced. */}
        <div
          className="list__scroller"
          ref={scroller}
          onScroll={onScroll}
          tabIndex={0}
          role="list"
          aria-label={`${store.rows.length} folders`}
          style={{ '--row-h': `${SHOOT_ROW_H}px` } as React.CSSProperties}
        >
          <div className="list__content" role="presentation" style={{ height: store.scrollHeight }}>
            <div className="list__window" role="presentation" style={{ transform: `translateY(${store.visibleTop}px)` }}>
              {/* Only stable props: a fresh arrow per row per render would defeat
                  observer's memo and rebuild every mounted row on every scroll
                  frame, so the row reaches for the presenter itself. */}
              {store.visibleRowsSlice.map((row, i) => (
                <ShootRow
                  key={row.folderPath}
                  row={row}
                  // Against the whole tree rather than the few rows mounted, so a
                  // reader is told "folder 4,051 of 20,000".
                  position={store.visible.from + i + 1}
                  total={store.rows.length}
                  onCreateIn={setCreatingIn}
                  onDelete={setDeleting}
                  scroller={scroller}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {store.loading && store.rows.length === 0 && (
        <div className="empty">
          <div className="empty__title">Reading the library&apos;s folders…</div>
        </div>
      )}

      {store.isEmpty && (
        <div className="empty">
          <div className="empty__title">Nothing here yet</div>
          <Text as="p" variant="muted">
            This library has no folders holding photographs. Sync it from Settings, or make a shoot with the + above.
          </Text>
        </div>
      )}
    </div>
  );
});

// Bound to the window rather than to a row, which is the point: the cursor is a
// value in the store, so it survives the row it names being unmounted by a
// scroll. Its own component so a keystroke re-renders nothing but the two rows
// whose ring moved.
const ShootKeys = observer(function ShootKeys(): null {
  const store = useShootsStore();
  const { shoots } = usePresenters();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      // A rename in progress owns the arrows, and a browser shortcut owns them
      // whatever is on screen.
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowDown':
          shoots.moveCursor(1);
          break;
        case 'ArrowUp':
          shoots.moveCursor(-1);
          break;
        case 'ArrowRight':
          void shoots.openCursor();
          break;
        case 'ArrowLeft':
          void shoots.closeCursor();
          break;
        case 'Home':
          shoots.moveCursor(-store.rows.length);
          break;
        case 'End':
          shoots.moveCursor(store.rows.length);
          break;
        default:
          return;
      }
      // Only once a key was one of ours: the arrows still scroll the page when
      // the cursor is not what the reader is driving.
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shoots, store]);

  return null;
});

const ShootRow = observer(function ShootRow({
  row,
  position,
  total,
  onCreateIn,
  onDelete,
  scroller,
}: {
  row: FolderRow;
  position: number;
  total: number;
  onCreateIn: (folderPath: string) => void;
  onDelete: (row: FolderRow) => void;
  scroller: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  const store = useShootsStore();
  const { shoots } = usePresenters();
  const element = useRef<HTMLDivElement>(null);

  // Scrolling unmounts the row under the reader's focus, and a removed element
  // drops focus on the document body - after which the next Tab starts from the
  // top of the page. Handing it back to the list keeps the reader where they
  // were, and the list brings the cursor into view when it takes focus.
  //
  // Layout effect, because its cleanup is the last moment the row is still in the
  // document to be asked whether it holds the focus.
  useLayoutEffect(
    () => () => {
      if (element.current?.contains(document.activeElement) === true) scroller.current?.focus();
    },
    [scroller],
  );
  // A shoot shows its first photo from the moment it has one, which is before
  // the import has built that photo's tile, so the banner is routinely asked for
  // a file that is not there yet.
  const [missingBanner, setMissingBanner] = useState<string | null>(null);
  const bannerId = row.shoot?.banner_photo_id ?? null;
  const banner = bannerId == null || bannerId === missingBanner ? null : bannerId;
  const expanded = store.expanded.has(row.folderPath);
  const editing = store.renamingPath === row.folderPath;
  const cursored = store.cursorPath === row.folderPath;

  const options: Option<RowAction>[] = [
    ...(row.shoot == null ? [{ value: 'adopt' as const, label: 'Add as shoot', icon: <Folder size={ICON} /> }] : []),
    { value: 'subfolder', label: 'Create shoot in subfolder', icon: <FolderPlus size={ICON} /> },
  ];

  return (
    <div
      className={`list__row${row.shoot == null ? ' list__row--untracked' : ''}${editing ? ' list__row--editing' : ''}${
        cursored ? ' list__row--cursored' : ''
      }`}
      ref={element}
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      aria-level={row.depth + 1}
      // Says which row the keyboard is on, which the ring alone only tells a
      // reader who can see it.
      aria-current={cursored ? 'true' : undefined}
      // Roving: exactly one row is ever in the tab order, so while the cursor is
      // on screen, tabbing into the list lands on it.
      tabIndex={cursored ? 0 : -1}
      // Pointer, not focus. Focus arrives at a row for reasons that are not the
      // reader choosing it - tabbing forward after a scroll unmounted the row
      // they were in lands on whichever row happens to be mounted, and moving
      // the cursor there would throw away the place they were keeping.
      onPointerDown={() => shoots.setCursor(row.folderPath)}
    >
      <span className="depth" style={{ width: row.depth * 16 }} />

      {row.expandable ? (
        <Button
          iconOnly
          aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
          aria-expanded={expanded}
          onClick={() => void shoots.toggleFolder(row.folderPath)}
        >
          {expanded ? <ChevronDown size={ICON} /> : <ChevronRight size={ICON} />}
        </Button>
      ) : (
        <span className="depth" style={{ width: 0 }} />
      )}

      <span className="list__banner" aria-hidden="true">
        {banner == null ? (
          <span className="list__banner--none">{row.shoot == null && <Folder size={ICON} />}</span>
        ) : (
          <img src={renditionUrl(banner, 'grid')} alt="" onError={() => setMissingBanner(banner)} />
        )}
      </span>

      <div className="list__body">
        {editing ? (
          <TextField
            grow
            autoFocus
            label={`Rename ${row.name}`}
            value={store.renameDraft}
            onChange={shoots.setRenameDraft}
            onBlur={() => void shoots.commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void shoots.commitRename();
              if (e.key === 'Escape') shoots.cancelRename();
            }}
          />
        ) : (
          <span className="list__name">{row.name}</span>
        )}
        <Text variant="mono" as="div">
          {row.subtitle === '' ? '' : `${row.subtitle} · `}
          {row.shoot == null ? 'Not a shoot' : `${row.photoCount} ${row.photoCount === 1 ? 'photo' : 'photos'}`}
        </Text>
      </div>

      {row.shoot != null && (
        <Button render={<Link to={`/shoots/${row.shoot.id}`} />}>
          <Images size={ICON} />
          View photos
        </Button>
      )}
      {row.shoot != null && !editing && (
        <Button onClick={() => shoots.startRename(row.folderPath, row.name)}>
          <Pencil size={ICON} />
          Rename
        </Button>
      )}
      <ActionMenu
        trigger={<Plus size={ICON} />}
        label={`Add to ${row.name}`}
        options={options}
        onSelect={(action) => {
          if (action === 'subfolder') onCreateIn(row.folderPath);
          else void shoots.adopt(row.folderPath);
        }}
      />
      {row.shoot != null && (
        <Button variant="danger" onClick={() => onDelete(row)}>
          <Trash2 size={ICON} />
          Delete
        </Button>
      )}
    </div>
  );
});
