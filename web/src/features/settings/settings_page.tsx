import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderPlus, RefreshCw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { Library, PreviewSource } from '../../api/client';
import { useLibrariesStore, usePresenters, useSyncStore } from '../../app/stores_context';
import { Button, Heading, ICON, type Option, SegmentedControl, Text, TextField } from '../../ui/ui';
import { SyncStrip } from '../sync/sync_strip';

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
            <PreviewSettings library={library} />
          </div>

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

const SOURCES: Option<PreviewSource>[] = [
  { value: 'embedded', label: 'Camera JPEG', icon: <Sparkles size={ICON} /> },
  { value: 'render', label: 'Render the RAW', icon: <Wand2 size={ICON} /> },
];

// What this browser and display say they can do. Reported, never enforced: HDR
// support is negotiated between the browser, the compositor and the monitor's
// EDID, and a wrong "no" here should not stop anyone building HDR previews for
// a machine they will open them on later.
function hdrCapability(): string {
  if (typeof window === 'undefined' || window.matchMedia == null) return 'unknown';
  return window.matchMedia('(dynamic-range: high)').matches ? 'this display reports HDR' : 'this display reports SDR only';
}

// Per library, because one catalogue may be scanned JPEGs where the camera's
// rendering is the point and another RAWs worth demosaicing. Deliberately not
// retroactive: it decides what gets built next, and rebuilding an existing
// catalogue is a job you ask for explicitly, not something a preference does to
// thousands of files behind your back.
const PreviewSettings = observer(function PreviewSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();

  return (
    <div className="panel">
      <SegmentedControl
        label="Thumbnails and previews from"
        options={SOURCES}
        value={library.preview_source}
        onChange={(source) => void libraries.setPreviewSource(library.id, source)}
      />
      <Text variant="mono" as="p">
        The camera JPEG needs no demosaic, so it is much faster, and carries the maker&apos;s colour, but is only as large as the body
        embedded. Rendering demosaics the RAW at full resolution.
      </Text>

      {/* Only offered for a render: an embedded JPEG is 8-bit SDR, so there is
          no headroom in it to carry however the setting is left. */}
      {library.preview_source === 'render' && (
        <label className="row">
          <input
            type="checkbox"
            checked={library.preview_hdr}
            onChange={(e) => void libraries.setPreviewHdr(library.id, e.currentTarget.checked)}
          />
          <span>
            HDR previews <Text variant="mono">({hdrCapability()})</Text>
          </span>
        </label>
      )}
      {library.preview_source === 'render' && (
        <Text variant="mono" as="p">
          Renders the full-size preview as PQ HDR. Chrome and Safari display it; Firefox does not, and shows it dark. The grid stays
          SDR either way. Nothing checks your display first, so you can build HDR here and look at it somewhere else.
        </Text>
      )}

      {/* Nested under HDR because it is a second encode of the same render, and
          meaningless without one. */}
      {library.preview_source === 'render' && library.preview_hdr && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={library.preview_hdr_video}
              onChange={(e) => void libraries.setPreviewHdrVideo(library.id, e.currentTarget.checked)}
            />
            <span>Also encode for Firefox on Windows</span>
          </label>
          <Text variant="mono" as="p">
            Writes a second copy of each HDR preview as a one-frame video, which is the only form Firefox will display in HDR. Costs
            roughly another second per photo on import, for a file no other browser ever reads, so leave it off unless you use
            Firefox on an HDR display.
          </Text>
        </>
      )}
    </div>
  );
});

export const SettingsPage = observer(function SettingsPage(): JSX.Element {
  const store = useLibrariesStore();
  const { libraries } = usePresenters();
  const [rootPath, setRootPath] = useState('');

  useEffect(() => {
    void libraries.load();
  }, [libraries]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (rootPath.trim() === '') return;
    // Sort order is a per-view choice made in the gallery, not a property of the
    // library, so adding one asks for a path and nothing else.
    if (await libraries.create(rootPath.trim(), 'taken_desc')) setRootPath('');
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

      <Text variant="label" as="div" className="panel__title settings__group">
        Import
      </Text>
    </div>
  );
});
