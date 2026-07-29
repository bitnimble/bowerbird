import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderPlus, Images, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { renditionUrl } from '../../api/client';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ActionMenu, Button, Heading, ICON, Option, SegmentedControl, Text, TextField } from '../../ui/ui';
import { libraryLabel } from '../libraries/library_label';
import { AddShootDialog } from './add_shoot_dialog';
import { DeleteShootDialog } from './delete_shoot_dialog';
import type { FolderRow, ShootView } from './shoots_store';

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

  useEffect(() => {
    shoots.restoreView();
    void shoots.load(libraryId);
    // The root row names the library, which the rail has usually loaded already
    // but a deep link has not.
    void librariesPresenter.load();
  }, [libraryId, shoots, librariesPresenter]);

  const library = libraries.byId.get(libraryId);

  function act(row: FolderRow, action: RowAction): void {
    if (action === 'subfolder') setCreatingIn(row.folderPath);
    else void shoots.create(libraryId, basename(row.folderPath), parentOf(row.folderPath), 'taken_asc');
  }

  return (
    <div className="pad">
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
        photoCount={deleting == null ? 0 : store.photosUnder(deleting.folderPath)}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={(photos) => {
          const shoot = deleting?.shoot;
          setDeleting(null);
          if (shoot != null) void shoots.remove(shoot.id, photos);
        }}
      />

      <div className="list">
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

        {store.rows.map((row) => (
          <ShootRow
            key={row.folderPath}
            row={row}
            expanded={store.expanded.has(row.folderPath)}
            onToggle={() => void shoots.toggleFolder(row.folderPath)}
            onRename={(name) => row.shoot != null && void shoots.rename(row.shoot.id, name)}
            onAction={(action) => act(row, action)}
            onDelete={() => setDeleting(row)}
          />
        ))}
      </div>

      {store.rows.length === 0 && (
        <div className="empty">
          <div className="empty__title">No shoots yet</div>
          <Text as="p" variant="muted">
            Switch to All folders to see what is on disk, and make a shoot of any folder from its + menu.
          </Text>
        </div>
      )}
    </div>
  );
});

const ShootRow = observer(function ShootRow({
  row,
  expanded,
  onToggle,
  onRename,
  onAction,
  onDelete,
}: {
  row: FolderRow;
  expanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onAction: (action: RowAction) => void;
  onDelete: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.name);
  // A shoot shows its first photo from the moment it has one, which is before
  // the import has built that photo's tile, so the banner is routinely asked for
  // a file that is not there yet.
  const [missingBanner, setMissingBanner] = useState<string | null>(null);
  const bannerId = row.shoot?.banner_photo_id ?? null;
  const banner = bannerId == null || bannerId === missingBanner ? null : bannerId;

  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== row.name) onRename(next);
  }

  const options: Option<RowAction>[] = [
    ...(row.shoot == null ? [{ value: 'adopt' as const, label: 'Add as shoot', icon: <Folder size={ICON} /> }] : []),
    { value: 'subfolder', label: 'Create shoot in subfolder', icon: <FolderPlus size={ICON} /> },
  ];

  return (
    <div className={`list__row${row.shoot == null ? ' list__row--untracked' : ''}`}>
      <span className="depth" style={{ width: row.depth * 16 }} />

      {row.expandable ? (
        <Button iconOnly aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`} onClick={onToggle}>
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
            value={draft}
            onChange={setDraft}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(row.name);
                setEditing(false);
              }
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
        <Button
          onClick={() => {
            setDraft(row.name);
            setEditing(true);
          }}
        >
          <Pencil size={ICON} />
          Rename
        </Button>
      )}
      <ActionMenu trigger={<Plus size={ICON} />} label={`Add to ${row.name}`} options={options} onSelect={onAction} />
      {row.shoot != null && (
        <Button variant="danger" onClick={onDelete}>
          <Trash2 size={ICON} />
          Delete
        </Button>
      )}
    </div>
  );
});

function basename(folderPath: string): string {
  return folderPath.slice(folderPath.lastIndexOf('/') + 1);
}

function parentOf(folderPath: string): string {
  const slash = folderPath.lastIndexOf('/');
  return slash < 0 ? '' : folderPath.slice(0, slash);
}
