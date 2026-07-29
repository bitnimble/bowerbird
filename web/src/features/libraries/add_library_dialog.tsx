import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { Ordering } from '../../api/client';
import { useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button, Modal, Select, Text, TextField } from '../../ui/ui';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { ORDERINGS } from '../photos/grid_controls';

function newBrowser(): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store) };
}

function basename(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

// Everything a library needs before it exists, in one place: where its photos
// are, what to call it, and how its gallery is ordered to begin with.
//
// The folder is walked as well as typed because the path is read on the server,
// which may not be the machine this page is open on, so a path that exists here
// is not necessarily one the server can open.
export const AddLibraryDialog = observer(function AddLibraryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useLibrariesStore();
  const { libraries } = usePresenters();
  const [browser, setBrowser] = useState(newBrowser);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [saving, setSaving] = useState(false);

  // Reopening starts over rather than resuming wherever the last attempt was
  // browsing, which is rarely where the next library lives. A fresh walk rather
  // than a re-`open()` of the old one, so the picker holds no answer at all
  // until the first listing lands.
  useEffect(() => {
    if (!open) return;
    setName('');
    setOrdering('taken_asc');
    // Including whatever the last attempt failed with, which is answered by
    // this attempt rather than still standing over it.
    libraries.clearError();
    const next = newBrowser();
    setBrowser(next);
    void next.presenter.open();
  }, [open, libraries]);

  async function submit(): Promise<void> {
    setSaving(true);
    const created = await libraries.create({ root_path: path.trim(), name: name.trim(), ordering });
    setSaving(false);
    if (created) onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add library">
      <div className="dialog">
        <div className="field">
          <Text variant="label" as="span">
            Folder
          </Text>
          <FolderBrowser
            store={browser.store}
            presenter={browser.presenter}
            label="Library root path"
            placeholder="/photos"
            onPathChange={setPath}
          />
          <Text variant="mono" as="p">
            The library is added at the folder in the box above. Click a folder to go into it, or type a path and press Enter.
          </Text>
        </div>

        <div className="field">
          <Text variant="label" as="span">
            Name
          </Text>
          <TextField
            grow
            label="Library name"
            placeholder={path === '' ? 'The folder name' : basename(path)}
            value={name}
            onChange={setName}
          />
        </div>

        <div className="field">
          <Text variant="label" as="span">
            Sort photos by
          </Text>
          <Select label="Sort photos by" options={ORDERINGS} value={ordering} onChange={setOrdering} />
        </div>

        {store.error != null && <div className="error">{store.error}</div>}

        <div className="dialog__actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={path.trim() === '' || saving} onClick={() => void submit()}>
            Add library
          </Button>
        </div>
      </div>
    </Modal>
  );
});
