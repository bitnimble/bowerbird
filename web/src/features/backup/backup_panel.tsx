import { observer } from 'mobx-react-lite';
import { useEffect, useId, useState } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { type BackupStatus } from '../../../../src/schemas/backup';
import { type Library } from '../../../../src/schemas/libraries';
import { useBackupStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { BackupStrings } from './backup_panel.strings';

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
      : <ConfiguredBackup library={library} status={status} running={store.running === library.id} />}

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
  running,
}: {
  library: Library;
  status: BackupStatus;
  running: boolean;
}): JSX.Element {
  const { backup } = usePresenters();
  const [limit, setLimit] = useState('');
  const hintId = useId();

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
      <Text variant="mono" as="p">
        {status.path}
      </Text>
      {!status.available ?
        <ErrorBanner>{BackupStrings.unavailable()}</ErrorBanner>
        // What stopped the last pass, where the folder itself is fine: a name on the drive taken by
        // something else, a file that would not copy. Nothing else revisits it, so a backup that has
        // quietly stopped working is the failure worth showing (§8.6).
      : status.last_error != null && <ErrorBanner>{status.last_error}</ErrorBanner>}
      <Text variant="muted" as="p">
        {status.owed === 0 ?
          BackupStrings.allBackedUp(status.backed_up)
        : BackupStrings.backedUp(status.backed_up, status.owed)}
      </Text>

      <Field tooltip={library.read_only ? BackupStrings.storageLimitReadOnly() : undefined}>
        <Text variant="label" as="span">
          {BackupStrings.storageLimit()}
        </Text>
        <TextField
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
          describedBy={hintId}
        />
        <Text variant="mono" as="p" id={hintId}>
          {library.read_only ? BackupStrings.storageLimitReadOnly() : BackupStrings.storageLimitHint()}
        </Text>
        <Text variant="muted" as="p">
          {status.local_budget_bytes == null ?
            BackupStrings.using(inGb(status.local_bytes))
          : BackupStrings.usingOf(inGb(status.local_bytes), inGb(status.local_budget_bytes))}
        </Text>
        {status.offloaded > 0 && (
          <Text variant="muted" as="p">
            {BackupStrings.onBackupOnly(status.offloaded)}
          </Text>
        )}
      </Field>

      <Row>
        <Button disabled={running} onClick={() => void backup.runNow(library.id)}>
          <RefreshCw size={ICON} />
          {running ? BackupStrings.backingUp() : BackupStrings.backUpNow()}
        </Button>
        <Spacer />
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(BackupStrings.stopWarning(status.name))) void backup.remove(library.id);
          }}
        >
          {BackupStrings.stop()}
        </Button>
      </Row>
    </>
  );
});

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
