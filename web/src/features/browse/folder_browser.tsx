import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { CornerLeftUp, Folder } from 'lucide-react';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import type { FolderBrowserPresenter } from './folder_browser_presenter';
import type { FolderBrowserStore } from './folder_browser_store';

// Walking the server's folders: where the walk is now, one level up, and what is
// inside. Typing a path is offered alongside clicking through it, because a path
// already known should not have to be walked to.
export const FolderBrowser = observer(function FolderBrowser({
  store,
  presenter,
  label,
  placeholder,
  onPathChange,
}: {
  store: FolderBrowserStore;
  presenter: FolderBrowserPresenter;
  label: string;
  placeholder?: string;
  /** Every folder the walk lands on, and every path typed into the box. */
  onPathChange: (path: string) => void;
}): JSX.Element {
  const listing = store.listing;
  const [draft, setDraft] = useState('');

  // The box is the answer and browsing is one way of filling it in, so every
  // move through the tree writes the folder it landed on back into it. A walk
  // that has not landed anywhere yet empties it rather than leaving the previous
  // one's answer standing, which would otherwise be submittable while the first
  // listing is still in flight. Only the listing is followed: the caller
  // rebuilds `onPathChange` on every render, so depending on it would re-run
  // this over whatever is being typed.
  useEffect(() => {
    const landed = listing?.path ?? '';
    setDraft(landed);
    onPathChange(landed);
  }, [listing]);

  return (
    <div className="browse">
      <div className="browse__bar">
        <Button
          iconOnly
          aria-label="Go up one folder"
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
            onPathChange(next);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void presenter.open(draft.trim())}
        />
      </div>
      <div className="browse__list">
        {store.error != null && <Text variant="mono">{store.error}</Text>}
        {listing?.directories.length === 0 && <Text variant="muted">No folders in here</Text>}
        {listing?.directories.map((directory) => (
          <button key={directory.path} type="button" className="browse__item" onClick={() => void presenter.open(directory.path)}>
            <Folder size={ICON} />
            {directory.name}
          </button>
        ))}
      </div>
    </div>
  );
});
