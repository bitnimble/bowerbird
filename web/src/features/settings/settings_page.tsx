import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import type { Ordering } from '../../api/client';
import { useLibrariesStore, usePresenters, useSyncStore } from '../../app/stores_context';
import { Button, Heading, ICON, type Option, Select, Text, TextField } from '../../ui/ui';
import { SyncStrip } from '../sync/sync_strip';

const ORDERINGS: Option<Ordering>[] = [
  { value: 'taken_desc', label: 'Newest taken first' },
  { value: 'taken_asc', label: 'Oldest taken first' },
  { value: 'added_desc', label: 'Newest added first' },
  { value: 'added_asc', label: 'Oldest added first' },
];

// "3 minutes ago" answers "is my catalogue stale?" at a glance; a timestamp does not.
function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Syncing lives here, not on the gallery: it is a maintenance action on the
// library, and the gallery is for looking at photos.
const LibrarySettings = observer(function LibrarySettings(): JSX.Element {
  const store = useLibrariesStore();
  const sync = useSyncStore();
  const { libraries, sync: syncPresenter } = usePresenters();

  return (
    <div className="list">
      {store.libraries.map((library) => (
        <div className="list__row" key={library.id}>
          <div className="list__body">
            <span className="list__name">{library.root_path}</span>
            <Text variant="mono" as="div">
              {library.photo_count} {library.photo_count === 1 ? 'photo' : 'photos'} ·{' '}
              {library.last_synced_at == null ? 'never synced' : `synced ${relativeTime(library.last_synced_at)}`}
            </Text>
            {sync.libraryId === library.id && <SyncStrip />}
          </div>

          <Select
            label={`Default ordering for ${library.root_path}`}
            options={ORDERINGS}
            value={library.ordering}
            onChange={(next) => void libraries.setOrdering(library.id, next)}
          />

          <Button disabled={sync.isBusy && sync.libraryId === library.id} onClick={() => void syncPresenter.trigger(library.id)}>
            <RefreshCw size={ICON} />
            {sync.isBusy && sync.libraryId === library.id ? 'Syncing…' : 'Sync now'}
          </Button>

          <Button
            variant="danger"
            onClick={() => {
              // Removing a library cascades away every rating, note, verdict,
              // album membership and shoot assignment. The RAW files survive,
              // the catalogue does not, and there is no undo.
              const warning =
                `Remove "${library.root_path}" from Bowerbird?\n\n` +
                `Your ${library.photo_count} photo file(s) stay on disk, but all ratings, notes, ` +
                `picks, album memberships and shoot assignments for them are deleted. This cannot be undone.`;
              if (window.confirm(warning)) void libraries.remove(library.id);
            }}
          >
            <Trash2 size={ICON} />
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
});

export const SettingsPage = observer(function SettingsPage(): JSX.Element {
  const store = useLibrariesStore();
  const { libraries } = usePresenters();
  const [rootPath, setRootPath] = useState('');
  const [ordering, setOrdering] = useState<Ordering>('taken_desc');

  useEffect(() => {
    void libraries.load();
  }, [libraries]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (rootPath.trim() === '') return;
    if (await libraries.create(rootPath.trim(), ordering)) setRootPath('');
  }

  return (
    <div className="pad">
      <Heading>Settings</Heading>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={libraries.clearError}>Dismiss</Button>
        </div>
      )}

      <Text variant="label" as="div" className="panel__title">
        Libraries
      </Text>

      <div className="panel">
        <form className="row" onSubmit={(e) => void submit(e)}>
          <TextField grow label="Library root path" placeholder="/photos" value={rootPath} onChange={setRootPath} />
          <Select label="Default ordering" options={ORDERINGS} value={ordering} onChange={setOrdering} />
          <Button variant="primary" type="submit" disabled={store.loading}>
            <FolderPlus size={ICON} />
            Add library
          </Button>
        </form>
        <Text variant="mono" as="p">
          The path is read on the server, not this browser. It must already exist.
        </Text>
      </div>

      {store.isEmpty ? (
        <div className="empty">
          <div className="empty__title">No libraries yet</div>
          <Text as="p" variant="muted">
            Point Bowerbird at a folder of RAW files to start cataloguing.
          </Text>
        </div>
      ) : (
        <LibrarySettings />
      )}
    </div>
  );
});
