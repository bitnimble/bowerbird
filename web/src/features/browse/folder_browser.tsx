import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CornerLeftUp, Folder, FolderPlus } from 'lucide-react';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color, size } from '../../ui/tokens.stylex';
import { FolderBrowserStrings } from './folder_browser.strings';
import { type FolderBrowserParts, newFolderBrowser } from './folder_browser_presenter';
import { type FolderBrowserStore } from './folder_browser_store';

const styles = stylex.create({
  browse: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: size.radius,
    overflow: 'hidden',
    margin: 0,
    padding: 0,
    minWidth: 0,
  },
  picker: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
  },
  selection: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  path: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  // Fixed rather than grown with the listing: the dialog's buttons below must not move as folders open.
  list: {
    height: '200px',
    overflow: 'auto',
    padding: '4px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    paddingBlock: '5px',
    paddingInline: '6px',
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    textAlign: 'left',
    cursor: 'pointer',
  },
});

interface FolderBrowserProps extends FolderBrowserParts {
  label: string;
  placeholder?: string;
  canCreate?: boolean;
  onPathChange?: (path: string) => void;
  /** Where the walk opens, over the selection. */
  start?: string;
}

export const FolderBrowser = observer(function FolderBrowser({
  store,
  presenter,
  label,
  placeholder,
  canCreate = false,
  onPathChange,
  start,
}: FolderBrowserProps): JSX.Element {
  const selection = store.selection;
  // Which store it was opened for, so a fresh store finds it shut.
  const [choosingIn, setChoosingIn] = useState<FolderBrowserStore | null>(null);

  useEffect(() => {
    onPathChange?.(selection?.path ?? '');
  }, [selection, store]);

  return (
    <div role="group" aria-label={label} aria-busy={store.loading} {...stylex.props(styles.picker)}>
      <div {...stylex.props(styles.selection)}>
        {store.selectedPath !== '' && (
          <Text variant="mono" as="p" style={styles.path}>
            {store.selectedPath}
          </Text>
        )}
        <Button disabled={store.loading} onClick={() => setChoosingIn(store)}>
          <Folder size={ICON} />
          {FolderBrowserStrings.chooseFolder()}
        </Button>
      </div>
      {store.error != null && (
        <Text variant="mono" tone="error">
          {store.error}
        </Text>
      )}
      <FolderChooser
        store={store}
        presenter={presenter}
        label={label}
        placeholder={placeholder}
        canCreate={canCreate}
        start={start}
        open={choosingIn === store}
        onClose={() => setChoosingIn(null)}
      />
    </div>
  );
});

/**
 * Asks for a folder as soon as it is open: the native picker where there is one, otherwise the tree
 * in a dialog. `onClose` fires with the answer already in `store`, which keeps its selection when
 * the reader backs out.
 */
export const FolderChooser = observer(function FolderChooser({
  store,
  presenter,
  label,
  placeholder,
  canCreate = false,
  start,
  open,
  onClose,
}: Omit<FolderBrowserProps, 'onPathChange'> & {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [browser, setBrowser] = useState(newFolderBrowser);
  const [confirming, setConfirming] = useState(false);
  const [path, setPath] = useState('');
  const opening = useRef(0);

  // Layout: a later effect would paint the previous walk in the reopened tree for a frame.
  useLayoutEffect(() => {
    if (!open) return;
    if (presenter.native) {
      let current = true;
      void presenter.pick().then(() => {
        if (current) onClose();
      });
      return () => {
        current = false;
      };
    }
    const next = newFolderBrowser();
    setBrowser(next);
    setPath('');
    setConfirming(false);
    void next.presenter.open(start ?? (store.selectedPath || store.listing?.path));
    return () => {
      opening.current++;
    };
  }, [open, store, presenter]);

  async function choose(): Promise<void> {
    const mine = opening.current;
    const root = path;
    if (root.trim() === '' || browser.store.loading || confirming) return;
    setConfirming(true);
    try {
      if (browser.store.listing?.path !== root && !(await browser.presenter.open(root))) return;
      if (mine !== opening.current) return;
      const listing = browser.store.listing;
      if (listing == null) return;
      presenter.confirm(listing);
      onClose();
    } finally {
      if (mine === opening.current) setConfirming(false);
    }
  }

  if (presenter.native) return null;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={FolderBrowserStrings.chooseFolder()}
    >
      <DialogBody height="capped">
        <FolderTree
          store={browser.store}
          presenter={browser.presenter}
          label={label}
          placeholder={placeholder}
          canCreate={canCreate}
          onPathChange={setPath}
          disabled={confirming}
        />
        <DialogActions>
          <Button onClick={onClose}>{ModalStrings.cancel()}</Button>
          <Button
            variant="primary"
            disabled={path.trim() === '' || browser.store.loading}
            onClick={() => void choose()}
          >
            {FolderBrowserStrings.chooseFolder()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});

const FolderTree = observer(function FolderTree({
  store,
  presenter,
  label,
  placeholder,
  canCreate = false,
  onPathChange,
  disabled,
}: FolderBrowserProps & {
  onPathChange: (path: string) => void;
  disabled: boolean;
}): JSX.Element {
  const listing = store.listing;
  const [draft, setDraft] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const typedTo = useRef<string | null>(null);

  async function create(): Promise<void> {
    if (naming == null) return;
    if (await presenter.createFolder(naming)) setNaming(null);
  }

  useEffect(() => {
    const landed = listing?.path ?? '';
    // A listing the typing itself asked for must not write itself back: the
    // reader is mid-path, and by the time it lands they have typed the next
    // folder's name after the slash.
    if (typedTo.current === landed) {
      typedTo.current = null;
      return;
    }
    typedTo.current = null;
    setDraft(landed);
    onPathChange(landed);
  }, [listing, store]);

  return (
    <fieldset disabled={disabled} {...stylex.props(styles.browse)}>
      <div {...stylex.props(styles.bar)}>
        <Button
          iconOnly
          aria-label={FolderBrowserStrings.goUpOneFolder()}
          disabled={listing?.parent == null}
          onClick={() => listing?.parent != null && void presenter.open(listing.parent)}
        >
          <CornerLeftUp size={ICON} />
        </Button>
        <TextField
          grow
          verbatim
          label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(next) => {
            setDraft(next);
            // Closing a folder's name with a slash walks into it, so a path
            // known in full can be typed straight through without stopping to
            // press Enter at each level. The slash is punctuation rather than
            // part of the answer, so it is not what the folder is called.
            const typed = next.trim();
            const opens = typed.length > 1 && typed.endsWith('/');
            // Every trailing slash, not one: the server resolves `/photos//`
            // to `/photos`, and a walk that lands somewhere the box did not
            // name is one that writes itself back over what is being typed.
            const asked = typed.replace(/\/+$/, '') || '/';
            onPathChange(opens ? asked : next);
            if (opens) {
              typedTo.current = asked;
              void presenter.open(asked);
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && draft.trim() !== '' && void presenter.open(draft)}
        />
        {canCreate && (
          <Button
            iconOnly
            variant={naming != null ? 'primary' : 'default'}
            aria-label={FolderBrowserStrings.createFolder()}
            aria-expanded={naming != null}
            disabled={listing == null}
            onClick={() => setNaming(naming == null ? '' : null)}
          >
            <FolderPlus size={ICON} />
          </Button>
        )}
      </div>
      {naming != null && (
        <div {...stylex.props(styles.bar)}>
          <TextField
            grow
            autoFocus
            verbatim
            label={FolderBrowserStrings.folderName()}
            value={naming}
            onChange={setNaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') {
                // The dialog around the picker closes on Escape too.
                e.stopPropagation();
                setNaming(null);
              }
            }}
          />
          <Button disabled={naming.trim() === '' || store.loading} onClick={() => void create()}>
            {FolderBrowserStrings.create()}
          </Button>
        </div>
      )}
      <div {...stylex.props(styles.list)}>
        {store.error != null && <Text variant="mono">{store.error}</Text>}
        {listing?.directories.length === 0 && (
          <Text variant="muted">{FolderBrowserStrings.noFolders()}</Text>
        )}
        {listing?.directories.map((directory) => (
          <button
            key={directory.path}
            type="button"
            {...stylex.props(styles.item, focusRing.ring)}
            onClick={() => void presenter.open(directory.path)}
          >
            <Folder size={ICON} />
            {directory.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
});
