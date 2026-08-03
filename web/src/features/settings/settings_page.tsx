import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { CircleStop, FolderPlus, Image, RefreshCw, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import type { Library, Settings, UpdateSettingsRequest, ViewerRenditionMode, RenditionSource } from '../../api/client';
import { DEFAULT_SETTINGS } from '../../../../src/schemas/settings';
import { DEFAULT_LIBRARY_SETTINGS } from '../../../../src/schemas/libraries';
import { useAppSettingsStore, useLibrariesStore, usePresenters, useSyncStore } from '../../app/stores_context';
import { AddLibraryDialog } from '../libraries/add_library_dialog';
import { libraryLabel } from '../libraries/library_label';
import { renditionLabel } from '../photos/renditions';
import { SyncStrip } from '../sync/sync_strip';
import { Button } from '../../ui/button';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';

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

// One tuning knob: what it is, the control, and why you would move it. A reason
// rather than a boolean for `disabled`, because a control that cannot be used
// and does not say why is worse than one that is simply missing.
//
// `onReset` only when the value differs from the shipped default: a control that
// already holds the default has nothing to undo.
function SettingRow({
  label,
  hint,
  disabledReason,
  onReset,
  children,
}: {
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
  onReset?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`setting${disabledReason == null ? '' : ' setting--off'}`} title={disabledReason}>
      <span className="setting__label">{label}</span>
      <div className="setting__value">
        {onReset != null && (
          <Button
            iconOnly
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            title="Reset to default"
            onClick={onReset}
          >
            <RotateCcw size={ICON} />
          </Button>
        )}
        {children}
      </div>
      {hint != null && (
        <Text variant="mono" as="p" className="setting__hint">
          {hint}
        </Text>
      )}
    </div>
  );
}

// Syncing lives here, not on the gallery: it is a maintenance action on the
// library, and the gallery is for looking at photos.
const LibraryList = observer(function LibraryList(): JSX.Element {
  const store = useLibrariesStore();
  const sync = useSyncStore();
  const { libraries, sync: syncPresenter } = usePresenters();

  return (
    <div className="list">
      {store.libraries.map((library) => (
        <div className="list__row" key={library.id}>
          <div className="list__body">
            <div className="row">
              <LibraryName library={library} />
              <span className="spacer" />

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
                    `Remove "${libraryLabel(library)}" from Bowerbird?\n\n` +
                    `Your ${library.photo_count} photo file(s) stay on disk, but all ratings, notes, ` +
                    `picks, album memberships and shoot assignments for them are deleted. This cannot be undone.`;
                  if (window.confirm(warning)) void libraries.remove(library.id);
                }}
              >
                <Trash2 size={ICON} />
                Remove
              </Button>
            </div>

            <Text variant="mono" as="div" className="list__meta">
              {library.root_path} · {library.photo_count} {library.photo_count === 1 ? 'photo' : 'photos'} ·{' '}
              {library.last_synced_at == null ? 'never synced' : `synced ${relativeTime(library.last_synced_at)}`}
            </Text>
            {sync.libraryId === library.id && <SyncStrip />}
            <details className="advanced">
              <summary className="advanced__summary">Library settings</summary>
              <FolderSettings library={library} />
              <RenditionSettings library={library} />
              <StackSettings library={library} />
            </details>
            <LibraryJobs library={library} />
          </div>
        </div>
      ))}
    </div>
  );
});

const LibraryName = observer(function LibraryName({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();
  const [draft, setDraft] = useState(library.name);

  useEffect(() => setDraft(library.name), [library.name]);

  function commit(): void {
    const next = draft.trim();
    if (next === '') {
      setDraft(library.name);
      return;
    }
    if (next !== library.name) void libraries.setName(library.id, next);
  }

  return (
    <span className="list__name">
      <TextField label="Library name" value={draft} onChange={setDraft} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </span>
  );
});

// Named as the viewer names the rendition each one produces, so the setting and
// the picker are visibly the same two choices.
const SOURCES: Option<RenditionSource>[] = [
  { value: 'embedded', label: renditionLabel('embedded') },
  { value: 'render', label: renditionLabel('full') },
];

// What this browser and display say they can do. Reported, never enforced: HDR
// support is negotiated between the browser, the compositor and the monitor's
// EDID, and a wrong "no" here should not stop anyone building HDR renditions for
// a machine they will open them on later.
function hdrCapability(): string {
  if (typeof window === 'undefined' || window.matchMedia == null) return 'unknown';
  return window.matchMedia('(dynamic-range: high)').matches ? 'this display reports HDR' : 'this display reports SDR only';
}

// What the library is, as opposed to what it builds: how much of the folder tree
// belongs to it, and whether those folders are its shoots. Standing rules rather
// than decisions taken at import, so a folder made next month is in or out for
// the same reason today's are (§4.1).
const FolderSettings = observer(function FolderSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();

  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        Folders
      </Text>

      <SettingRow
        label="Include subfolders"
        hint="Off, the library is the photographs sitting in its root folder and nothing else, however deep the tree goes. Turning it off drops the photos already imported from the subfolders; the files themselves are never touched."
        onReset={
          library.include_subfolders === DEFAULT_LIBRARY_SETTINGS.include_subfolders
            ? undefined
            : () => void libraries.setIncludeSubfolders(library.id, DEFAULT_LIBRARY_SETTINGS.include_subfolders)
        }
      >
        <input
          type="checkbox"
          aria-label="Include subfolders"
          checked={library.include_subfolders}
          onChange={(e) => void libraries.setIncludeSubfolders(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      {/* A shoot is a subfolder, so there is nothing for this to mirror when the
          library is its root alone. */}
      <SettingRow
        label="Make shoots from folders"
        hint="Keeps a shoot for every folder holding photographs, so the catalogue always agrees with the tree on disk. Off, a shoot exists only where you make one, and the rest are offered on the Shoots page."
        disabledReason={library.include_subfolders ? undefined : 'This library is its root folder only, so it has no folders to mirror.'}
        onReset={
          library.mirror_shoots === DEFAULT_LIBRARY_SETTINGS.mirror_shoots
            ? undefined
            : () => void libraries.setMirrorShoots(library.id, DEFAULT_LIBRARY_SETTINGS.mirror_shoots)
        }
      >
        <input
          type="checkbox"
          aria-label="Make shoots from folders"
          checked={library.mirror_shoots}
          // Every other SettingRow with a reason passes this too: a control that
          // looks disabled and is not sends a request contradicting its tooltip.
          disabled={!library.include_subfolders}
          onChange={(e) => void libraries.setMirrorShoots(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      <FolderRuleList library={library} />
    </div>
  );
});

// Invisible state otherwise: both rules are written by deleting a shoot, and a
// folder that has quietly stopped being part of the library needs somewhere it
// can be found and undone.
const FolderRuleList = observer(function FolderRuleList({ library }: { library: Library }): JSX.Element | null {
  const store = useLibrariesStore();
  const { libraries } = usePresenters();
  const rules = store.folderRules.get(library.id) ?? [];

  useEffect(() => {
    void libraries.loadFolderRules(library.id);
  }, [libraries, library.id]);

  if (rules.length === 0) return null;

  return (
    <div className="rules">
      <Text variant="label" as="div">
        Folders you have set aside
      </Text>
      {rules.map((rule) => (
        <div className="rules__row" key={rule.folder_path}>
          <Text variant="mono">{rule.folder_path}</Text>
          <Text variant="muted">
            {rule.rule === 'excluded' ? 'Not part of this library' : 'In the library, but not a shoot'}
          </Text>
          <Button onClick={() => void libraries.clearFolderRule(library.id, rule.folder_path)}>Undo</Button>
        </div>
      ))}
    </div>
  );
});

// Per library, because one catalogue may be scanned JPEGs where the camera's
// rendering is the point and another RAWs worth demosaicing. Deliberately not
// retroactive: it decides what gets built next, and rebuilding an existing
// catalogue is a job you ask for explicitly, not something a preference does to
// thousands of files behind your back.
const RenditionSettings = observer(function RenditionSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();
  const rendered = library.rendition_source === 'render';

  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        Renditions
      </Text>

      <SettingRow
        label="Build renditions from"
        hint="The camera's JPEG is much faster and carries the colour the camera chose, but it is only as large as the camera saved it. Rendering develops the RAW at full resolution and is the only source that can produce HDR."
        onReset={
          library.rendition_source === DEFAULT_LIBRARY_SETTINGS.rendition_source
            ? undefined
            : () => void libraries.setRenditionSource(library.id, DEFAULT_LIBRARY_SETTINGS.rendition_source)
        }
      >
        <Select
          label="Build renditions from"
          options={SOURCES}
          value={library.rendition_source}
          onChange={(source) => void libraries.setRenditionSource(library.id, source)}
        />
      </SettingRow>

      {/* Only offered for a render: an embedded JPEG is 8-bit SDR, so there is
          no headroom in it to carry however the setting is left. */}
      {rendered && (
        <SettingRow
          label="Build HDR renditions"
          hint={`Stores the large rendition in high dynamic range. Every current browser displays it - Firefox by way of a rewrap the viewer does in the page. The grid stays standard range either way (${hdrCapability()}).`}
          onReset={
            library.rendition_hdr === DEFAULT_LIBRARY_SETTINGS.rendition_hdr
              ? undefined
              : () => void libraries.setRenditionHdr(library.id, DEFAULT_LIBRARY_SETTINGS.rendition_hdr)
          }
        >
          <input
            type="checkbox"
            aria-label="Build HDR renditions"
            checked={library.rendition_hdr}
            onChange={(e) => void libraries.setRenditionHdr(library.id, e.currentTarget.checked)}
          />
        </SettingRow>
      )}
    </div>
  );
});

// Per library, because one catalogue may be burst-heavy sport where a stack is
// the unit of work and another a studio where every frame is deliberate.
const StackSettings = observer(function StackSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();

  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        Stacks
      </Text>

      <SettingRow
        label="Group similar photos automatically"
        hint="Runs after a sync that brought new photos in, grouping frames of the same shot into one tile. Photos imported before this was switched on are not looked at; rebuilding a library's grid renditions is what gives them something to compare."
        onReset={
          library.auto_stack === DEFAULT_LIBRARY_SETTINGS.auto_stack
            ? undefined
            : () => void libraries.setAutoStack(library.id, DEFAULT_LIBRARY_SETTINGS.auto_stack)
        }
      >
        <input
          type="checkbox"
          aria-label="Group similar photos automatically"
          checked={library.auto_stack}
          onChange={(e) => void libraries.setAutoStack(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      {library.auto_stack && (
        <>
          <LibraryNumberField
            libraryId={library.id}
            field="auto_stack_similarity"
            label="How alike, from 0 to 1"
            hint="Raise it and stacks split; lower it and they merge. Photos of one scene from a different angle or distance sit around 0.8, and two genuinely different shots from the same spot below 0.75."
            onCommit={(next) => libraries.setAutoStackSimilarity(library.id, next)}
          />

          <LibraryNumberField
            libraryId={library.id}
            field="auto_stack_window_seconds"
            label="Seconds between frames"
            hint="How long a gap can be and still count as the same run. It only gates neighbours, so a stack chains as far as it likes: what ends one is a frame no longer matching every other frame already in it."
            onCommit={(next) => libraries.setAutoStackWindow(library.id, next)}
          />
        </>
      )}
    </div>
  );
});

// Same draft/commit shape as NumberSetting: typing "0." must not fire a write of 0
// mid-keystroke, and a refused value snaps back to whatever the library still holds.
const LibraryNumberField = observer(function LibraryNumberField({
  libraryId,
  field,
  label,
  hint,
  onCommit,
}: {
  libraryId: string;
  field: 'auto_stack_similarity' | 'auto_stack_window_seconds';
  label: string;
  hint: ReactNode;
  onCommit: (next: number) => void | Promise<void>;
}): JSX.Element {
  const store = useLibrariesStore();
  const value = store.byId.get(libraryId)?.[field] ?? 0;
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  async function commit(): Promise<void> {
    const next = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(next) && next !== value) await onCommit(next);
    setDraft(String(store.byId.get(libraryId)?.[field] ?? value));
  }

  const fallback = DEFAULT_LIBRARY_SETTINGS[field];

  return (
    <SettingRow
      label={label}
      hint={hint}
      onReset={value === fallback ? undefined : () => void onCommit(fallback)}
    >
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

// Stages of a sync offered on their own: scan without forcing rebuilds, or
// regenerate every tile / every viewer render. Collapsed: maintenance, not
// something you reach for every visit.
const LibraryJobs = observer(function LibraryJobs({ library }: { library: Library }): JSX.Element {
  const sync = useSyncStore();
  const { sync: syncPresenter } = usePresenters();
  const busy = sync.isBusy && sync.libraryId === library.id;
  const renders = library.rendition_source === 'render';

  return (
    <details className="advanced">
      <summary className="advanced__summary">Library jobs</summary>

      <div className="panel">
        <SettingRow
          label="Scan & reconcile"
          hint="Walks the folder tree and updates the catalogue for anything that appeared, moved, changed or vanished. Builds only what new or changed photos still owe."
          disabledReason={busy ? 'A job is already running for this library.' : undefined}
        >
          <Button disabled={busy} onClick={() => void syncPresenter.trigger(library.id)}>
            <RefreshCw size={ICON} />
            Run
          </Button>
        </SettingRow>

        <SettingRow
          label="Rebuild grid thumbnails"
          hint="Regenerates every grid tile from the camera's JPEG. Viewer renders are left alone."
          disabledReason={busy ? 'A job is already running for this library.' : undefined}
        >
          <Button disabled={busy} onClick={() => void syncPresenter.rebuildTiles(library.id)}>
            <Image size={ICON} />
            Run
          </Button>
        </SettingRow>

        <SettingRow
          label="Rebuild renders"
          hint="Regenerates every full-size viewer rendition from the RAW, using the library's current rendition settings. Use after changing those settings, or after a pipeline change."
          disabledReason={
            busy
              ? 'A job is already running for this library.'
              : renders
                ? undefined
                : "This library serves the camera's JPEG in the viewer, so there are no renders to rebuild."
          }
        >
          <Button disabled={busy || !renders} onClick={() => void syncPresenter.rebuildRenditions(library.id)}>
            <Sparkles size={ICON} />
            Run
          </Button>
        </SettingRow>
      </div>
    </details>
  );
});
// The three renditions under the names the viewer gives them, then the two modes
// that follow whatever was chosen there.
const RENDITION_MODES: Option<ViewerRenditionMode>[] = [
  { value: 'embedded', label: renditionLabel('embedded') },
  { value: 'full', label: renditionLabel('full') },
  { value: 'max', label: renditionLabel('max') },
  { value: 'remember', label: 'Last used' },
  { value: 'remember_per_photo', label: 'Last used per photo' },
];

// Global rather than per library: it is about how you look at photos, not about
// what a catalogue holds, and the renditions are interchangeable views of the
// same frame (§10.2). Server-side rather than in this browser, because the same
// catalogue gets opened from a phone and a desktop and "where I left off" is
// worth nothing if it only holds on one of them.
const ViewingSettings = observer(function ViewingSettings(): JSX.Element {
  const settings = useAppSettingsStore();
  const { appSettings } = usePresenters();
  const mode = settings.viewerRenditionMode;

  return (
    <div className="panel">
      <SettingRow
        label="Default rendition in photo viewer"
        hint="Each rendition is built the first time it is asked for and then kept, so opening at a larger one than your library builds costs a wait the first time you open a photo."
        onReset={
          mode === DEFAULT_SETTINGS.viewer_rendition_mode
            ? undefined
            : () => void appSettings.setViewerRenditionMode(DEFAULT_SETTINGS.viewer_rendition_mode)
        }
      >
        <Select
          label="Default rendition in photo viewer"
          options={RENDITION_MODES}
          value={mode}
          onChange={(next) => void appSettings.setViewerRenditionMode(next)}
        />
      </SettingRow>
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

// Committed on blur or Enter rather than per keystroke: every character of "3840"
// would otherwise be a round trip, and "3" is a size the server would accept.
// `scale` is for UI units that differ from storage (e.g. seconds on screen, ms on the wire).
const NumberSetting = observer(function NumberSetting({
  field,
  label,
  hint,
  disabledReason,
  scale = 1,
}: {
  field: SettingOf<number>;
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
  scale?: number;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field];
  const shown = value == null ? '' : String(value / scale);
  const [draft, setDraft] = useState(shown);

  useEffect(() => setDraft(value == null ? '' : String(value / scale)), [value, scale]);

  async function commit(): Promise<void> {
    const nextDisplay = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(nextDisplay)) {
      // scale ≠ 1 is a unit conversion into integer storage (seconds → ms); leave
      // fractional settings alone so 0.5 denoise does not become 1.
      const next = scale === 1 ? nextDisplay : Math.round(nextDisplay * scale);
      if (next !== value) await write({ [field]: next } as UpdateSettingsRequest);
    }
    // Whatever the server made of it, including refusing it outright, is what
    // the field goes back to showing.
    const stored = store.settings?.[field];
    setDraft(stored == null ? '' : String(stored / scale));
  }

  const fallback = DEFAULT_SETTINGS[field];

  return (
    <SettingRow
      label={label}
      hint={hint}
      disabledReason={disabledReason}
      onReset={value === fallback ? undefined : () => void write({ [field]: fallback } as UpdateSettingsRequest)}
    >
      <TextField
        label={label}
        value={draft}
        disabled={disabledReason != null}
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

  const fallback = DEFAULT_SETTINGS[field];

  return (
    <SettingRow
      label={label}
      hint={hint}
      onReset={value === fallback ? undefined : () => void write({ [field]: fallback } as UpdateSettingsRequest)}
    >
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
  disabledReason,
}: {
  field: SettingOf<boolean>;
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field] ?? false;
  const fallback = DEFAULT_SETTINGS[field];

  return (
    <SettingRow
      label={label}
      hint={hint}
      disabledReason={disabledReason}
      onReset={value === fallback ? undefined : () => void write({ [field]: fallback } as UpdateSettingsRequest)}
    >
      <input
        type="checkbox"
        aria-label={label}
        disabled={disabledReason != null}
        checked={value}
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

function GroupTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text variant="label" as="div" className="panel__title settings__group">
      {children}
    </Text>
  );
}

// The two decisions worth making without reading anything, then everything else
// behind one disclosure. Nothing until the settings arrive: a field pre-filled
// with a default the server may not hold invites editing a value that was never
// real.
const AppSettings = observer(function AppSettings(): JSX.Element | null {
  const store = useAppSettingsStore();
  if (store.settings == null) return null;

  return (
    <>
      <GroupTitle>Processing</GroupTitle>
      <div className="panel">
        <ToggleSetting
          field="match_embedded_jpeg"
          label="Match the camera's colour"
          hint="Renders each RAW to look like the JPEG the camera made from it, rather than to a neutral starting point. It costs a couple of seconds per photo."
        />
      </div>

      <GroupTitle>Syncing</GroupTitle>
      <div className="panel">
        <ToggleSetting
          field="watch_enabled"
          label="Watch libraries for changes"
          hint="Syncs a library as soon as its files change on disk, without waiting to be asked."
        />
        <TextSetting
          field="full_sync_at"
          label="Daily full scan at"
          placeholder="03:00"
          hint="Local time as HH:MM, or empty to turn it off. A full scan catches anything the watcher missed, and it locks the library while it runs, so pick a quiet hour."
        />
      </div>

      <AdvancedSettings />
    </>
  );
});

// Everything that is a number to tune rather than a decision to make, one click
// away. These are read per job, so a change lands on the next photo processed.
const AdvancedSettings = observer(function AdvancedSettings(): JSX.Element | null {
  const store = useAppSettingsStore();
  const libraries = useLibrariesStore();
  const write = useSettingWriter();
  // Every HDR setting below is read while building an HDR rendition, so with no
  // library asking for one there is nothing for them to change.
  const noHdr = libraries.libraries.every((library) => !library.rendition_hdr);
  const hdrOff = noHdr ? 'No library builds HDR renditions. Turn on HDR for a library to use these.' : undefined;

  if (store.settings == null) return null;

  return (
    <details className="advanced">
      <summary className="advanced__summary">Advanced settings</summary>

      <GroupTitle>Import</GroupTitle>
      <div className="panel">
        <NumberSetting
          field="processing_concurrency"
          label="Worker threads"
          hint="How many photos are processed at once. Each worker holds a whole RAW in memory, so more of them is not always faster."
        />
      </div>

      <GroupTitle>Rendering a RAW</GroupTitle>
      <div className="panel">
        <NumberSetting
          field="raw_denoise_luma"
          label="Grain reduction (1 is normal, 0 is off)"
          hint="Removes the fine grain in a dark area, and measures how much a photo actually has rather than guessing from its ISO, so a clean daylight frame is barely touched and a dusk one gets what it needs. Set on the cautious side: past about 1.5 it starts smoothing real texture, and a little grain looks better than that does."
        />
        <NumberSetting
          field="raw_denoise_chroma"
          label="Colour noise reduction (1 is normal, 0 is off)"
          hint="Removes the blotchy colour speckle, following the brightness detail so a red wall does not bleed onto what is beside it. Safe to raise further than the grain setting: colour blotches are never something a photo wanted."
        />
        <NumberSetting
          field="raw_defringe"
          label="Colour fringe removal (1 is normal, 0 is off)"
          hint="Takes the purple or green rim off a hard edge. That rim is the lens focusing red, green and blue at slightly different distances, which no amount of aligning the colours can fix. How much each photo needs is measured from the photo itself, so this is a limit rather than an amount: a shot whose colours are all in focus is left alone whatever it is set to."
        />
        <NumberSetting
          field="raw_sharpen"
          label="Sharpening (0 is off, 1 is full)"
          hint="Undoes the softening the resize introduces, by reversing it rather than by adding contrast at edges; so it does not leave the bright outline that sharpening usually does. 1 is as far as it goes."
        />
      </div>

      <GroupTitle>Rendition size and quality</GroupTitle>
      <div className="panel">
        <NumberSetting field="grid_rendition_size" label="Grid tile, longest edge (px)" />
        <NumberSetting field="grid_rendition_quantizer" label="Grid tile quantizer (0-63, lower is better)" />
        <NumberSetting field="full_rendition_size" label="Viewer rendition, longest edge (px)" />
        <NumberSetting
          field="full_rendition_quantizer"
          label="Viewer rendition quality (0-63, lower is better)"
          hint="This is the rendition you spend the most time looking at. Above about 30 the shadows visibly lose detail."
        />
        <NumberSetting
          field="lossless_sdr_quantizer"
          label="Full-resolution quality (0-63, lower is better)"
          hint="Quality of the native-resolution rendition, which exists to be inspected at 100 percent."
        />
        <NumberSetting
          field="lossless_quantizer"
          label="Full-resolution HDR quality (0-63)"
          hint="The same rendition in libraries that build HDR. Lower numbers are better quality."
          disabledReason={hdrOff}
        />
        <ToggleSetting
          field="sdr_full_chroma"
          label="Full colour resolution"
          hint="Keeps colour at full resolution instead of quarter resolution. It costs roughly twice the encoding time and three times the file size for detail that only shows on saturated edges at 100 percent - on the grid tile it is not visible at all. There is a separate switch for HDR under HDR encoding."
        />
      </div>

      <GroupTitle>HDR brightness</GroupTitle>
      <div className="panel">
        <NumberSetting
          field="hdr_reference_white_nits"
          label="Reference white (nits)"
          hint="How bright plain white is rendered. This and the quantile below are the pair to reach for when a library comes out consistently dark or too hot."
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_white_quantile"
          label="Plain-white quantile (0-1)"
          hint="Which part of the histogram is taken to be plain white. Lower values render brighter, because they place white further down and everything above it scales up."
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_peak_nits"
          label="Peak brightness (nits)"
          hint="The display brightness the roll-off aims at, and what the file declares it was graded on. It sets how much headroom sits above plain white."
          disabledReason={hdrOff}
        />
      </div>

      <GroupTitle>HDR encoding</GroupTitle>
      <div className="panel">
        <NumberSetting
          field="hdr_crf"
          label="HDR quality (0-63)"
          hint="Quality of both the HDR image and the video copy built for Firefox. Lower numbers are better quality and larger files."
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_preset"
          label="HDR encoder speed (0-10)"
          hint="Also applies to both. Higher numbers encode faster for a larger file at the same quality."
          disabledReason={hdrOff}
        />
        <ToggleSetting
          field="hdr_still_full_chroma"
          label="Full colour resolution"
          hint="Keeps colour at full resolution in the HDR image instead of quarter resolution. Sharper on saturated edges, and a better picture for the file size - but it roughly doubles the memory each worker needs while encoding, and Firefox shows these photos washed out rather than in HDR."
          disabledReason={hdrOff}
        />
      </div>

      <GroupTitle>Maintenance</GroupTitle>
      <div className="panel">
        <NumberSetting
          field="watch_debounce_ms"
          label="Change debounce (seconds)"
          scale={1000}
          hint="How long changes on disk are collected before a sync starts, so copying a hundred files causes one sync rather than a hundred."
        />
        <NumberSetting
          field="prune_every_days"
          label="Orphan sweep every (days)"
          hint="Deletes generated files whose photo no longer exists. 0 turns it off, and it only has work to do after a library is removed or a catalogue is rebuilt."
        />
      </div>

      <GroupTitle>Server</GroupTitle>
      <div className="panel">
        <SettingRow
          label="Log level"
          hint="debug adds a line for every request and every finished processing stage."
          onReset={
            store.settings.log_level === DEFAULT_SETTINGS.log_level
              ? undefined
              : () => void write({ log_level: DEFAULT_SETTINGS.log_level })
          }
        >
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
          hint="Which origins may call the API, comma-separated, or * for any. Empty allows any port on the host the request arrived at, which covers this machine and the local network."
        />
        <Text variant="mono" as="p">
          The listen address and the database file are read before the catalogue can be opened, so they stay in the environment as
          HOST, PORT and DB_PATH.
        </Text>
      </div>
    </details>
  );
});

export const SettingsPage = observer(function SettingsPage(): JSX.Element {
  const store = useLibrariesStore();
  const { libraries, appSettings } = usePresenters();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void libraries.load();
    void appSettings.load();
  }, [libraries, appSettings]);

  return (
    <div className="pad">
      <Heading>Settings</Heading>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={libraries.clearError}>Dismiss</Button>
        </div>
      )}

      <div className="row page__head">
        <Text variant="label" as="div" className="panel__title">
          Libraries
        </Text>
        <span className="spacer" />
        <Button variant="primary" onClick={() => setAdding(true)}>
          <FolderPlus size={ICON} />
          Add library
        </Button>
      </div>
      <AddLibraryDialog open={adding} onOpenChange={setAdding} />

      {store.isEmpty ? (
        <div className="empty">
          <div className="empty__title">No libraries yet</div>
          <Text as="p" variant="muted">
            Point Bowerbird at a folder of RAW files to start cataloguing.
          </Text>
        </div>
      ) : (
        <LibraryList />
      )}

      <GroupTitle>Viewing</GroupTitle>
      <ViewingSettings />

      <AppSettings />
    </div>
  );
});
