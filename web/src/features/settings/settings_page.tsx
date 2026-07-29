import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { CircleStop, FolderPlus, History, Maximize2, RefreshCw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { Library, Settings, UpdateSettingsRequest, ViewerRenditionMode, RenditionSource } from '../../api/client';
import { useAppSettingsStore, useLibrariesStore, usePresenters, useSyncStore } from '../../app/stores_context';
import { renditionLabel } from '../photos/renditions';
import { Button, Heading, ICON, type Option, SegmentedControl, Select, Text, TextField } from '../../ui/ui';
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
            <RenditionSettings library={library} />
          </div>

          {/* The same slot, because stopping is what you want from a run in
              flight and starting another is not on offer anyway. */}
          {sync.isBusy && sync.libraryId === library.id ? (
            <Button onClick={() => void syncPresenter.cancel(library.id)}>
              <CircleStop size={ICON} />
              Stop
            </Button>
          ) : (
            <Button onClick={() => void syncPresenter.trigger(library.id)}>
              <RefreshCw size={ICON} />
              Sync now
            </Button>
          )}

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

// Named as the viewer names the rendition each one produces, so the setting and
// the picker are visibly the same two choices.
const SOURCES: Option<RenditionSource>[] = [
  { value: 'embedded', label: renditionLabel('embedded'), icon: <Sparkles size={ICON} /> },
  { value: 'render', label: renditionLabel('full'), icon: <Wand2 size={ICON} /> },
];

// What this browser and display say they can do. Reported, never enforced: HDR
// support is negotiated between the browser, the compositor and the monitor's
// EDID, and a wrong "no" here should not stop anyone building HDR renditions for
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
const RenditionSettings = observer(function RenditionSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();

  return (
    <div className="panel">
      <SegmentedControl
        label="Build renditions from"
        options={SOURCES}
        value={library.rendition_source}
        onChange={(source) => void libraries.setRenditionSource(library.id, source)}
      />
      <Text variant="mono" as="p">
        The embedded JPEG needs no demosaic, so it is much faster, and carries the maker&apos;s colour, but is only as large as the body
        embedded. Rendering demosaics the RAW at full resolution.
      </Text>

      {/* Only offered for a render: an embedded JPEG is 8-bit SDR, so there is
          no headroom in it to carry however the setting is left. */}
      {library.rendition_source === 'render' && (
        <label className="row">
          <input
            type="checkbox"
            checked={library.rendition_hdr}
            onChange={(e) => void libraries.setRenditionHdr(library.id, e.currentTarget.checked)}
          />
          <span>
            HDR renditions <Text variant="mono">({hdrCapability()})</Text>
          </span>
        </label>
      )}
      {library.rendition_source === 'render' && (
        <Text variant="mono" as="p">
          Renders the full-size rendition as PQ HDR. Chrome and Safari display it; Firefox does not, and shows it dark. The grid stays
          SDR either way. Nothing checks your display first, so you can build HDR here and look at it somewhere else.
        </Text>
      )}

      {/* Nested under HDR because it is a second encode of the same render, and
          meaningless without one. */}
      {library.rendition_source === 'render' && library.rendition_hdr && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={library.rendition_hdr_video}
              onChange={(e) => void libraries.setRenditionHdrVideo(library.id, e.currentTarget.checked)}
            />
            <span>Also encode for Firefox on Windows</span>
          </label>
          <Text variant="mono" as="p">
            Writes a second copy of each HDR rendition as a one-frame video, which is the only form Firefox will display in HDR. Costs
            roughly another second per photo on import, for a file no other browser ever reads, so leave it off unless you use
            Firefox on an HDR display.
          </Text>
        </>
      )}
    </div>
  );
});

// The three renditions under the names the viewer gives them, then the two modes
// that follow whatever was chosen there.
const RENDITION_MODES: Option<ViewerRenditionMode>[] = [
  { value: 'embedded', label: renditionLabel('embedded'), icon: <Sparkles size={ICON} /> },
  { value: 'full', label: renditionLabel('full'), icon: <Wand2 size={ICON} /> },
  { value: 'max', label: renditionLabel('max'), icon: <Maximize2 size={ICON} /> },
  { value: 'remember', label: 'Last used', icon: <History size={ICON} /> },
  { value: 'remember_per_photo', label: 'Last used per photo', icon: <History size={ICON} /> },
];

// Global rather than per library: it is about how you look at photos, not about
// what a catalogue holds, and the renditions are interchangeable views of the
// same frame (§10.2). Server-side rather than in this browser, because the same
// catalogue gets opened from a phone and a desktop and "where I left off" is
// worth nothing if it only holds on one of them.
const ViewingSettings = observer(function ViewingSettings(): JSX.Element {
  const settings = useAppSettingsStore();
  const { appSettings } = usePresenters();

  return (
    <div className="panel">
      <SegmentedControl
        label="Open photos at"
        options={RENDITION_MODES}
        value={settings.viewerRenditionMode}
        onChange={(mode) => void appSettings.setViewerRenditionMode(mode)}
      />
      <Text variant="mono" as="p">
        The same picture as three renditions: the camera&apos;s own JPEG, a render of the RAW, and a full-resolution render. Each is built
        the first time it is asked for and cached, so anything above the one your library builds on import costs a wait the first time
        you open a photo.
      </Text>
    </div>
  );
});

// The knobs that used to be environment variables. They live in the catalogue
// now and apply to the running server, so nothing here needs a restart: the
// worker pool and encoder settings are read per job, and the watcher and the
// schedulers are re-configured as each edit lands.
type SettingOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];

function useSettingWriter(): (patch: UpdateSettingsRequest) => Promise<void> {
  const { appSettings, toasts } = usePresenters();
  return async (patch) => {
    try {
      await appSettings.update(patch);
    } catch (err) {
      toasts.showError('Could not save that setting', (err as Error).message);
    }
  };
}

function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="setting">
      <span className="setting__label">{label}</span>
      {children}
      {hint != null && (
        <Text variant="mono" as="p" className="setting__hint">
          {hint}
        </Text>
      )}
    </div>
  );
}

// Committed on blur or Enter rather than per keystroke: every character of "3840"
// would otherwise be a round trip, and "3" is a size the server would accept.
const NumberSetting = observer(function NumberSetting({
  field,
  label,
  hint,
}: {
  field: SettingOf<number>;
  label: string;
  hint?: ReactNode;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field];
  const [draft, setDraft] = useState(String(value ?? ''));

  useEffect(() => setDraft(String(value ?? '')), [value]);

  async function commit(): Promise<void> {
    const next = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(next) && next !== value) await write({ [field]: next } as UpdateSettingsRequest);
    // Whatever the server made of it, including refusing it outright, is what
    // the field goes back to showing.
    setDraft(String(store.settings?.[field] ?? ''));
  }

  return (
    <SettingRow label={label} hint={hint}>
      <TextField
        label={label}
        value={draft}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

const TextSetting = observer(function TextSetting({
  field,
  label,
  placeholder,
  hint,
}: {
  field: SettingOf<string>;
  label: string;
  placeholder?: string;
  hint?: ReactNode;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field];
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => setDraft(value ?? ''), [value]);

  async function commit(): Promise<void> {
    if (draft !== value) await write({ [field]: draft } as UpdateSettingsRequest);
    setDraft(store.settings?.[field] ?? '');
  }

  return (
    <SettingRow label={label} hint={hint}>
      <TextField
        label={label}
        value={draft}
        placeholder={placeholder}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

const ToggleSetting = observer(function ToggleSetting({
  field,
  label,
  hint,
}: {
  field: SettingOf<boolean>;
  label: string;
  hint?: ReactNode;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();

  return (
    <SettingRow label={label} hint={hint}>
      <input
        type="checkbox"
        aria-label={label}
        checked={store.settings?.[field] ?? false}
        onChange={(e) => void write({ [field]: e.currentTarget.checked } as UpdateSettingsRequest)}
      />
    </SettingRow>
  );
});

const LOG_LEVELS: Option<Settings['log_level']>[] = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

const ServerSettings = observer(function ServerSettings(): JSX.Element | null {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  // Nothing until the settings arrive: a field pre-filled with a default the
  // server may not hold invites editing a value that was never real.
  if (store.settings == null) return null;

  return (
    <>
      <Text variant="label" as="div" className="panel__title settings__group">
        Import
      </Text>
      <div className="panel">
        <NumberSetting
          field="processing_concurrency"
          label="Worker threads"
          hint="How many photos are decoded and encoded at once. Each worker is a whole RAW decode in memory, so more is not free."
        />
        <ToggleSetting
          field="match_embedded_jpeg"
          label="Match the camera's own rendering"
          hint="Fits the render to the JPEG the body embedded in the same RAW, so a photo comes out the maker's colour rather than a neutral one. Roughly +2.4s on a 61MP frame."
        />
      </div>

      <Text variant="label" as="div" className="panel__title settings__group">
        Renditions
      </Text>
      <div className="panel">
        <NumberSetting field="grid_rendition_size" label="Grid tile, longest edge (px)" />
        <NumberSetting field="grid_rendition_quality" label="Grid tile quality (1-100)" />
        <NumberSetting field="full_rendition_size" label="Viewer rendition, longest edge (px)" />
        <NumberSetting
          field="full_rendition_quality"
          label="Viewer rendition quality (1-100)"
          hint="AVIF, which is not WebP's scale: 60 and 70 visibly lose the shadow detail a RAW has the most to give."
        />
        <NumberSetting
          field="rendition_effort"
          label="AVIF effort (0-9)"
          hint="Encoder search depth. 4 costs 13.6s against 0.6s at 0 on a 3840px frame, for a file ~15% smaller."
        />
        <NumberSetting field="lossless_quality" label="Full-resolution quality (1-100)" />
        <NumberSetting
          field="lossless_quantizer"
          label="Full-resolution HDR quantizer (0-63)"
          hint="avifenc's scale for the HDR export; lower is better. Both of these are set tight, because this is the view that exists to be pixel-peeped."
        />
      </div>

      <Text variant="label" as="div" className="panel__title settings__group">
        HDR
      </Text>
      <div className="panel">
        <NumberSetting
          field="hdr_reference_white_nits"
          label="Reference white (nits)"
          hint="What diffuse white is graded to (ITU-R BT.2408). With the quantile below, this is the pair to reach for if a library comes out consistently dark or hot."
        />
        <NumberSetting
          field="hdr_white_quantile"
          label="Diffuse-white quantile (0-1)"
          hint="Which part of the histogram is taken to be diffuse white. Lower renders brighter: it places white further down, so everything above it scales up."
        />
        <NumberSetting
          field="hdr_peak_nits"
          label="Peak (nits)"
          hint="Display peak the roll-off targets, and what the file declares as its mastering peak. Only sets how much headroom sits above diffuse white."
        />
        <NumberSetting field="hdr_crf" label="Encoder quality (0-63)" hint="Lower is better." />
        <NumberSetting field="hdr_preset" label="Encoder speed (0-10)" />
        <NumberSetting
          field="hdr_max_edge"
          label="Longest edge (px)"
          hint="AV1 cannot encode a current sensor at native size. 4K shows 1:1 on the displays that do HDR."
        />
      </div>

      <Text variant="label" as="div" className="panel__title settings__group">
        Sync and maintenance
      </Text>
      <div className="panel">
        <ToggleSetting
          field="watch_enabled"
          label="Watch libraries for changes"
          hint="Syncs a library when its files change on disk, without waiting to be asked."
        />
        <NumberSetting
          field="watch_debounce_ms"
          label="Debounce window (ms)"
          hint="How long changes are collected before a sync starts, so a copy of a hundred files is one sync rather than a hundred."
        />
        <TextSetting
          field="full_sync_at"
          label="Daily full reconcile at"
          placeholder="03:00"
          hint="Local HH:MM; empty disables. The backstop for changes the watcher missed. It holds the library lock while it scans, so pick a quiet hour."
        />
        <NumberSetting
          field="prune_every_days"
          label="Orphan sweep every (days)"
          hint="Deletes generated files whose photo no longer exists. 0 disables. It only has anything to do after a library is removed or a catalogue rebuilt."
        />
      </div>

      <Text variant="label" as="div" className="panel__title settings__group">
        Server
      </Text>
      <div className="panel">
        <SettingRow label="Log level" hint="debug adds a line per HTTP request and per finished processing stage.">
          <Select
            label="Log level"
            options={LOG_LEVELS}
            value={store.settings.log_level}
            onChange={(level) => void write({ log_level: level })}
          />
        </SettingRow>
        <TextSetting
          field="cors_origins"
          label="Allowed origins"
          placeholder="any origin on this host"
          hint="Comma-separated, or * for any. Empty means any port on whatever host the request arrived at, which covers loopback and the LAN without hardcoding an address."
        />
        <Text variant="mono" as="p">
          The listen address and the database path are not here: they are read before this catalogue can be opened, so they stay in the
          environment (HOST, PORT, DB_PATH).
        </Text>
      </div>
    </>
  );
});

export const SettingsPage = observer(function SettingsPage(): JSX.Element {
  const store = useLibrariesStore();
  const { libraries } = usePresenters();
  const [rootPath, setRootPath] = useState('');

  const { appSettings } = usePresenters();

  useEffect(() => {
    void libraries.load();
    void appSettings.load();
  }, [libraries, appSettings]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (rootPath.trim() === '') return;
    // Sort order is a per-view choice made in the gallery, not a property of the
    // library, so adding one asks for a path and nothing else.
    if (await libraries.create(rootPath.trim(), 'taken_asc')) setRootPath('');
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
        Viewing
      </Text>
      <ViewingSettings />

      <ServerSettings />
    </div>
  );
});
