import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import { type BackupStatus, type FetchBackProgress } from '../../../../src/schemas/backup';
import { type Library } from '../../../../src/schemas/libraries';
import { canRevealFile } from '../../api/transport';
import { useBackupStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Panel } from '../../ui/panel';
import { ProgressBar } from '../../ui/progress_bar';
import { Row, Spacer } from '../../ui/row';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { SettingRow, settingStyles } from '../settings/settings_controls';
import { SettingsStrings } from '../settings/settings_page.strings';
import { BackupStrings } from './backup_panel.strings';

const styles = stylex.create({
  progress: {
    display: 'grid',
    gap: '6px',
  },
});

// What a drive says it holds, not what the filesystem counts: a reader comparing this with their
// disk is reading a label that says 2TB.
const GB = 1_000_000_000;

const inGb = (bytes: number): string => (bytes / GB).toFixed(1);

// Where this library's originals are copied to, and how much of them this device keeps (§14).
export const BackupPanel = observer(function BackupPanel({ library }: { library: Library }): JSX.Element {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const [choosing, setChoosing] = useState(false);
  const status = store.statusOf(library.id);

  return (
    <Panel title={BackupStrings.heading()}>
      {status == null ?
        <>
          <Text variant="muted" as="p">
            {BackupStrings.noFolder()}
          </Text>
          <Row>
            <Button onClick={() => setChoosing(true)}>
              <HardDrive size={ICON} />
              {BackupStrings.chooseFolder()}
            </Button>
          </Row>
        </>
      : <ConfiguredBackup library={library} status={status} />}

      <ChooseFolderDialog
        open={choosing}
        onOpenChange={setChoosing}
        onChoose={async (path) => {
          if (await backup.setFolder(library.id, path)) setChoosing(false);
        }}
      />
    </Panel>
  );
});

const ConfiguredBackup = observer(function ConfiguredBackup({
  library,
  status,
}: {
  library: Library;
  status: BackupStatus;
}): JSX.Element {
  const { backup } = usePresenters();
  const [limit, setLimit] = useState('');
  const [stopping, setStopping] = useState(false);

  // The field is a draft of the server's answer, so a pass that culls - and so changes nothing
  // about the limit - must not overwrite what is half typed into it.
  useEffect(() => {
    setLimit(status.local_budget_bytes == null ? '' : inGb(status.local_budget_bytes));
  }, [status.local_budget_bytes]);

  function commitLimit(): void {
    const asked = limit.trim();
    const bytes = asked === '' ? null : Math.round(Number(asked) * GB);
    if (bytes != null && !Number.isFinite(bytes)) return;
    if (bytes === status.local_budget_bytes) return;
    void backup.setBudget(library.id, bytes == null || bytes <= 0 ? null : bytes);
  }

  return (
    <>
      <Row>
        <Text variant="mono">{status.path}</Text>
        <Spacer />
        {canRevealFile() && (
          <Button variant="ghost" onClick={() => void backup.openFolder(status.path)}>
            <FolderOpen size={ICON} />
            {SettingsStrings.openFolder()}
          </Button>
        )}
      </Row>
      {!status.available ?
        <ErrorBanner>{BackupStrings.unavailable()}</ErrorBanner>
        // What stopped the last pass, where the folder itself is fine: a name on the drive taken by
        // something else, a file that would not copy. Nothing else revisits it, so a backup that has
        // quietly stopped working is the failure worth showing (§8.6).
      : status.last_error != null && <ErrorBanner>{status.last_error}</ErrorBanner>}
      <Text variant="muted" as="p">
        {BackupStrings.summary({
          backedUp: status.backed_up,
          owed: status.owed,
          used: inGb(status.local_bytes),
          limit: status.local_budget_bytes == null ? null : inGb(status.local_budget_bytes),
          offloaded: status.offloaded,
        })}
      </Text>

      <SettingRow
        label={BackupStrings.storageLimit()}
        hint={BackupStrings.storageLimitHint()}
        disabledReason={library.read_only ? BackupStrings.storageLimitReadOnly() : undefined}
      >
        <TextField
          style={settingStyles.field}
          type="number"
          min={1}
          step={1}
          label={BackupStrings.storageLimit()}
          suffix={BackupStrings.gigabytes()}
          value={limit}
          disabled={library.read_only}
          onChange={setLimit}
          onBlur={commitLimit}
          onKeyDown={(event) => event.key === 'Enter' && commitLimit()}
        />
      </SettingRow>

      <Row>
        <Spacer />
        <Button variant="danger" onClick={() => setStopping(true)}>
          {BackupStrings.stop()}
        </Button>
      </Row>
      <StopBackupDialog library={library} status={status} open={stopping} onOpenChange={setStopping} />
    </>
  );
});

const StopBackupDialog = observer(function StopBackupDialog({
  library,
  status,
  open,
  onOpenChange,
}: {
  library: Library;
  status: BackupStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const fetching = store.fetchingBack === library.id;

  async function stop(fetchFirst: boolean): Promise<void> {
    await backup.remove(library.id, fetchFirst);
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={(next) => !fetching && onOpenChange(next)} title={BackupStrings.stopTitle(status.name)}>
      <DialogBody>
        <Text as="p">
          {status.offloaded > 0 ? BackupStrings.stopStrandsPhotos(status.offloaded) : BackupStrings.stopKeepsFiles()}
        </Text>
        {fetching && <FetchBackProgressView progress={store.fetchBackProgress} />}
        <DialogActions>
          <Button disabled={fetching} onClick={() => onOpenChange(false)}>
            {ModalStrings.cancel()}
          </Button>
          {status.offloaded > 0 ?
            <>
              <Button variant="danger" disabled={fetching} onClick={() => void stop(false)}>
                {BackupStrings.stopWithoutFetching()}
              </Button>
              <Button variant="primary" disabled={fetching} aria-busy={fetching} onClick={() => void stop(true)}>
                {fetching ? BackupStrings.fetching() : BackupStrings.fetchAndStop()}
              </Button>
            </>
          : <Button variant="danger" onClick={() => void stop(false)}>
              {BackupStrings.stop()}
            </Button>
          }
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});

function FetchBackProgressView({ progress }: { progress: FetchBackProgress | null }): JSX.Element {
  const current = progress?.current ?? null;
  const currentShare =
    current?.bytes_total == null || current.bytes_total === 0 ? 0 : current.bytes_done / current.bytes_total;
  return (
    <div {...stylex.props(styles.progress)}>
      <Row>
        <Spinner small />
        <Text as="span">
          {progress == null ? BackupStrings.preparingFetch() : BackupStrings.fetchedOf(progress.done, progress.total)}
        </Text>
      </Row>
      {progress != null && (
        <ProgressBar
          label={BackupStrings.fetchedOf(progress.done, progress.total)}
          value={progress.done + currentShare}
          max={Math.max(progress.total, 1)}
        />
      )}
      {current != null && (
        <Text variant="mono" as="p">
          {BackupStrings.fetchingFile(current.path, Math.round(currentShare * 100))}
        </Text>
      )}
    </div>
  );
}

function ChooseFolderDialog({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (path: string) => Promise<void>;
}): JSX.Element {
  const [browser, setBrowser] = useState(newBrowser);
  const [path, setPath] = useState('');

  useEffect(() => {
    if (!open) return;
    const next = newBrowser();
    setBrowser(next);
    setPath('');
    void next.presenter.open('/');
  }, [open]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={BackupStrings.folderLabel()}>
      <DialogBody height="capped">
        <Field>
          <Text variant="label" as="span">
            {BackupStrings.folderLabel()}
          </Text>
          <FolderBrowser
            store={browser.store}
            presenter={browser.presenter}
            label={AddLibraryStrings.libraryRootPath()}
            placeholder={BackupStrings.folderPlaceholder()}
            canCreate
            onPathChange={setPath}
          />
        </Field>
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{ModalStrings.cancel()}</Button>
          <Button variant="primary" disabled={path.trim() === ''} onClick={() => void onChoose(path.trim())}>
            {BackupStrings.chooseFolder()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
}

function newBrowser(): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store) };
}
