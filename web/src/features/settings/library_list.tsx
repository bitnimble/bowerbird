import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CircleStop,
  HardDriveUpload,
  Image,
  Layers,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import { PathSegment, route } from '../../../../src/schemas/route';
import {
  useBackupStore,
  useLibrariesStore,
  usePresenters,
  useReplicationStore,
  useScanStore,
} from '../../app/stores_context';
import { libraryLabel } from '../libraries/library_label';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import { PhotoDetailStrings } from '../photos/viewer/photo_detail_page.strings';
import { RENDITION_SOURCES } from '../photos/renditions';
import { BackupPanel } from '../backup/backup_panel';
import { BackupStrings } from '../backup/backup_panel.strings';
import { SyncedDevicesPanel } from '../replication/synced_devices_panel';
import { SyncedDevicesStrings } from '../replication/synced_devices_panel.strings';
import { ScanStrip } from '../scan/scan_strip';
import { Button } from '../../ui/button';
import { DialogBody, DialogColumns } from '../../ui/dialog_layout';
import { focusRing } from '../../ui/focus_ring';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { Panel } from '../../ui/panel';
import { Row } from '../../ui/row';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color, font } from '../../ui/tokens.stylex';
import { RenderStagesPanel } from './render_stages_panel';
import { resetTo, SettingRow, settingStyles, showNumber } from './settings_controls';
import { SettingsStrings } from './settings_page.strings';

const styles = stylex.create({
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))',
    gap: '12px',
    alignItems: 'start',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '12px',
    paddingInline: '12px',
    paddingBottom: '12px',
    marginBottom: 0,
  },
  name: {
    width: '100%',
  },
  meta: {
    overflowWrap: 'anywhere',
  },
  actions: {
    justifyContent: 'flex-end',
  },
  jobs: {
    marginTop: '8px',
    marginBottom: 0,
  },
  summary: {
    cursor: 'pointer',
    fontFamily: font.display,
    fontSize: '13px',
    paddingBlock: '2px',
    color: { default: color.boneDim, ':hover': color.bone },
  },
  rules: {
    display: 'grid',
    gap: '6px',
    marginTop: '10px',
  },
  rule: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  path: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
  },
  focusTarget: {
    outline: 'none',
  },
});

// Syncing lives here, not on the gallery: it is a maintenance action on the
// library, and the gallery is for looking at photos.
export const LibraryList = observer(function LibraryList(): JSX.Element {
  const store = useLibrariesStore();

  return (
    <div {...stylex.props(styles.tiles)} role="list" aria-label={SettingsStrings.libraries()}>
      {store.libraries.map((library) => (
        <LibraryTile key={library.id} library={library} />
      ))}
    </div>
  );
});

const LibraryTile = observer(function LibraryTile({ library }: { library: Library }): JSX.Element {
  const scan = useScanStore();
  const { libraries, scan: scanPresenter, confirm } = usePresenters();
  const navigate = useNavigate();
  const params = useParams();
  const settingsOpen = params.libraryId === library.id;
  const syncSection = useRef<HTMLDivElement>(null);
  const setSettingsOpen = (open: boolean): void =>
    navigate(
      open ?
        route(PathSegment.settings(), PathSegment.libraries(), library.id)
      : route(PathSegment.settings(), PathSegment.libraries()),
      { replace: true },
    );

  return (
    <Panel role="listitem" style={styles.tile}>
      <LibraryName library={library} />
      <Text variant="mono" as="div" style={styles.meta}>
        {SettingsStrings.libraryMeta(
          library.root_path,
          library.photo_count,
          library.last_synced_at == null ?
            SettingsStrings.neverScanned()
          : SettingsStrings.scannedAt(relativeTime(library.last_synced_at)),
        )}
      </Text>
      <ScanStrip library={library} />
      <LibraryJobs library={library} />

      <Row style={styles.actions}>
        <Button onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={ICON} />
          {SettingsStrings.openLibrarySettings()}
        </Button>

        {/* The same slot, because stopping is what you want from a run in
            flight and starting another is not on offer anyway. */}
        {scan.isBusy && scan.libraryId === library.id ? (
          <Button onClick={() => void scanPresenter.cancel(library.id)}>
            <CircleStop size={ICON} />
            {SettingsStrings.stop()}
          </Button>
        ) : (
          <Button onClick={() => void scanPresenter.scanLibrary(library.id)}>
            <RefreshCw size={ICON} />
            {SettingsStrings.scanNow()}
          </Button>
        )}

        <Button
          variant="danger"
          onClick={async () => {
            const confirmed = await confirm.ask({
              title: SettingsStrings.removeLibraryQuestion(libraryLabel(library)),
              body: SettingsStrings.removeLibraryWarning(library.photo_count),
              action: SettingsStrings.remove(),
              tone: 'danger',
            });
            if (confirmed) void libraries.remove(library.id);
          }}
        >
          <Trash2 size={ICON} />
          {SettingsStrings.remove()}
        </Button>
      </Row>

      <Modal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title={SettingsStrings.librarySettingsTitle(libraryLabel(library))}
        initialFocus={params.section === PathSegment.sync() ? syncSection : undefined}
      >
        <DialogBody wide>
          <DialogColumns>
            <div>
              <FolderSettings library={library} />
              <RenditionSettings library={library} />
              <StackSettings library={library} />
              <div ref={syncSection} tabIndex={-1} {...stylex.props(styles.focusTarget)}>
                <SyncedDevicesPanel library={library} />
              </div>
            </div>
            <div>
              <RenderStagesPanel library={library} />
              <BackupPanel library={library} />
            </div>
          </DialogColumns>
        </DialogBody>
      </Modal>
    </Panel>
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
    <TextField
      style={styles.name}
      label={SettingsStrings.libraryName()}
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
});

// What the library is, as opposed to what it builds: how much of the folder tree
// belongs to it. Standing rules rather than decisions taken at import, so a
// folder made next month is in or out for the same reason today's are (§4.1).
const FolderSettings = observer(function FolderSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();
  const defaults = useLibrariesStore().defaults;
  // Held here rather than in the field, because the checkbox above sends it too.
  const [binDraft, setBinDraft] = useState(library.bin_name ?? 'Bin');
  useEffect(() => setBinDraft(library.bin_name ?? 'Bin'), [library.bin_name]);
  const hasRules = (useLibrariesStore().folderRules.get(library.id) ?? []).length > 0;

  return (
    <Panel title={SettingsStrings.folders()} flush={!hasRules}>
      <SettingRow
        label={SettingsStrings.includeSubfolders()}
        onReset={resetTo(library.include_subfolders, defaults?.include_subfolders, (v) =>
          void libraries.setIncludeSubfolders(library.id, v),
        )}
      >
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={SettingsStrings.includeSubfolders()}
          checked={library.include_subfolders}
          onChange={(e) => void libraries.setIncludeSubfolders(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      <SettingRow
        label={SettingsStrings.includeNonRaw()}
        onReset={resetTo(library.include_non_raw, defaults?.include_non_raw, (v) =>
          void libraries.setIncludeNonRaw(library.id, v),
        )}
      >
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={SettingsStrings.includeNonRaw()}
          checked={library.include_non_raw}
          onChange={(e) => void libraries.setIncludeNonRaw(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      <SettingRow
        label={SettingsStrings.readOnly()}
        hint={SettingsStrings.readOnlyHint()}
      >
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={SettingsStrings.readOnly()}
          checked={library.read_only}
          // Letting the app write again means making a bin, so the name goes with
          // the request - whatever is in the field below, which is where the
          // reader picks another when the root already holds one of that name.
          onChange={(e) => void libraries.setReadOnly(library.id, e.currentTarget.checked, binDraft.trim() || 'Bin')}
        />
      </SettingRow>

      <BinNameField library={library} draft={binDraft} onDraft={setBinDraft} />
      <FolderRuleList library={library} />
    </Panel>
  );
});

// Renaming the bin moves the folder, which is why this can exist at all: the
// setting on its own would strand every already-binned RAW in a folder the scan
// walks straight back in.
const BinNameField = observer(function BinNameField({
  library,
  draft,
  onDraft,
}: {
  library: Library;
  draft: string;
  onDraft: (value: string) => void;
}): JSX.Element {
  const { libraries } = usePresenters();

  // Editable for a library that has no bin, even while it is read-only: clearing
  // that flag has to name the folder it is about to make, and the root may
  // already hold one called `Bin` - which is refused. Left disabled, the only way
  // out of that would be to remove the library and add it again.
  const noBinYet = library.bin_name == null;
  const locked = library.read_only && !noBinYet;

  function commit(): void {
    const next = draft.trim();
    // Nothing to rename while there is no folder: the name is only a choice for
    // the checkbox above to send when it makes one.
    if (next === '' || next === library.bin_name || noBinYet) {
      if (next === '') onDraft(library.bin_name ?? 'Bin');
      return;
    }
    void libraries.setBinName(library.id, next);
  }

  return (
    <SettingRow
      label={SettingsStrings.binFolderName()}
      hint={noBinYet ? SettingsStrings.binNameHintNoBin() : SettingsStrings.binNameHint()}
      disabledReason={locked ? SettingsStrings.binNameLocked() : undefined}
    >
      <TextField
        style={settingStyles.field}
        label={SettingsStrings.binFolderName()}
        value={draft}
        disabled={locked}
        onChange={onDraft}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </SettingRow>
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
    <div {...stylex.props(styles.rules)}>
      <Text variant="label" as="div">
        {SettingsStrings.foldersSetAside()}
      </Text>
      {rules.map((rule) => (
        <div {...stylex.props(styles.rule)} key={rule.folder_path}>
          <Text variant="mono" style={styles.path}>
            {rule.folder_path}
          </Text>
          <Text variant="muted">
            {rule.rule === 'excluded' ? SettingsStrings.ruleExcluded() : SettingsStrings.ruleNotAShoot()}
          </Text>
          <Button onClick={() => void libraries.clearFolderRule(library.id, rule.folder_path)}>
            {PhotoDetailStrings.undo()}
          </Button>
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
  const defaults = useLibrariesStore().defaults;

  return (
    <Panel title={SettingsStrings.renditions()} flush>
      <SettingRow
        label={SettingsStrings.buildRenditionsFrom()}
        onReset={resetTo(library.rendition_source, defaults?.rendition_source, (v) =>
          void libraries.setRenditionSource(library.id, v),
        )}
      >
        <Select
          label={SettingsStrings.buildRenditionsFrom()}
          options={RENDITION_SOURCES}
          value={library.rendition_source}
          onChange={(source) => void libraries.setRenditionSource(library.id, source)}
        />
      </SettingRow>

      <SettingRow
        label={SettingsStrings.buildHdrRenditions()}
        hint={SettingsStrings.buildHdrRenditionsHint()}
        onReset={resetTo(library.rendition_hdr, defaults?.rendition_hdr, (v) =>
          void libraries.setRenditionHdr(library.id, v),
        )}
      >
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={SettingsStrings.buildHdrRenditions()}
          checked={library.rendition_hdr}
          onChange={(e) => void libraries.setRenditionHdr(library.id, e.currentTarget.checked)}
        />
      </SettingRow>
    </Panel>
  );
});

// Per library, because one catalogue may be burst-heavy sport where a stack is
// the unit of work and another a studio where every frame is deliberate.
const StackSettings = observer(function StackSettings({ library }: { library: Library }): JSX.Element {
  const { libraries } = usePresenters();
  const defaults = useLibrariesStore().defaults;

  return (
    <Panel title={SettingsStrings.stacks()} flush>
      <SettingRow
        label={SettingsStrings.autoStack()}
        hint={SettingsStrings.autoStackHint()}
        onReset={resetTo(library.auto_stack, defaults?.auto_stack, (v) =>
          void libraries.setAutoStack(library.id, v),
        )}
      >
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={SettingsStrings.autoStack()}
          checked={library.auto_stack}
          onChange={(e) => void libraries.setAutoStack(library.id, e.currentTarget.checked)}
        />
      </SettingRow>

      {library.auto_stack && (
        <>
          <LibraryNumberField
            libraryId={library.id}
            field="auto_stack_similarity"
            label={SettingsStrings.autoStackSimilarity()}
            min={0}
            max={1}
            step={0.01}
            onCommit={(next) => libraries.setAutoStackSimilarity(library.id, next)}
          />

          <LibraryNumberField
            libraryId={library.id}
            field="auto_stack_window_seconds"
            label={SettingsStrings.autoStackWindow()}
            suffix="s"
            hint={SettingsStrings.autoStackWindowHint()}
            min={1}
            onCommit={(next) => libraries.setAutoStackWindow(library.id, next)}
          />
        </>
      )}
    </Panel>
  );
});

// Same draft/commit shape as NumberSetting: typing "0." must not fire a write of 0
// mid-keystroke, and a refused value snaps back to whatever the library still holds.
const LibraryNumberField = observer(function LibraryNumberField({
  libraryId,
  field,
  label,
  hint,
  min,
  max,
  step,
  suffix,
  onCommit,
}: {
  libraryId: string;
  field: 'auto_stack_similarity' | 'auto_stack_window_seconds';
  label: string;
  hint?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onCommit: (next: number) => void | Promise<void>;
}): JSX.Element {
  const store = useLibrariesStore();
  const value = store.byId.get(libraryId)?.[field] ?? 0;
  const [draft, setDraft] = useState(showNumber(value, step));

  useEffect(() => setDraft(showNumber(value, step)), [value, step]);

  async function commit(): Promise<void> {
    const next = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(next) && next !== value) await onCommit(next);
    setDraft(showNumber(store.byId.get(libraryId)?.[field] ?? value, step));
  }

  return (
    <SettingRow
      label={label}
      hint={hint}
      onReset={resetTo(value, store.defaults?.[field], (v) => void onCommit(v))}
    >
      <TextField
        style={settingStyles.field}
        type="number"
        min={min}
        max={max}
        step={step}
        label={label}
        suffix={suffix}
        value={draft}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

// Stages of a scan offered on their own: scan without forcing rebuilds, or
// regenerate every tile / every viewer render. Collapsed: maintenance, not
// something you reach for every visit.
const LibraryJobs = observer(function LibraryJobs({ library }: { library: Library }): JSX.Element {
  const scan = useScanStore();
  const replication = useReplicationStore();
  const backupStore = useBackupStore();
  const { scan: scanPresenter, libraries, replication: replicationPresenter, backup } = usePresenters();
  const busy = scan.isBusy && scan.libraryId === library.id;
  const renders = library.rendition_source === 'render';
  const syncing = replication.replicating === library.id;
  const backingUp = backupStore.running === library.id;

  return (
    <details>
      <summary {...stylex.props(styles.summary, focusRing.ring)}>{SettingsStrings.libraryJobs()}</summary>
      <Panel flush style={styles.jobs}>
        {replication.hasPeers(library.id) && (
          <SettingRow
            label={SettingsStrings.syncLibrary()}
            disabledReason={
              library.read_only ? BulkBarStrings.notOnReadOnlyLibrary()
              : syncing ? SettingsStrings.jobBusy()
              : undefined
            }
          >
            <Button disabled={syncing || library.read_only} onClick={() => void replicationPresenter.replicate(library.id)}>
              <RefreshCw size={ICON} />
              {syncing ? SyncedDevicesStrings.syncing() : SettingsStrings.run()}
            </Button>
          </SettingRow>
        )}

        {backupStore.statusOf(library.id) != null && (
          <SettingRow label={SettingsStrings.backUpOriginals()} disabledReason={backingUp ? SettingsStrings.jobBusy() : undefined}>
            <Button disabled={backingUp} onClick={() => void backup.runNow(library.id)}>
              <HardDriveUpload size={ICON} />
              {backingUp ? BackupStrings.backingUp() : SettingsStrings.run()}
            </Button>
          </SettingRow>
        )}

        <SettingRow
          label={SettingsStrings.scanLibrary()}
          hint={SettingsStrings.scanLibraryHint()}
          disabledReason={busy ? SettingsStrings.jobBusy() : undefined}
        >
          <Button disabled={busy} onClick={() => void scanPresenter.scanLibrary(library.id)}>
            <RefreshCw size={ICON} />
            {SettingsStrings.run()}
          </Button>
        </SettingRow>

        <SettingRow label={SettingsStrings.rebuildThumbnails()} disabledReason={busy ? SettingsStrings.jobBusy() : undefined}>
          <Button disabled={busy} onClick={() => void scanPresenter.rebuildTiles(library.id)}>
            <Image size={ICON} />
            {SettingsStrings.run()}
          </Button>
        </SettingRow>

        <SettingRow
          label={SettingsStrings.rebuildRenditions()}
          hint={SettingsStrings.rebuildRenditionsHint()}
          disabledReason={
            busy ? SettingsStrings.jobBusy()
            : renders ? undefined
            : SettingsStrings.noRenditionsToRebuild()
          }
        >
          <Button disabled={busy || !renders} onClick={() => void scanPresenter.rebuildRenditions(library.id)}>
            <Sparkles size={ICON} />
            {SettingsStrings.run()}
          </Button>
        </SettingRow>

        <SettingRow
          label={SettingsStrings.groupSimilarPhotos()}
          hint={SettingsStrings.groupSimilarPhotosHint()}
          disabledReason={
            busy ? SettingsStrings.jobBusy()
            : library.auto_stack ? undefined
            : SettingsStrings.autoStackOff()
          }
        >
          <Button disabled={busy || !library.auto_stack} onClick={() => void libraries.detectStacks(library.id)}>
            <Layers size={ICON} />
            {SettingsStrings.run()}
          </Button>
        </SettingRow>
      </Panel>
    </details>
  );
});
