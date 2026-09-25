import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FolderOpen, FolderPlus, Link2, RefreshCw, Sparkles } from 'lucide-react';
import { PathSegment, route } from '../../../../src/schemas/route';
import { type Settings, type ViewerRenditionMode } from '../../../../src/schemas/settings';
import { appDataDir, openAppDataDir, serverOrigin, setServerOrigin } from '../../api/transport';
import {
  useAppSettingsStore,
  useDeviceSettingsStore,
  useLibrariesStore,
  usePresenters,
  useUpdatesStore,
} from '../../app/stores_context';
import { AddLibraryDialog } from '../libraries/add_library_dialog';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { renditionLabel } from '../photos/renditions';
import { AddReplicaDialog } from '../replication/add_replica_dialog';
import { AddReplicaStrings } from '../replication/add_replica_dialog.strings';
import { ToastsStrings } from '../toasts/toasts.strings';
import { UpdatesStrings } from '../updates/updates.strings';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { EmptyState } from '../../ui/empty_state';
import { ErrorBanner } from '../../ui/error_banner';
import { relativeTime } from '../../ui/format';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { Page, PageHead } from '../../ui/page';
import { Panel } from '../../ui/panel';
import { Spacer } from '../../ui/row';
import { Select } from '../../ui/select';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { LibraryList } from './library_list';
import {
  GroupTitle,
  NumberSetting,
  SettingRow,
  settingStyles,
  TextSetting,
  ToggleSetting,
  resetTo,
  useSettingWriter,
} from './settings_controls';
import { SettingsStrings } from './settings_page.strings';

const styles = stylex.create({
  tabs: {
    marginBottom: '16px',
  },
});

// The three renditions under the names the viewer gives them, then the modes
// that follow whatever was chosen there, or whatever is on disk.
const RENDITION_MODES: Option<ViewerRenditionMode>[] = [
  { value: 'embedded', label: renditionLabel('embedded') },
  { value: 'full', label: renditionLabel('full') },
  { value: 'max', label: renditionLabel('max') },
  { value: 'remember', label: SettingsStrings.renditionModeLastUsed() },
  { value: 'remember_per_photo', label: SettingsStrings.renditionModeLastUsedPerPhoto() },
  { value: 'best_available', label: SettingsStrings.renditionModeBestAvailable() },
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
    <Panel flush>
      <SettingRow
        label={SettingsStrings.defaultRendition()}
        onReset={resetTo(mode, settings.defaults?.viewer_rendition_mode, (v) =>
          void appSettings.setViewerRenditionMode(v),
        )}
      >
        <Select
          label={SettingsStrings.defaultRendition()}
          options={RENDITION_MODES}
          value={mode}
          onChange={(next) => void appSettings.setViewerRenditionMode(next)}
        />
      </SettingRow>

      <ToggleSetting field="hide_sidebar_in_viewer" label={SettingsStrings.hideSidebarInViewer()} />
      <ToggleSetting
        field="frame_tv_enabled"
        label={SettingsStrings.frameTvEnabled()}
        hint={SettingsStrings.frameTvEnabledHint()}
      />
    </Panel>
  );
});

const RenderOnThisDevice = observer(function RenderOnThisDevice(): JSX.Element {
  const device = useDeviceSettingsStore();
  const { deviceSettings } = usePresenters();
  const label = SettingsStrings.renderOnThisDevice();
  return (
    <SettingRow
      label={label}
      hint={SettingsStrings.renderOnThisDeviceHint()}
      onReset={resetTo(device.renderOnThisDevice, false, deviceSettings.setRenderOnThisDevice)}
    >
      <input
        {...stylex.props(focusRing.ring)}
        type="checkbox"
        aria-label={label}
        checked={device.renderOnThisDevice}
        onChange={(e) => deviceSettings.setRenderOnThisDevice(e.currentTarget.checked)}
      />
    </SettingRow>
  );
});

const RenderingTab = observer(function RenderingTab(): JSX.Element | null {
  const store = useAppSettingsStore();
  const libraries = useLibrariesStore();
  if (store.settings == null) return null;

  // Every HDR setting below is read while building an HDR rendition, so with no
  // library asking for one there is nothing for them to change.
  const noHdr = libraries.libraries.every((library) => !library.rendition_hdr);
  const hdrOff = noHdr ? SettingsStrings.hdrOff() : undefined;

  return (
    <>
      <GroupTitle>{SettingsStrings.groupProcessing()}</GroupTitle>
      <Panel flush>
        <RenderOnThisDevice />
        <ToggleSetting
          field="match_embedded_jpeg"
          label={SettingsStrings.matchEmbeddedJpeg()}
          hint={SettingsStrings.matchEmbeddedJpegHint()}
        />
        <NumberSetting
          field="raw_defringe"
          label={SettingsStrings.rawDefringe()}
          hint={SettingsStrings.rawDefringeHint()}
          min={0}
          max={1}
          step={0.05}
        />
      </Panel>

      <GroupTitle>{SettingsStrings.groupHdr()}</GroupTitle>
      <Panel flush>
        <NumberSetting
          field="hdr_reference_white_nits"
          label={SettingsStrings.hdrReferenceWhite()}
          suffix="nits"
          hint={SettingsStrings.hdrReferenceWhiteHint()}
          min={1}
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_white_quantile"
          label={SettingsStrings.hdrWhiteQuantile()}
          hint={SettingsStrings.hdrWhiteQuantileHint()}
          min={0}
          max={1}
          step={0.01}
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_peak_nits"
          label={SettingsStrings.hdrPeakNits()}
          suffix="nits"
          hint={SettingsStrings.hdrPeakNitsHint()}
          min={1}
          disabledReason={hdrOff}
        />
      </Panel>

      <GroupTitle>{SettingsStrings.groupResolution()}</GroupTitle>
      <Panel flush>
        <NumberSetting field="grid_rendition_size" label={SettingsStrings.gridRenditionSize()} suffix="px" min={1} />
        <NumberSetting field="full_rendition_size" label={SettingsStrings.fullRenditionSize()} suffix="px" min={1} />
        <NumberSetting
          field="panorama_full_rendition_size"
          label={SettingsStrings.panoramaFullRenditionSize()}
          suffix="px"
          hint={SettingsStrings.panoramaFullRenditionSizeHint()}
          min={1}
        />
      </Panel>

      <GroupTitle>{SettingsStrings.groupQuality()}</GroupTitle>
      <Panel flush>
        <NumberSetting field="grid_rendition_quality" label={SettingsStrings.gridRenditionQuality()} min={0} max={100} />
        <NumberSetting
          field="full_rendition_quality"
          label={SettingsStrings.fullRenditionQuality()}
          hint={SettingsStrings.fullRenditionQualityHint()}
          min={0}
          max={100}
        />
        <NumberSetting field="max_rendition_quality" label={SettingsStrings.maxRenditionQuality()} min={0} max={100} />
      </Panel>

      <GroupTitle>{SettingsStrings.groupEncoding()}</GroupTitle>
      <Panel flush>
        <ToggleSetting field="sdr_full_chroma" label={SettingsStrings.sdrFullChroma()} />
        <ToggleSetting
          field="hdr_still_full_chroma"
          label={SettingsStrings.hdrFullChroma()}
          hint={SettingsStrings.hdrFullChromaHint()}
          disabledReason={hdrOff}
        />
        <NumberSetting
          field="hdr_preset"
          label={SettingsStrings.hdrPreset()}
          hint={SettingsStrings.hdrPresetHint()}
          min={0}
          max={10}
          disabledReason={hdrOff}
        />
      </Panel>

      <GroupTitle>{SettingsStrings.groupWorkers()}</GroupTitle>
      <Panel flush>
        <NumberSetting
          field="scan_concurrency"
          label={SettingsStrings.scanConcurrency()}
          hint={SettingsStrings.scanConcurrencyHint()}
          min={1}
        />
        <NumberSetting
          field="processing_concurrency"
          label={SettingsStrings.processingConcurrency()}
          hint={SettingsStrings.processingConcurrencyHint()}
          min={1}
        />
      </Panel>
    </>
  );
});

const ScanningTab = observer(function ScanningTab(): JSX.Element | null {
  const store = useAppSettingsStore();
  if (store.settings == null) return null;

  return (
    <Panel flush>
      <ToggleSetting field="watch_enabled" label={SettingsStrings.watchEnabled()} />
      <TextSetting
        field="full_sync_at"
        label={SettingsStrings.dailyFullScanAt()}
        placeholder={SettingsStrings.dailyFullScanAtPlaceholder()}
        hint={SettingsStrings.dailyFullScanAtHint()}
      />
      <NumberSetting
        field="watch_debounce_ms"
        label={SettingsStrings.watchDebounce()}
        suffix="s"
        hint={SettingsStrings.watchDebounceHint()}
        scale={1000}
        min={0}
      />
      <NumberSetting
        field="watch_poll_interval_ms"
        label={SettingsStrings.watchPollInterval()}
        suffix="s"
        hint={SettingsStrings.watchPollIntervalHint()}
        scale={1000}
        min={1}
      />
    </Panel>
  );
});

const UpdateSettings = observer(function UpdateSettings(): JSX.Element | null {
  const store = useUpdatesStore();
  const { updates } = usePresenters();
  const status = store.status;
  if (status == null) return null;

  const available = store.available;

  return (
    <>
      <GroupTitle>{UpdatesStrings.updates()}</GroupTitle>
      <Panel flush>
        <SettingRow
          label={UpdatesStrings.version()}
          hint={
            store.failure ??
            (status.checked_at == null ?
              UpdatesStrings.neverChecked()
            : UpdatesStrings.lastChecked(relativeTime(status.checked_at)))
          }
        >
          {available == null ?
            <>
              <Text variant="mono">{status.current}</Text>
              <Button disabled={store.checking} onClick={() => void updates.check(true)}>
                <RefreshCw size={ICON} />
                {store.checking ? UpdatesStrings.checking() : UpdatesStrings.checkNow()}
              </Button>
            </>
            // The same dialog the sidebar's badge opens: what is in a release is the thing
            // worth reading before installing it, whichever way you got here.
          : <Button variant="primary" onClick={updates.openDialog}>
              <Sparkles size={ICON} />
              {UpdatesStrings.updateAvailable(available.version)}
            </Button>
          }
        </SettingRow>
      </Panel>
    </>
  );
});

const LOG_LEVELS: Option<Settings['log_level']>[] = [
  { value: 'debug', label: SettingsStrings.logLevelDebug() },
  { value: 'info', label: SettingsStrings.logLevelInfo() },
  { value: 'warn', label: SettingsStrings.logLevelWarn() },
  { value: 'error', label: SettingsStrings.logLevelError() },
];

/**
 * Which Bowerbird this app talks to. Desktop only, and nothing at all in a browser.
 *
 * It cannot live with the settings below it, because those are on the far side of it:
 * asking the server where the server is does not work. So the shell keeps it beside its
 * own config and answers for it over IPC, and a page - which already knows its origin -
 * never sees this section.
 *
 * Applied on save rather than as you type: every request in the app goes through this, and
 * re-pointing them at a half-typed hostname would empty the screen with each keystroke.
 */
const ServerAddress = observer(function ServerAddress(): JSX.Element | null {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void serverOrigin().then((origin) => {
      if (origin == null) return;
      setSaved(origin);
      setDraft(origin);
    });
  }, []);

  if (saved == null) return null;

  const apply = (): void => {
    setFailure(null);
    void setServerOrigin(draft)
      .then((settled) => {
        setSaved(settled);
        setDraft(settled);
        // A reload rather than a re-fetch: everything already on screen was read from the
        // old address, and there is no partial version of "this is a different library".
        window.location.reload();
      })
      .catch(() => setFailure(SettingsStrings.couldNotUseServerAddress()));
  };

  return (
    <>
      <GroupTitle>{SettingsStrings.groupThisApp()}</GroupTitle>
      <SettingRow
        label={SettingsStrings.serverAddress()}
        hint={failure ?? undefined}
        onReset={saved === draft ? undefined : () => setDraft(saved)}
      >
        <TextField
          inputStyle={settingStyles.input}
          label={SettingsStrings.serverAddress()}
          value={draft}
          placeholder={SettingsStrings.serverAddressPlaceholder()}
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply();
          }}
        />
        <Button variant="primary" disabled={draft === saved} onClick={apply}>
          {SettingsStrings.connect()}
        </Button>
      </SettingRow>
    </>
  );
});

// The one row here that is not a setting: backing the catalogue up, moving it, or
// clearing it out after an uninstall all start with being told where it is.
function AppDataFolder(): JSX.Element | null {
  const [path, setPath] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void appDataDir().then(setPath);
  }, []);

  if (path == null) return null;

  return (
    <SettingRow label={SettingsStrings.appDataFolder()} hint={failure ?? path}>
      <Button
        onClick={() => {
          setFailure(null);
          void openAppDataDir().catch(() => setFailure(SettingsStrings.couldNotOpenAppDataFolder()));
        }}
      >
        <FolderOpen size={ICON} />
        {SettingsStrings.openAppDataFolder()}
      </Button>
    </SettingRow>
  );
}

const SystemTab = observer(function SystemTab(): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();

  return (
    <>
      <ServerAddress />
      <UpdateSettings />

      {store.settings != null && (
        <>
          <GroupTitle>{SettingsStrings.groupMaintenance()}</GroupTitle>
          <Panel flush>
            <NumberSetting
              field="prune_every_days"
              label={SettingsStrings.pruneEveryDays()}
              suffix="days"
              hint={SettingsStrings.zeroTurnsItOff()}
              min={0}
            />
            <NumberSetting
              field="backup_every_days"
              label={SettingsStrings.backupEveryDays()}
              suffix="days"
              hint={SettingsStrings.zeroTurnsItOff()}
              min={0}
            />
            <NumberSetting
              field="backup_keep"
              label={SettingsStrings.backupKeep()}
              min={1}
              disabledReason={store.settings.backup_every_days > 0 ? undefined : SettingsStrings.backupsOff()}
            />
            <NumberSetting
              field="export_history_limit"
              label={SettingsStrings.exportHistoryLimit()}
              hint={SettingsStrings.exportHistoryLimitHint()}
              min={1}
            />
            <AppDataFolder />
          </Panel>

          <GroupTitle>{SettingsStrings.groupServer()}</GroupTitle>
          <Panel>
            <SettingRow
              label={SettingsStrings.logLevel()}
              onReset={resetTo(store.settings.log_level, store.defaults?.log_level, (v) =>
                void write({ log_level: v }),
              )}
            >
              <Select
                label={SettingsStrings.logLevel()}
                options={LOG_LEVELS}
                value={store.settings.log_level}
                onChange={(level) => void write({ log_level: level })}
              />
            </SettingRow>
            <TextSetting
              field="cors_origins"
              label={SettingsStrings.corsOrigins()}
              placeholder={SettingsStrings.corsOriginsPlaceholder()}
              hint={SettingsStrings.corsOriginsHint()}
            />
            <Text variant="mono" as="p">
              {SettingsStrings.environmentNote()}
            </Text>
          </Panel>
        </>
      )}
    </>
  );
});

type Tab = 'libraries' | 'viewing' | 'rendering' | 'scanning' | 'system';

const TAB_OPTIONS: Option<Tab>[] = [
  { value: 'libraries', label: SettingsStrings.libraries() },
  { value: 'viewing', label: SettingsStrings.groupViewing() },
  { value: 'rendering', label: SettingsStrings.groupRendering() },
  { value: 'scanning', label: SettingsStrings.groupScanning() },
  { value: 'system', label: SettingsStrings.groupSystem() },
];

// The path names the tab, so one is a link worth sending; `/settings` and a name
// nothing answers to both open the libraries.
function tabFromPath(name: string | undefined): Tab {
  const known = TAB_OPTIONS.find((option) => option.value === name);
  return known?.value ?? 'libraries';
}

export const SettingsPage = observer(function SettingsPage(): JSX.Element {
  const store = useLibrariesStore();
  const { libraries, appSettings, backup } = usePresenters();
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const navigate = useNavigate();
  const tab = tabFromPath(useParams().tab);

  useEffect(() => {
    void libraries.load();
    void appSettings.load();
    // Only here: a backup folder is read and set on this page, and every other page's answer to
    // "is this photo on the backup" is on the photograph's own row.
    void backup.load();
  }, [libraries, appSettings, backup]);

  return (
    <Page>
      <PageHead withSidebarButton>
        <Heading>{SettingsStrings.settings()}</Heading>
      </PageHead>

      <div {...stylex.props(styles.tabs)}>
        <SegmentedControl
          as="radio"
          label={SettingsStrings.settingsSections()}
          options={TAB_OPTIONS}
          value={tab}
          onChange={(next) => navigate(route(PathSegment.settings(), next))}
        />
      </div>

      {tab === 'libraries' && (
        <>
          {store.error != null && (
            <ErrorBanner>
              <span>{store.error}</span>
              <Button onClick={libraries.clearError}>{ToastsStrings.dismiss()}</Button>
            </ErrorBanner>
          )}

          <PageHead>
            <Spacer />
            <Button onClick={() => setJoining(true)}>
              <Link2 size={ICON} />
              {AddReplicaStrings.title()}
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <FolderPlus size={ICON} />
              {AddLibraryStrings.title()}
            </Button>
          </PageHead>
          <AddLibraryDialog open={adding} onOpenChange={setAdding} />
          <AddReplicaDialog open={joining} onOpenChange={setJoining} />

          {store.isEmpty ?
            <EmptyState title={SettingsStrings.noLibrariesYet()}>
              <Text as="p" variant="muted">
                {SettingsStrings.noLibrariesHint()}
              </Text>
            </EmptyState>
          : <LibraryList />}
        </>
      )}

      {tab === 'viewing' && <ViewingSettings />}
      {tab === 'rendering' && <RenderingTab />}
      {tab === 'scanning' && <ScanningTab />}
      {tab === 'system' && <SystemTab />}
    </Page>
  );
});
