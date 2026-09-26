import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { CornerLeftUp, Folder, FolderPlus } from 'lucide-react';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color, size } from '../../ui/tokens.stylex';
import { FolderBrowserStrings } from './folder_browser.strings';
import type { FolderBrowserPresenter } from './folder_browser_presenter';
import type { FolderBrowserStore } from './folder_browser_store';

const styles = stylex.create({
  browse: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: size.radius,
    overflow: 'hidden',
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

// Walking the server's folders: where the walk is now, one level up, and what is
// inside. Typing a path is offered alongside clicking through it, because a path
// already known should not have to be walked to.
export const FolderBrowser = observer(function FolderBrowser({
  store,
  presenter,
  label,
  placeholder,
  canCreate = false,
  onPathChange,
}: {
  store: FolderBrowserStore;
  presenter: FolderBrowserPresenter;
  label: string;
  placeholder?: string;
  canCreate?: boolean;
  /** Every folder the walk lands on, and every path typed into the box. */
  onPathChange: (path: string) => void;
}): JSX.Element {
  const listing = store.listing;
  const [draft, setDraft] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const typedTo = useRef<string | null>(null);

  async function create(): Promise<void> {
    if (naming == null) return;
    if (await presenter.createFolder(naming)) setNaming(null);
  }

  // The box is the answer and browsing is one way of filling it in, so every
  // move through the tree writes the folder it landed on back into it. A walk
  // that has not landed anywhere yet empties it rather than leaving the previous
  // one's answer standing, which would otherwise be submittable while the first
  // listing is still in flight. Only the listing is followed: the caller
  // rebuilds `onPathChange` on every render, so depending on it would re-run
  // this over whatever is being typed.
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
  }, [listing]);

  return (
    <div {...stylex.props(styles.browse)}>
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
          onKeyDown={(e) => e.key === 'Enter' && void presenter.open(draft.trim())}
        />
        {canCreate && (
          <Button
            iconOnly
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
        {listing?.directories.length === 0 && <Text variant="muted">{FolderBrowserStrings.noFolders()}</Text>}
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
    </div>
  );
});
