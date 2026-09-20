import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { type BrowsedRemote, type RemoteLibrary } from '../../../../src/schemas/replication';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { Row } from '../../ui/row';
import { ModalStrings } from '../../ui/modal.strings';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { AddReplicaStrings } from './add_replica_dialog.strings';
import { SyncedDevicesStrings } from './synced_devices_panel.strings';

function newBrowser(): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store) };
}

const SKEW_WORTH_MENTIONING_MS = 5 * 60 * 1000;

type Step = 'address' | 'pick' | 'where';

// Joining a library that already exists somewhere else (§9.1). Asking a peer what
// it has records nothing on either side, so the first two steps are free and a
// reader who changes their mind leaves no trace. Pairing happens at the end,
// together with the clone.
export const AddReplicaDialog = observer(function AddReplicaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useReplicationStore();
  const { replication } = usePresenters();
  const [browser, setBrowser] = useState(newBrowser);
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [remote, setRemote] = useState<BrowsedRemote | null>(null);
  const [picked, setPicked] = useState<RemoteLibrary | null>(null);
  const [path, setPath] = useState('');
  const [keepOriginals, setKeepOriginals] = useState(true);
  const [busy, setBusy] = useState(false);

  // This dialog is always mounted and only toggled open, so nothing here unmounts
  // and a request started before a close is still in flight after the next open.
  // Which open a result belongs to is the only thing that can tell them apart.
  const opening = useRef(0);

  useEffect(() => {
    if (!open) return;
    opening.current++;
    replication.clearError();
    setStep('address');
    setRemote(null);
    setPicked(null);
    setKeepOriginals(true);
    setBusy(false);
    const next = newBrowser();
    setBrowser(next);
    void next.presenter.open('/');
  }, [open, replication]);

  const root = path.trim();

  async function connect(): Promise<void> {
    const mine = opening.current;
    setBusy(true);
    const browsed = await replication.browse(address.trim());
    if (mine !== opening.current) return;
    setBusy(false);
    if (browsed == null) return;
    setRemote(browsed);
    setStep('pick');
  }

  async function add(): Promise<void> {
    if (picked == null) return;
    const mine = opening.current;
    setBusy(true);
    const done = await replication.addReplica(address.trim(), picked.id, root, keepOriginals);
    if (mine !== opening.current) return;
    setBusy(false);
    if (done) onOpenChange(false);
  }

  function close(): void {
    replication.clearError();
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())} title={AddReplicaStrings.title()}>
      <DialogBody height="capped">
        {step === 'address' && (
          <>
            <Field>
              <Text variant="label" as="span">
                {AddReplicaStrings.otherDevice()}
              </Text>
              <TextField
                grow
                label={AddReplicaStrings.deviceAddress()}
                value={address}
                placeholder={AddReplicaStrings.deviceAddressPlaceholder()}
                onChange={setAddress}
              />
              <Text variant="mono" as="p">
                {AddReplicaStrings.addressHint()}
              </Text>
            </Field>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button onClick={close}>{ModalStrings.cancel()}</Button>
              <Button variant="primary" disabled={address.trim() === '' || busy} onClick={() => void connect()}>
                {busy ? AddReplicaStrings.connecting() : AddReplicaStrings.next()}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'pick' && remote != null && (
          <>
            <Field>
              <Text variant="label" as="span">
                {AddReplicaStrings.librariesOn(remote.name)}
              </Text>
              {remote.clock_skew_ms > SKEW_WORTH_MENTIONING_MS && (
                <Text variant="mono" as="p">
                  {AddReplicaStrings.clockSkew(Math.round(remote.clock_skew_ms / 60000))}
                </Text>
              )}
              {remote.libraries.length === 0 && <Text as="p">{AddReplicaStrings.noLibraries()}</Text>}
              {remote.libraries.map((candidate) => (
                <Row as="label" key={candidate.id}>
                  <input
                    {...stylex.props(focusRing.ring)}
                    type="radio"
                    name="remote-library"
                    aria-label={candidate.name}
                    // A read-only library is not replicated at all (§1), so it is
                    // shown and refused rather than quietly missing from the list.
                    disabled={candidate.read_only}
                    checked={picked?.id === candidate.id}
                    onChange={() => setPicked(candidate)}
                  />
                  <Text as="span">{candidate.name}</Text>
                  <Text variant="muted" as="span">
                    {AddReplicaStrings.photoCount(candidate.photo_count.toLocaleString(), candidate.photo_count === 1)}
                    {candidate.read_only && AddReplicaStrings.readOnly()}
                    {candidate.replicating && !candidate.read_only && AddReplicaStrings.alreadySynced()}
                  </Text>
                </Row>
              ))}
            </Field>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button onClick={() => setStep('address')}>{AddReplicaStrings.back()}</Button>
              <Button variant="primary" disabled={picked == null} onClick={() => setStep('where')}>
                {AddReplicaStrings.next()}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'where' && picked != null && (
          <>
            <Field>
              <Text variant="label" as="span">
                {AddReplicaStrings.folderOnThisDevice()}
              </Text>
              <FolderBrowser
                store={browser.store}
                presenter={browser.presenter}
                label={AddLibraryStrings.libraryRootPath()}
                placeholder={AddReplicaStrings.rootPlaceholder()}
                onPathChange={setPath}
              />
              <Text variant="mono" as="p">
                {AddReplicaStrings.folderHint()}
              </Text>
            </Field>

            <Field>
              <Text variant="label" as="span">
                {AddReplicaStrings.originals()}
              </Text>
              <Row as="label">
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  aria-label={SyncedDevicesStrings.keepOriginalsOnThisDevice()}
                  checked={keepOriginals}
                  onChange={(e) => setKeepOriginals(e.currentTarget.checked)}
                />
                <Text as="span">{SyncedDevicesStrings.keepOriginalsOnThisDevice()}</Text>
              </Row>
              <Text variant="mono" as="p">
                {keepOriginals ? SyncedDevicesStrings.keepsOriginals() : SyncedDevicesStrings.catalogueOnly()}
              </Text>
            </Field>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button onClick={() => setStep('pick')}>{AddReplicaStrings.back()}</Button>
              <Button variant="primary" disabled={root === '' || busy} onClick={() => void add()}>
                {busy ? AddReplicaStrings.settingUp() : AddReplicaStrings.add(picked.name)}
              </Button>
            </DialogActions>
          </>
        )}
      </DialogBody>
    </Modal>
  );
});
