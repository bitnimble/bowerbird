import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderPlus, Images, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { renditionUrl } from '../../api/client';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ActionMenu, Button, Heading, ICON, Option, SegmentedControl, Text, TextField } from '../../ui/ui';
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
  // both readings start from the top. The presenter has already zeroed the store.
  useEffect(() => {
    if (scroller.current != null) scroller.current.scrollTop = 0;
  }, [libraryId, store.view]);

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

const ShootRow = observer(function ShootRow({
  row,
  position,
  total,
  onCreateIn,
  onDelete,
}: {
  row: FolderRow;
  position: number;
  total: number;
  onCreateIn: (folderPath: string) => void;
  onDelete: (row: FolderRow) => void;
}): JSX.Element {
  const store = useShootsStore();
  const { shoots } = usePresenters();
  // A shoot shows its first photo from the moment it has one, which is before
  // the import has built that photo's tile, so the banner is routinely asked for
  // a file that is not there yet.
  const [missingBanner, setMissingBanner] = useState<string | null>(null);
  const bannerId = row.shoot?.banner_photo_id ?? null;
  const banner = bannerId == null || bannerId === missingBanner ? null : bannerId;
  const expanded = store.expanded.has(row.folderPath);
  const editing = store.renamingPath === row.folderPath;

  const options: Option<RowAction>[] = [
    ...(row.shoot == null ? [{ value: 'adopt' as const, label: 'Add as shoot', icon: <Folder size={ICON} /> }] : []),
    { value: 'subfolder', label: 'Create shoot in subfolder', icon: <FolderPlus size={ICON} /> },
  ];

  return (
    <div
      className={`list__row${row.shoot == null ? ' list__row--untracked' : ''}${editing ? ' list__row--editing' : ''}`}
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      aria-level={row.depth + 1}
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
