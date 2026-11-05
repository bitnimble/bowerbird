import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { type BrowsedRemote, type RemoteLibrary } from '../../../../src/schemas/replication';
import { useLibrariesStore, usePresenters, useReplicationStore } from '../../app/stores_context';
import { isThinShell } from '../../app/thin_shell';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { ICON } from '../../ui/icon';
import { List, listStyles } from '../../ui/list';
import { Modal } from '../../ui/modal';
import { Row } from '../../ui/row';
import { ModalStrings } from '../../ui/modal.strings';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color } from '../../ui/tokens.stylex';
import { FolderBrowser } from '../browse/folder_browser';
import { type FolderBrowserParts, newFolderBrowser } from '../browse/folder_browser_presenter';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { SidebarRowStrings } from '../sidebar/sidebar_row.strings';
import { AddReplicaStrings } from './add_replica_dialog.strings';
import { OriginalsChoice } from './originals_choice';

const styles = stylex.create({
  card: {
    width: '100%',
    borderTopWidth: 0,
    borderInlineWidth: 0,
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  toConfigure: {
    color: color.ochre,
  },
  configured: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: color.moss,
  },
});

function openBrowser(): FolderBrowserParts {
  const browser = newFolderBrowser();
  void browser.presenter.open('/');
  return browser;
}

const SKEW_WORTH_MENTIONING_MS = 5 * 60 * 1000;

type Step = 'address' | 'pick' | 'cards' | 'setup';

interface Setup {
  browser: FolderBrowserParts;
  keepsOriginals: boolean;
}

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
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [remote, setRemote] = useState<BrowsedRemote | null>(null);
  const [picked, setPicked] = useState<RemoteLibrary[]>([]);
  const [setups, setSetups] = useState(new Map<string, Setup>());
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<RemoteLibrary | null>(null);
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
    setSetups(new Map());
    setConfigured(new Set());
    setAdded(new Set());
    setEditing(null);
    setBusy(false);
  }, [open, replication]);

  const single = picked.length === 1;
  const setup = editing == null ? undefined : setups.get(editing.id);
  const canConnect = address.trim() !== '' && !busy;

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
    if (thin) {
      void add();
      return;
    }
    setSetups(
      new Map(
        picked.map((library) => [
          library.id,
          setups.get(library.id) ?? {
            browser: openBrowser(),
            keepsOriginals: !library.read_only,
          },
        ]),
      ),
    );
    setConfigured(new Set(picked.map((library) => library.id).filter((id) => configured.has(id))));
    const [only] = picked;
    if (single && only != null) {
      configure(only);
      return;
    }
    setStep('cards');
  }

  function configure(library: RemoteLibrary): void {
    replication.clearError();
    setEditing(library);
    setStep('setup');
  }

  function keepOriginals(keeps: boolean): void {
    if (editing == null || setup == null) return;
    setSetups(new Map(setups).set(editing.id, { ...setup, keepsOriginals: keeps }));
  }

  function back(): void {
    replication.clearError();
    if (step === 'setup' && !single) {
      setEditing(null);
      setStep('cards');
      return;
    }
    setStep(step === 'pick' ? 'address' : 'pick');
  }

  function save(): void {
    if (editing == null) return;
    if (single) {
      void add();
      return;
    }
    setConfigured(new Set(configured).add(editing.id));
    setEditing(null);
    setStep('cards');
  }

  async function add(): Promise<void> {
    if (remote == null) return;
    const pending = picked.filter((library) => !added.has(library.id));
    if (pending.length === 0) return;
    const mine = opening.current;
    setBusy(true);
    const rendering = librariesStore.rendering;
    const done = await replication.addReplicas(
      pending.map((library) => ({
        address: remote.address,
        library_id: library.id,
        ...(thin ? {} : { root_path: setups.get(library.id)?.browser.store.selectedPath }),
        sync_originals: setups.get(library.id)?.keepsOriginals ?? false,
        denoiser: rendering?.denoiser ?? 'galosh',
        render_skip_full: rendering?.render_skip_full ?? [],
      })),
    );
    if (mine !== opening.current) return;
    setBusy(false);
    // A clone that failed partway is still committed here, and retrying it fails `already_added`.
    const nowAdded = new Set(
      picked
        .filter((library) => done.includes(library.id) || librariesStore.byId.has(library.id))
        .map((library) => library.id),
    );
    if (nowAdded.size === picked.length) {
      onOpenChange(false);
      return;
    }
    setAdded(nowAdded);
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
      step={`${step}:${editing?.id ?? ''}`}
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
              <Button disabled={busy} onClick={back}>
                {AddReplicaStrings.back()}
              </Button>
              <Button variant="primary" disabled={picked.length === 0 || busy} onClick={choose}>
                {busy
                  ? AddReplicaStrings.settingUp()
                  : !thin
                    ? AddReplicaStrings.next()
                    : single && picked[0] != null
                      ? AddReplicaStrings.add(picked[0].name)
                      : AddReplicaStrings.finish()}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'cards' && (
          <>
            <List>
              {picked.map((library) => (
                <button
                  key={library.id}
                  type="button"
                  {...stylex.props(listStyles.row, styles.card, focusRing.ring)}
                  disabled={added.has(library.id) || busy}
                  onClick={() => configure(library)}
                >
                  <span {...stylex.props(listStyles.body)}>
                    <span {...stylex.props(styles.cardBody)}>
                      <Text as="span">{library.name}</Text>
                      {added.has(library.id) || configured.has(library.id) ? (
                        <Text variant="mono" as="span" style={styles.configured}>
                          <Check size={ICON} aria-hidden />
                          {added.has(library.id)
                            ? AddReplicaStrings.added()
                            : AddReplicaStrings.configured()}
                        </Text>
                      ) : (
                        <Text variant="mono" as="span" style={styles.toConfigure}>
                          {AddReplicaStrings.configure()}
                        </Text>
                      )}
                    </span>
                  </span>
                  {!added.has(library.id) && <ChevronRight size={ICON} aria-hidden />}
                </button>
              ))}
            </List>

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button disabled={busy || added.size > 0} onClick={back}>
                {AddReplicaStrings.back()}
              </Button>
              <Button
                variant="primary"
                disabled={busy || picked.some((library) => !configured.has(library.id))}
                onClick={() => void add()}
              >
                {busy ? AddReplicaStrings.settingUp() : AddReplicaStrings.finish()}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'setup' && editing != null && setup != null && (
          <>
            {!single && (
              <Text variant="label" as="span">
                {editing.name}
              </Text>
            )}
            <Field>
              <Text as="p">{AddReplicaStrings.chooseFolder()}</Text>
              <FolderBrowser
                key={editing.id}
                store={setup.browser.store}
                presenter={setup.browser.presenter}
                label={AddLibraryStrings.libraryRootPath()}
                placeholder={AddReplicaStrings.rootPlaceholder()}
                canCreate
              />
            </Field>

            {!editing.read_only && (
              <OriginalsChoice keeps={setup.keepsOriginals} onChange={keepOriginals} />
            )}

            {store.linkError != null && <ErrorBanner>{store.linkError}</ErrorBanner>}

            <DialogActions>
              <Button disabled={busy} onClick={back}>
                {AddReplicaStrings.back()}
              </Button>
              <Button
                variant="primary"
                disabled={busy || setup.browser.store.selectedPath === ''}
                onClick={save}
              >
                {busy
                  ? AddReplicaStrings.settingUp()
                  : single
                    ? AddReplicaStrings.add(editing.name)
                    : AddReplicaStrings.save()}
              </Button>
            </DialogActions>
          </>
        )}
      </DialogBody>
    </Modal>
  );
});
