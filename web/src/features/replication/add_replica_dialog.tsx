import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { type Denoiser } from '../../../../src/schemas/photo_edits';
import { type BrowsedRemote, type RemoteLibrary } from '../../../../src/schemas/replication';
import { useLibrariesStore, usePresenters, useReplicationStore } from '../../app/stores_context';
import { isThinShell } from '../../app/thin_shell';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { Row } from '../../ui/row';
import { ModalStrings } from '../../ui/modal.strings';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser } from '../browse/folder_browser';
import { type FolderBrowserParts, newFolderBrowser } from '../browse/folder_browser_presenter';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { DENOISERS } from '../raw_edit/denoisers';
import { RawEditPanelStrings } from '../raw_edit/raw_edit_panel.strings';
import { SidebarRowStrings } from '../sidebar/sidebar_row.strings';
import { AddReplicaStrings } from './add_replica_dialog.strings';
import { SyncedDevicesStrings } from './synced_devices_panel.strings';

function openBrowser(): FolderBrowserParts {
  const browser = newFolderBrowser();
  void browser.presenter.open('/');
  return browser;
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
  const librariesStore = useLibrariesStore();
  const { replication } = usePresenters();
  // Its server picks the folder, and it fetches an original only when one is opened.
  const thin = isThinShell();
  const [browsers, setBrowsers] = useState(new Map<string, FolderBrowserParts>());
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [remote, setRemote] = useState<BrowsedRemote | null>(null);
  const [picked, setPicked] = useState<RemoteLibrary[]>([]);
  const [folderIndex, setFolderIndex] = useState(0);
  const [keepOriginals, setKeepOriginals] = useState(!thin);
  const [autoTransferOriginals, setAutoTransferOriginals] = useState(!thin);
  const [denoiser, setDenoiser] = useState<Denoiser>('galosh');
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
    setPicked([]);
    setBrowsers(new Map());
    setKeepOriginals(!thin);
    setAutoTransferOriginals(!thin);
    setDenoiser('galosh');
    setBusy(false);
  }, [open, replication, thin]);

  const library = picked.at(folderIndex);
  const browser = library && browsers.get(library.id);
  const last = thin || folderIndex === picked.length - 1;
  const canAdd =
    thin || picked.every((candidate) => browsers.get(candidate.id)?.store.selectedPath !== '');
  const canConnect = address.trim() !== '' && !busy;
  const anyWritable = picked.some((candidate) => !candidate.read_only);

  async function connect(): Promise<void> {
    if (!canConnect) return;
    const mine = opening.current;
    setBusy(true);
    const browsed = await replication.browse(address.trim());
    if (mine !== opening.current) return;
    setBusy(false);
    if (browsed == null) return;
    setRemote(browsed);
    setPicked([]);
    setStep('pick');
  }

  function toggle(candidate: RemoteLibrary, checked: boolean): void {
    if (remote == null) return;
    setPicked(
      remote.libraries.filter((other) =>
        other.id === candidate.id ? checked : picked.some((p) => p.id === other.id),
      ),
    );
  }

  function choose(): void {
    replication.clearError();
    if (!thin) {
      setBrowsers(
        new Map(
          picked.map((candidate) => [candidate.id, browsers.get(candidate.id) ?? openBrowser()]),
        ),
      );
    }
    setFolderIndex(0);
    setStep('where');
  }

  function back(): void {
    replication.clearError();
    if (step === 'where' && folderIndex > 0) {
      setFolderIndex(folderIndex - 1);
      return;
    }
    setStep(step === 'where' ? 'pick' : 'address');
  }

  function forward(): void {
    replication.clearError();
    setFolderIndex(folderIndex + 1);
  }

  async function add(): Promise<void> {
    if (picked.length === 0 || remote == null) return;
    const mine = opening.current;
    setBusy(true);
    const added = await replication.addReplicas(
      picked.map((candidate) => ({
        address: remote.address,
        library_id: candidate.id,
        ...(thin ? {} : { root_path: browsers.get(candidate.id)?.store.selectedPath }),
        sync_originals: keepOriginals && !candidate.read_only,
        auto_transfer_originals: autoTransferOriginals && !candidate.read_only,
        denoiser,
      })),
    );
    if (mine !== opening.current) return;
    setBusy(false);
    // A clone that failed partway is still committed here, and retrying it fails `already_added`.
    const remaining = picked.filter(
      (candidate) => !added.includes(candidate.id) && !librariesStore.byId.has(candidate.id),
    );
    if (remaining.length === 0) {
      onOpenChange(false);
      return;
    }
    setPicked(remaining);
    setFolderIndex(0);
  }

  function close(): void {
    replication.clearError();
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={AddReplicaStrings.title()}
      step={`${step}:${folderIndex}`}
    >
      <DialogBody height="capped">
        {step === 'address' && (
          <>
            <Field>
              <Text variant="label" as="span">
                {AddReplicaStrings.otherDevice()}
              </Text>
              <TextField
                grow
                verbatim
                label={AddReplicaStrings.deviceAddress()}
                value={address}
                placeholder={AddReplicaStrings.deviceAddressPlaceholder()}
                onChange={setAddress}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
              />
              <Text variant="mono" as="p">
                {AddReplicaStrings.addressHint()}
              </Text>
            </Field>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button onClick={close}>{ModalStrings.cancel()}</Button>
              <Button variant="primary" disabled={!canConnect} onClick={() => void connect()}>
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
              {remote.libraries.length === 0 && (
                <Text as="p">{AddReplicaStrings.noLibraries()}</Text>
              )}
              {remote.libraries.map((candidate) => (
                <Row as="label" key={candidate.id}>
                  <input
                    {...stylex.props(focusRing.ring)}
                    type="checkbox"
                    aria-label={
                      candidate.read_only
                        ? SidebarRowStrings.readOnlyName(candidate.name)
                        : candidate.name
                    }
                    disabled={librariesStore.byId.has(candidate.id)}
                    checked={picked.some((p) => p.id === candidate.id)}
                    onChange={(e) => toggle(candidate, e.currentTarget.checked)}
                  />
                  <Text as="span">{candidate.name}</Text>
                  <Text variant="muted" as="span">
                    {librariesStore.byId.has(candidate.id)
                      ? AddReplicaStrings.alreadyHere()
                      : AddReplicaStrings.photoCount(
                          candidate.photo_count.toLocaleString(),
                          candidate.photo_count === 1,
                          candidate.read_only,
                        )}
                  </Text>
                </Row>
              ))}
            </Field>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button onClick={back}>{AddReplicaStrings.back()}</Button>
              <Button variant="primary" disabled={picked.length === 0} onClick={choose}>
                {AddReplicaStrings.next()}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'where' && library != null && (
          <>
            {browser != null && (
              <Field>
                <Text variant="label" as="span">
                  {picked.length > 1
                    ? AddReplicaStrings.folderFor(library.name)
                    : AddReplicaStrings.folderOnThisDevice()}
                </Text>
                <FolderBrowser
                  key={library.id}
                  store={browser.store}
                  presenter={browser.presenter}
                  label={AddLibraryStrings.libraryRootPath()}
                  placeholder={AddReplicaStrings.rootPlaceholder()}
                  canCreate
                />
                <Text variant="mono" as="p">
                  {AddReplicaStrings.folderHint()}
                </Text>
              </Field>
            )}

            {last && (!anyWritable || !thin) && (
              <Field>
                <Text variant="label" as="span">
                  {AddReplicaStrings.originals()}
                </Text>
                {!anyWritable ? (
                  <Text variant="mono" as="p">
                    {AddReplicaStrings.readOnlyHere()}
                  </Text>
                ) : (
                  <>
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
                      {keepOriginals
                        ? SyncedDevicesStrings.keepsOriginals()
                        : SyncedDevicesStrings.catalogueOnly()}
                    </Text>
                    <Row as="label">
                      <input
                        {...stylex.props(focusRing.ring)}
                        type="checkbox"
                        aria-label={SyncedDevicesStrings.autoTransferOriginals()}
                        checked={autoTransferOriginals}
                        onChange={(e) => setAutoTransferOriginals(e.currentTarget.checked)}
                      />
                      <Text as="span">{SyncedDevicesStrings.autoTransferOriginals()}</Text>
                    </Row>
                  </>
                )}
              </Field>
            )}

            {last && (
              <Field>
                <Text variant="label" as="span">
                  {RawEditPanelStrings.denoiser()}
                </Text>
                <Select
                  label={RawEditPanelStrings.denoiser()}
                  options={DENOISERS}
                  value={denoiser}
                  onChange={setDenoiser}
                />
              </Field>
            )}

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button disabled={busy} onClick={back}>
                {AddReplicaStrings.back()}
              </Button>
              {last ? (
                <Button variant="primary" disabled={!canAdd || busy} onClick={() => void add()}>
                  {busy
                    ? AddReplicaStrings.settingUp()
                    : picked.length > 1
                      ? AddReplicaStrings.addLibraries(picked.length)
                      : AddReplicaStrings.add(library.name)}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={browser?.store.selectedPath === ''}
                  onClick={forward}
                >
                  {AddReplicaStrings.next()}
                </Button>
              )}
            </DialogActions>
          </>
        )}
      </DialogBody>
    </Modal>
  );
});
