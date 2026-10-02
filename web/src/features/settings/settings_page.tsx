import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  FolderOpen,
  FolderPlus,
  Link2,
  RefreshCw,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import { PathSegment, route } from '../../../../src/schemas/route';
import { type Settings, type ViewerRenditionMode } from '../../../../src/schemas/settings';
import { appDataDir, openAppDataDir, shellInvoke } from '../../api/transport';
import {
  useAppSettingsStore,
  useDeviceSettingsStore,
  useLibrariesStore,
  usePresenters,
  useReplicationStore,
  useUpdatesStore,
} from '../../app/stores_context';
import { isThinShell } from '../../app/thin_shell';
import { DiagnosticsDialog } from '../feedback/diagnostics_dialog';
import { DiagnosticsStrings } from '../feedback/diagnostics_dialog.strings';
import { AddLibraryDialog } from '../libraries/add_library_dialog';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { LogsDialog } from '../logs/logs_dialog';
import { LogsDialogStrings } from '../logs/logs_dialog.strings';
import { renditionLabel } from '../photos/renditions';
import { AddReplicaDialog } from '../replication/add_replica_dialog';
import { AddReplicaStrings } from '../replication/add_replica_dialog.strings';
import { ToastsStrings } from '../toasts/toasts.strings';
import { UpdatesStrings } from '../updates/updates.strings';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { EmptyState } from '../../ui/empty_state';
import { ErrorBanner } from '../../ui/error_banner';
import { fileSizeLabel, relativeTime } from '../../ui/format';
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
  SettingsColumns,
  settingStyles,
  TextSetting,
  ToggleSetting,
  resetTo,
  useSettingWriter,
} from './settings_controls';
import { SettingsStrings } from './settings_page.strings';
import { DEFAULT_DISPLAY_PEAK_NITS } from './device_settings_store';

const styles = stylex.create({
  page: {
    maxWidth: '1280px',
  },
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

const GeneralTab = observer(function GeneralTab(): JSX.Element {
  const settings = useAppSettingsStore();
  const { appSettings } = usePresenters();
  // The scale is this device's, so it does not wait on the server's settings.
  if (settings.settings == null) return <SettingsColumns left={<ThisApp />} right={null} />;

  // Global rather than per library: it is about how you look at photos, not about
  // what a catalogue holds, and the renditions are interchangeable views of the
  // same frame (§10.2). Server-side rather than in this browser, because the same
  // catalogue gets opened from a phone and a desktop and "where I left off" is
  // worth nothing if it only holds on one of them.
  const mode = settings.viewerRenditionMode;

  return (
    <SettingsColumns
      left={
        <>
          <ThisApp />
          <GroupTitle>{SettingsStrings.groupPhotoViewer()}</GroupTitle>
          <Panel flush>
            <SettingRow
              label={SettingsStrings.defaultRendition()}
              onReset={resetTo(
                mode,
                settings.defaults?.viewer_rendition_mode,
                (v) => void appSettings.setViewerRenditionMode(v),
              )}
            >
              <Select
                label={SettingsStrings.defaultRendition()}
                options={RENDITION_MODES}
                value={mode}
                onChange={(next) => void appSettings.setViewerRenditionMode(next)}
              />
            </SettingRow>
            <ToggleSetting
              field="hide_sidebar_in_viewer"
              label={SettingsStrings.hideSidebarInViewer()}
            />
            <DisplayPeak />
          </Panel>

          <GroupTitle>{SettingsStrings.groupFrameTv()}</GroupTitle>
          <Panel flush>
            <ToggleSetting
              field="frame_tv_enabled"
              label={SettingsStrings.frameTvEnabled()}
              hint={SettingsStrings.frameTvEnabledHint()}
            />
          </Panel>
        </>
      }
      right={
        !isThinShell() && (
          <>
            <GroupTitle>{SettingsStrings.groupWatching()}</GroupTitle>
            <Panel flush>
              <ToggleSetting field="watch_enabled" label={SettingsStrings.watchEnabled()} />
              <NumberSetting
                field="watch_debounce_ms"
                label={SettingsStrings.watchDebounce()}
                suffix="s"
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
              <NumberSetting
                field="scan_concurrency"
                label={SettingsStrings.scanConcurrency()}
                min={1}
              />
            </Panel>

            <GroupTitle>{SettingsStrings.groupSchedule()}</GroupTitle>
            <Panel flush>
              <TextSetting
                field="full_sync_at"
                label={SettingsStrings.dailyFullScanAt()}
                placeholder={SettingsStrings.dailyFullScanAtPlaceholder()}
                hint={SettingsStrings.dailyFullScanAtHint()}
              />
            </Panel>
          </>
        )
      }
    />
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

// Committed on blur or Enter, like every other number here: "1" on the way to "1600" is a
// brightness the viewer would redraw at.
const DisplayPeak = observer(function DisplayPeak(): JSX.Element {
  const device = useDeviceSettingsStore();
  const { deviceSettings } = usePresenters();
  const label = SettingsStrings.displayPeakNits();
  const [draft, setDraft] = useState(String(device.displayPeakNits));
  useEffect(() => setDraft(String(device.displayPeakNits)), [device.displayPeakNits]);
  const commit = (): void => {
    deviceSettings.setDisplayPeakNits(Number(draft));
    setDraft(String(device.displayPeakNits));
  };
  return (
    <SettingRow
      label={label}
      hint={SettingsStrings.displayPeakNitsHint()}
      onReset={resetTo(
        device.displayPeakNits,
        DEFAULT_DISPLAY_PEAK_NITS,
        deviceSettings.setDisplayPeakNits,
      )}
    >
      <TextField
        style={settingStyles.field}
        type="number"
        min={1}
        label={label}
        suffix="nits"
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </SettingRow>
  );
});

const AdvancedTab = observer(function AdvancedTab(): JSX.Element | null {
  const store = useAppSettingsStore();
  const libraries = useLibrariesStore();
  if (store.settings == null) return null;

  // Every HDR setting below is read while building an HDR rendition, so with no
  // library asking for one there is nothing for them to change.
  const noHdr = libraries.libraries.every((library) => !library.rendition_hdr);
  const hdrOff = noHdr ? SettingsStrings.hdrOff() : undefined;

  return (
    <SettingsColumns
      left={
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
          </Panel>

          <GroupTitle>{SettingsStrings.groupWorkers()}</GroupTitle>
          <Panel flush>
            <NumberSetting
              field="processing_concurrency"
              label={SettingsStrings.processingConcurrency()}
              hint={SettingsStrings.processingConcurrencyHint()}
              min={1}
            />
          </Panel>
        </>
      }
      right={
        <>
          <GroupTitle>{SettingsStrings.groupResolution()}</GroupTitle>
          <Panel flush>
            <NumberSetting
              field="grid_rendition_size"
              label={SettingsStrings.gridRenditionSize()}
              suffix="px"
              min={1}
            />
            <NumberSetting
              field="full_rendition_size"
              label={SettingsStrings.fullRenditionSize()}
              suffix="px"
              min={1}
            />
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
            <NumberSetting
              field="grid_rendition_quality"
              label={SettingsStrings.gridRenditionQuality()}
              hint={SettingsStrings.qualityRange()}
              min={0}
              max={100}
            />
            <NumberSetting
              field="full_rendition_quality"
              label={SettingsStrings.fullRenditionQuality()}
              hint={SettingsStrings.qualityRange()}
              min={0}
              max={100}
            />
            <NumberSetting
              field="max_rendition_quality"
              label={SettingsStrings.maxRenditionQuality()}
              hint={SettingsStrings.qualityRange()}
              min={0}
              max={100}
            />
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
              field="avif_speed"
              label={SettingsStrings.avifSpeed()}
              hint={SettingsStrings.avifSpeedHint()}
              min={0}
              max={10}
            />
          </Panel>
        </>
      }
    />
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
            (status.checked_at == null
              ? UpdatesStrings.neverChecked()
              : UpdatesStrings.lastChecked(relativeTime(status.checked_at)))
          }
        >
          {available == null ? (
            <>
              <Text variant="mono">{status.current}</Text>
              <Button disabled={store.checking} onClick={() => void updates.check(true)}>
                <RefreshCw size={ICON} />
                {store.checking ? UpdatesStrings.checking() : UpdatesStrings.checkNow()}
              </Button>
            </>
          ) : (
            // The same dialog the sidebar's badge opens: what is in a release is the thing
            // worth reading before installing it, whichever way you got here.
            <Button variant="primary" onClick={updates.openDialog}>
              <Sparkles size={ICON} />
              {UpdatesStrings.updateAvailable(available.version)}
            </Button>
          )}
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

const UI_SCALES: Option<string>[] = ['0.8', '0.9', '1', '1.1', '1.25', '1.5'].map((value) => ({
  value,
  label: SettingsStrings.uiScalePercent(Math.round(Number(value) * 100)),
}));

function ThisApp(): JSX.Element | null {
  if (shellInvoke() == null) return null;
  return (
    <>
      <GroupTitle>{SettingsStrings.groupThisApp()}</GroupTitle>
      <Panel flush>
        <UiScale />
      </Panel>
    </>
  );
}

const UiScale = observer(function UiScale(): JSX.Element {
  const device = useDeviceSettingsStore();
  const { deviceSettings } = usePresenters();
  const [failure, setFailure] = useState<string | null>(null);
  const scale = String(device.uiScale);

  const choose = (next: string): void => {
    setFailure(null);
    void deviceSettings
      .setUiScale(Number(next))
      .catch(() => setFailure(SettingsStrings.couldNotSetUiScale()));
  };

  return (
    <SettingRow
      label={SettingsStrings.uiScale()}
      hint={failure ?? undefined}
      onReset={resetTo(scale, '1', choose)}
    >
      <Select
        label={SettingsStrings.uiScale()}
        options={UI_SCALES}
        value={scale}
        onChange={choose}
      />
    </SettingRow>
  );
});

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
          void openAppDataDir().catch(() =>
            setFailure(SettingsStrings.couldNotOpenAppDataFolder()),
          );
        }}
      >
        <FolderOpen size={ICON} />
        {SettingsStrings.openFolder()}
      </Button>
    </SettingRow>
  );
}

function LogsRow(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <SettingRow label={LogsDialogStrings.logs()}>
      <Button onClick={() => setOpen(true)}>
        <ScrollText size={ICON} />
        {LogsDialogStrings.showLogs()}
      </Button>
      <LogsDialog open={open} onOpenChange={setOpen} />
    </SettingRow>
  );
}

function DiagnosticsRow(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <SettingRow label={DiagnosticsStrings.diagnostics()}>
      <Button onClick={() => setOpen(true)}>
        <Activity size={ICON} />
        {DiagnosticsStrings.showDiagnostics()}
      </Button>
      <DiagnosticsDialog open={open} onOpenChange={setOpen} />
    </SettingRow>
  );
}

// Committed on blur or Enter: every keystroke would otherwise rename this device on the server.
const DeviceName = observer(function DeviceName(): JSX.Element | null {
  const store = useReplicationStore();
  const { replication } = usePresenters();
  const [draft, setDraft] = useState(store.deviceName ?? '');
  useEffect(() => void replication.loadDeviceName(), [replication]);
  useEffect(() => setDraft(store.deviceName ?? ''), [store.deviceName]);
  if (store.deviceName == null) return null;

  const commit = async (): Promise<void> => {
    await replication.setDeviceName(draft);
    setDraft(store.deviceName ?? '');
  };
  return (
    <SettingRow label={SettingsStrings.deviceName()} hint={SettingsStrings.deviceNameHint()}>
      <TextField
        style={settingStyles.field}
        label={SettingsStrings.deviceName()}
        value={draft}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

const SystemTab = observer(function SystemTab(): JSX.Element {
  const store = useAppSettingsStore();
  const { appSettings } = usePresenters();
  const write = useSettingWriter();

  useEffect(() => void appSettings.loadStorageUsage(), [appSettings]);

  const settings = store.settings;

  return (
    <SettingsColumns
      left={
        <>
          <GroupTitle>{SettingsStrings.groupThisDevice()}</GroupTitle>
          <Panel flush>
            <DeviceName />
          </Panel>
          <UpdateSettings />
          {settings != null && shellInvoke() == null && (
            <>
              <GroupTitle>{SettingsStrings.groupServer()}</GroupTitle>
              <Panel>
                <SettingRow
                  label={SettingsStrings.logLevel()}
                  onReset={resetTo(
                    settings.log_level,
                    store.defaults?.log_level,
                    (v) => void write({ log_level: v }),
                  )}
                >
                  <Select
                    label={SettingsStrings.logLevel()}
                    options={LOG_LEVELS}
                    value={settings.log_level}
                    onChange={(level) => void write({ log_level: level })}
                  />
                </SettingRow>
                <TextSetting
                  field="cors_origins"
                  label={SettingsStrings.corsOrigins()}
                  placeholder={SettingsStrings.corsOriginsPlaceholder()}
                  hint={SettingsStrings.corsOriginsHint()}
                  wide
                />
                <Text variant="mono" as="p">
                  {SettingsStrings.environmentNote()}
                </Text>
              </Panel>
            </>
          )}
        </>
      }
      right={
        <>
          <GroupTitle>{SettingsStrings.groupMaintenance()}</GroupTitle>
          <Panel flush>
            <SettingRow label={SettingsStrings.diskUsage()} hint={SettingsStrings.diskUsageHint()}>
              <output
                aria-label={SettingsStrings.diskUsage()}
                aria-busy={store.storageUsage.kind === 'loading'}
              >
                {store.storageUsage.kind === 'failed'
                  ? SettingsStrings.couldNotMeasureDiskUsage()
                  : store.storageUsage.kind === 'ready'
                    ? fileSizeLabel(store.storageUsage.bytes)
                    : SettingsStrings.calculatingDiskUsage()}
              </output>
              {store.storageUsage.kind === 'failed' && (
                <Button onClick={appSettings.loadStorageUsage}>
                  {SettingsStrings.retryDiskUsage()}
                </Button>
              )}
            </SettingRow>
            {settings != null && (
              <>
                <NumberSetting
                  field="disk_space_limit_gb"
                  label={SettingsStrings.diskSpaceLimit()}
                  hint={SettingsStrings.diskSpaceLimitHint()}
                  suffix="GB"
                  min={1}
                />
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
                  disabledReason={
                    settings.backup_every_days > 0 ? undefined : SettingsStrings.backupsOff()
                  }
                />
                <NumberSetting
                  field="export_history_limit"
                  label={SettingsStrings.exportHistoryLimit()}
                  hint={SettingsStrings.exportHistoryLimitHint()}
                  min={1}
                />
              </>
            )}
            <AppDataFolder />
            <LogsRow />
            <DiagnosticsRow />
          </Panel>
        </>
      }
    />
  );
});

type Tab = 'libraries' | 'general' | 'advanced' | 'system';

const TAB_OPTIONS: Option<Tab>[] = [
  { value: 'libraries', label: SettingsStrings.libraries() },
  { value: 'general', label: SettingsStrings.groupGeneral() },
  { value: 'advanced', label: SettingsStrings.groupAdvanced() },
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
  const { libraries, appSettings } = usePresenters();
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const navigate = useNavigate();
  const tab = tabFromPath(useParams().tab);
  const thin = isThinShell();

  useEffect(() => {
    void libraries.load();
    void appSettings.load();
  }, [libraries, appSettings]);

  return (
    <Page style={styles.page}>
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
            <Button variant={thin ? 'primary' : 'default'} onClick={() => setJoining(true)}>
              <Link2 size={ICON} />
              {AddReplicaStrings.title()}
            </Button>
            {!thin && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <FolderPlus size={ICON} />
                {AddLibraryStrings.title()}
              </Button>
            )}
          </PageHead>
          <AddLibraryDialog open={adding} onOpenChange={setAdding} />
          <AddReplicaDialog open={joining} onOpenChange={setJoining} />

          {store.isEmpty && (
            <EmptyState title={SettingsStrings.noLibrariesYet()}>
              <Text as="p" variant="muted">
                {thin ? SettingsStrings.noSyncedLibrariesHint() : SettingsStrings.noLibrariesHint()}
              </Text>
            </EmptyState>
          )}
          <LibraryList />
        </>
      )}

      {tab === 'general' && <GeneralTab />}
      {tab === 'advanced' && <AdvancedTab />}
      {tab === 'system' && <SystemTab />}
    </Page>
  );
});
