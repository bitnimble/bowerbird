import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import {
  type BackupIssues,
  type BackupReport,
  type ConfiguredBackupStatus,
  type FetchBackProgress,
} from '../../../../src/schemas/backup';
import { type Library } from '../../../../src/schemas/libraries';
import { canRevealFile } from '../../api/transport';
import { useBackupStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Panel } from '../../ui/panel';
import { ProgressBar } from '../../ui/progress_bar';
import { Row, Spacer } from '../../ui/row';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { SettingRow, settingStyles } from '../settings/settings_controls';
import { SettingsStrings } from '../settings/settings_page.strings';
import { BackupStrings } from './backup_panel.strings';
import { backupPresentation } from './backup_status';
import { BackupStatusStrings } from './backup_status.strings';

const styles = stylex.create({
  progress: { display: 'grid', gap: '6px' },
  summary: { minWidth: 0, overflowWrap: 'anywhere' },
  details: { marginBlock: '8px' },
  disclosure: { cursor: 'pointer' },
  chooser: { border: 0, margin: 0, padding: 0 },
});

const GB = 1_000_000_000;
const inGb = (bytes: number): string => (bytes / GB).toFixed(1);

export const BackupPanel = observer(function BackupPanel({
  library,
}: {
  library: Library;
}): JSX.Element {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const status = store.statusOf(library.id);
  return (
    <Panel title={BackupStrings.heading()}>
      {store.readError != null && (
        <>
          <ErrorBanner>{store.readError}</ErrorBanner>
          <Button onClick={() => void backup.load()}>{BackupStatusStrings.retry()}</Button>
        </>
      )}
      {status?.configured === true ? (
        <ConfiguredBackup library={library} status={status} />
      ) : store.readError != null ? null : status == null && !store.loaded ? (
        <Text as="p">{BackupStatusStrings.loading()}</Text>
      ) : (
        <>
          <Text variant="muted" as="p">
            {BackupStrings.noFolder()}
          </Text>
          <ChooseBackupFolder
            key={library.id}
            libraryId={library.id}
            disabled={store.busy(library.id)}
          />
        </>
      )}
    </Panel>
  );
});

function ChooseBackupFolder({
  libraryId,
  disabled,
  confirm = false,
}: {
  libraryId: string;
  disabled: boolean;
  confirm?: boolean;
}): JSX.Element {
  const { backup, confirm: confirmation } = usePresenters();
  const [browser] = useState(newBrowser);
  async function choose(path: string): Promise<void> {
    if (path === '' || disabled) return;
    if (
      confirm &&
      !(await confirmation.ask({
        title: BackupStrings.confirmFolder(),
        body: BackupStrings.confirmFolderBody(path),
        action: BackupStrings.useFolder(),
      }))
    )
      return;
    await backup.setFolder(libraryId, path);
  }
  return (
    <fieldset disabled={disabled} {...stylex.props(styles.chooser)}>
      <FolderBrowser
        store={browser.store}
        presenter={browser.presenter}
        label={BackupStrings.folderLabel()}
        placeholder={BackupStrings.folderPlaceholder()}
        canCreate
        onPathChange={(path) => void choose(path)}
      />
    </fieldset>
  );
}

const ConfiguredBackup = observer(function ConfiguredBackup({
  library,
  status,
}: {
  library: Library;
  status: ConfiguredBackupStatus;
}): JSX.Element {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const [limit, setLimit] = useState('');
  const [removing, setRemoving] = useState(false);
  const view = backupPresentation(status);
  const busy = store.busy(library.id);
  const error = store.errorsByLibrary.get(library.id);
  useEffect(() => {
    setLimit(status.local_budget_bytes == null ? '' : inGb(status.local_budget_bytes));
  }, [status.local_budget_bytes]);

  function commitLimit(): void {
    if (busy || library.read_only) return;
    const asked = limit.trim();
    const bytes = asked === '' ? null : Math.round(Number(asked) * GB);
    if ((bytes != null && !Number.isFinite(bytes)) || bytes === status.local_budget_bytes) return;
    void backup.setBudget(library.id, bytes == null || bytes <= 0 ? null : bytes);
  }

  return (
    <>
      <div role="status" aria-live="polite">
        <Text as="p" tone={view.tone}>
          {view.label}
        </Text>
        {status.activity?.current != null && (
          <Text variant="mono" as="p" style={styles.summary}>
            {BackupStatusStrings.currentFile(status.activity.current)}
          </Text>
        )}
      </div>
      <Text variant="muted" as="p">
        {BackupStatusStrings.coverage(status)}
      </Text>
      <Text variant="muted" as="p">
        {BackupStatusStrings.localStorage(
          inGb(status.local_bytes),
          status.local_budget_bytes == null ? null : inGb(status.local_budget_bytes),
        )}
      </Text>
      {status.coverage.offloaded > 0 && (
        <Text variant="muted" as="p">
          {BackupStatusStrings.offloadedCoverage(status.coverage.offloaded)}
        </Text>
      )}
      {status.coverage.missing_originals > 0 && (
        <ErrorBanner>
          {BackupStatusStrings.missingOriginals(status.coverage.missing_originals)}
        </ErrorBanner>
      )}
      <Row>
        <Text variant="mono" style={styles.summary}>
          {status.path}
        </Text>
        <Spacer />
        {canRevealFile() && (
          <Button variant="ghost" onClick={() => void backup.openFolder(status.path)}>
            <FolderOpen size={ICON} />
            {SettingsStrings.openFolder()}
          </Button>
        )}
        <Button variant="danger" disabled={busy} onClick={() => setRemoving(true)}>
          <X size={ICON} />
          {BackupStrings.remove()}
        </Button>
      </Row>
      {status.access !== 'ready' && (
        <Text as="p">{BackupStatusStrings.advice(status.access, 'checking')}</Text>
      )}
      {error != null && <ErrorBanner>{error}</ErrorBanner>}
      {view.action != null && (
        <Button
          disabled={busy}
          onClick={() => void backup.runNow(library.id, view.action === 'resume')}
        >
          {BackupStatusStrings[view.action]()}
        </Button>
      )}
      <ChooseBackupFolder libraryId={library.id} disabled={busy} confirm />
      {status.issues.total > 0 && (
        <details {...stylex.props(styles.details)}>
          <summary {...stylex.props(styles.disclosure, focusRing.ring)}>
            {BackupStatusStrings.currentIssues(status.issues.total)}
          </summary>
          <Issues issues={status.issues} />
        </details>
      )}
      {status.last_backup_report != null && (
        <Report report={status.last_backup_report} title={BackupStatusStrings.lastBackup()} />
      )}
      {status.last_restore_report != null && (
        <Report report={status.last_restore_report} title={BackupStatusStrings.lastRestore()} />
      )}
      <SettingRow
        label={BackupStrings.storageLimit()}
        hint={BackupStrings.storageLimitHint()}
        disabledReason={
          library.read_only
            ? BackupStrings.storageLimitReadOnly()
            : busy
              ? BackupStrings.operationBusy()
              : undefined
        }
      >
        <TextField
          style={settingStyles.field}
          type="number"
          min={1}
          step={1}
          label={BackupStrings.storageLimit()}
          suffix={BackupStrings.gigabytes()}
          value={limit}
          disabled={library.read_only || busy}
          onChange={setLimit}
          onBlur={commitLimit}
          onKeyDown={(event) => event.key === 'Enter' && commitLimit()}
        />
      </SettingRow>
      <RemoveBackupDialog
        library={library}
        status={status}
        open={removing}
        onOpenChange={setRemoving}
      />
    </>
  );
});

function Issues({ issues }: { issues: BackupIssues }): JSX.Element {
  return (
    <>
      <ul>
        {issues.counts.map(({ code, count }) => (
          <li key={code}>{BackupStatusStrings.issueCount(code, count)}</li>
        ))}
      </ul>
      <ul>
        {issues.samples.map((issue, index) => (
          <li key={index}>
            {issue.path != null && (
              <Text variant="mono" as="p" style={styles.summary}>
                {issue.path}
              </Text>
            )}
            <Text as="p">{BackupStatusStrings.reason(issue.code)}</Text>
            <Text as="p">{BackupStatusStrings.advice(issue.code, issue.phase)}</Text>
          </li>
        ))}
      </ul>
      {issues.total > issues.samples.length && (
        <Text as="p">{BackupStatusStrings.moreIssues(issues.total - issues.samples.length)}</Text>
      )}
    </>
  );
}

function Report({ report, title }: { report: BackupReport; title: string }): JSX.Element {
  return (
    <details {...stylex.props(styles.details)}>
      <summary {...stylex.props(styles.disclosure, focusRing.ring)}>{title}</summary>
      <Text as="p">{BackupStatusStrings.reportOutcome(report.outcome)}</Text>
      {report.copied > 0 && <Text as="p">{BackupStatusStrings.backedUp(report.copied)}</Text>}
      {report.moved > 0 && <Text as="p">{BackupStatusStrings.moved(report.moved)}</Text>}
      {report.offloaded > 0 && (
        <Text as="p">{BackupStatusStrings.offloaded(report.offloaded)}</Text>
      )}
      {report.restored > 0 && <Text as="p">{BackupStatusStrings.restored(report.restored)}</Text>}
      {report.issues.total > 0 && <Issues issues={report.issues} />}
    </details>
  );
}

const RemoveBackupDialog = observer(function RemoveBackupDialog({
  library,
  status,
  open,
  onOpenChange,
}: {
  library: Library;
  status: ConfiguredBackupStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const fetching = store.fetchingBack === library.id;
  const busy = store.busy(library.id);
  const error = store.errorsByLibrary.get(library.id);
  async function remove(fetchFirst: boolean): Promise<void> {
    if (await backup.remove(library.id, fetchFirst)) onOpenChange(false);
  }
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={BackupStrings.removeTitle(status.name)}
    >
      <DialogBody>
        <Text as="p">
          {status.coverage.offloaded > 0
            ? BackupStrings.removeStrandsPhotos(status.coverage.offloaded)
            : BackupStrings.removeKeepsFiles()}
        </Text>
        {status.coverage.missing_originals > 0 && (
          <ErrorBanner>
            {BackupStrings.removeMissingOriginals(status.coverage.missing_originals)}
          </ErrorBanner>
        )}
        {error != null && <ErrorBanner>{error}</ErrorBanner>}
        {(fetching || (error != null && store.fetchBackProgress != null)) && (
          <FetchBackProgressView progress={store.fetchBackProgress} fetching={fetching} />
        )}
        {error != null && store.fetchBackProgress == null && status.last_restore_report != null && (
          <>
            <Text as="p">{BackupStatusStrings.restored(status.last_restore_report.restored)}</Text>
            {status.last_restore_report.issues.total > 0 && (
              <Text as="p" tone="error">
                {BackupStrings.restoreFailed(status.last_restore_report.issues.total)}
              </Text>
            )}
            <Report report={status.last_restore_report} title={BackupStatusStrings.lastRestore()} />
          </>
        )}
        <DialogActions>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            {ModalStrings.cancel()}
          </Button>
          {status.coverage.offloaded > 0 ? (
            <>
              <Button variant="danger" disabled={busy} onClick={() => void remove(false)}>
                {BackupStrings.removeWithoutFetching()}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={fetching}
                onClick={() => void remove(true)}
              >
                {fetching ? BackupStrings.fetching() : BackupStrings.fetchAndRemove()}
              </Button>
            </>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => void remove(false)}>
              {status.coverage.missing_originals > 0
                ? BackupStrings.removeWithoutFetching()
                : BackupStrings.remove()}
            </Button>
          )}
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});

function FetchBackProgressView({
  progress,
  fetching,
}: {
  progress: FetchBackProgress | null;
  fetching: boolean;
}): JSX.Element {
  const current = progress?.current ?? null;
  const share =
    current?.bytes_total == null || current.bytes_total === 0
      ? 0
      : current.bytes_done / current.bytes_total;
  return (
    <div {...stylex.props(styles.progress)}>
      <Row>
        {fetching && <Spinner small />}
        <Text>
          {progress == null
            ? BackupStrings.preparingFetch()
            : BackupStrings.fetchedOf(progress.done, progress.total)}
        </Text>
      </Row>
      {progress != null && (
        <>
          <ProgressBar
            label={BackupStrings.fetchedOf(progress.done, progress.total)}
            value={progress.done + share}
            max={Math.max(progress.total, 1)}
          />
          {progress.failed > 0 && (
            <Text tone="error">{BackupStrings.restoreFailed(progress.failed)}</Text>
          )}
          {progress.paused > 0 && <Text>{BackupStrings.restorePaused(progress.paused)}</Text>}
          {progress.cancelled > 0 && (
            <Text>{BackupStrings.restoreCancelled(progress.cancelled)}</Text>
          )}
        </>
      )}
      {current != null && (
        <Text variant="mono" as="p">
          {BackupStrings.fetchingFile(current.path, Math.round(share * 100))}
        </Text>
      )}
    </div>
  );
}

function newBrowser(): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store) };
}
