import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, Modal, Text, TextField } from '../../ui/ui';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { libraryLabel } from '../libraries/library_label';

// A shoot is a folder, so it is created by choosing where the folder goes and
// naming it, rather than by picking a parent shoot from a list: the folder it
// sits in need not be a shoot itself, and the parent link follows from where it
// landed. The walk starts at the library root and cannot climb out of it, which
// the server enforces as well as this picker.
export const AddShootDialog = observer(function AddShootDialog({
  libraryId,
  open,
  onOpenChange,
}: {
  libraryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useShootsStore();
  const libraries = useLibrariesStore();
  const { shoots } = usePresenters();
  // Keyed on the library: reopening the dialog in another one must not walk the
  // previous library's folders.
  const [browser, setBrowser] = useState(() => newBrowser(libraryId));
  const [parentPath, setParentPath] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    // Including whatever the last attempt failed with, which is answered by
    // this attempt rather than still standing over it.
    shoots.clearError();
    const next = newBrowser(libraryId);
    setBrowser(next);
    void next.presenter.open();
  }, [open, libraryId, shoots]);

  const library = libraries.byId.get(libraryId);

  async function submit(): Promise<void> {
    setSaving(true);
    const created = await shoots.create(libraryId, name.trim(), parentPath.trim(), 'taken_asc');
    setSaving(false);
    if (created) onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add shoot">
      <div className="dialog">
        <div className="field">
          <Text variant="label" as="span">
            Inside folder
          </Text>
          <FolderBrowser
            store={browser.store}
            presenter={browser.presenter}
            label="Parent folder"
            placeholder={library == null ? 'The library root' : libraryLabel(library)}
            onPathChange={setParentPath}
          />
          <Text variant="mono" as="p">
            The shoot&apos;s folder is created inside the folder in the box above. Leave it empty for the library root.
          </Text>
        </div>

        <div className="field">
          <Text variant="label" as="span">
            Name
          </Text>
          <TextField grow label="Shoot name" placeholder="Shoot name" value={name} onChange={setName} />
          <Text variant="mono" as="p">
            Names the folder as well as the shoot. Pointing it at a folder that already exists adopts the photos in it rather than
            moving anything.
          </Text>
        </div>

        {store.error != null && <div className="error">{store.error}</div>}

        <div className="dialog__actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={name.trim() === '' || saving} onClick={() => void submit()}>
            Create shoot
          </Button>
        </div>
      </div>
    </Modal>
  );
});

function newBrowser(libraryId: string): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store, libraryId) };
}
