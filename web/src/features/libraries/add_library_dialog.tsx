import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { Ordering } from '../../api/client';
import { useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { ORDERINGS } from '../photos/grid_controls';
import { inferredLibraryName } from './inferred_library_name';

function newBrowser(): { store: FolderBrowserStore; presenter: FolderBrowserPresenter } {
  const store = new FolderBrowserStore();
  return { store, presenter: new FolderBrowserPresenter(store) };
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
  const [nameTouched, setNameTouched] = useState(false);
  const [binName, setBinName] = useState('Bin');
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [mirrorShoots, setMirrorShoots] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reopening starts over rather than resuming wherever the last attempt was
  // browsing, which is rarely where the next library lives. A fresh walk rather
  // than a re-`open()` of the old one, so the picker holds no answer at all
  // until the first listing lands.
  useEffect(() => {
    if (!open) return;
    setName('');
    setNameTouched(false);
    setBinName('Bin');
    setOrdering('taken_asc');
    setIncludeSubfolders(true);
    setMirrorShoots(true);
    // Including whatever the last attempt failed with, which is answered by
    // this attempt rather than still standing over it.
    libraries.clearError();
    const next = newBrowser();
    setBrowser(next);
    void next.presenter.open();
  }, [open, libraries]);

  // The folder name is the library's name until the user types one of their own.
  useEffect(() => {
    if (!nameTouched) setName(path === '' ? '' : inferredLibraryName(path));
  }, [path, nameTouched]);

  // The scan skips whatever sits at this name in the root, so a folder the user
  // already keeps there would be adopted as the bin and everything inside it
  // would silently never import. The server refuses that outright; asking here
  // means the answer arrives while the name is still being chosen.
  //
  // Only answerable while the walk is standing on the folder the box names, which
  // is every path reached by clicking. A path typed but not opened leaves the
  // question to the create.
  const root = path.trim();
  const bin = binName.trim();
  const listing = browser.store.listing;
  const binTaken = bin !== '' && listing?.path === root && listing.directories.some((directory) => directory.name === bin);

  async function submit(): Promise<void> {
    setSaving(true);
    const created = await libraries.create({
      root_path: root,
      name: name.trim(),
      bin_name: bin,
      ordering,
      include_subfolders: includeSubfolders,
      mirror_shoots: mirrorShoots,
    });
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
            value={name}
            onChange={(value) => {
              setNameTouched(true);
              setName(value);
            }}
          />
        </div>

        <div className="field">
          <Text variant="label" as="span">
            Bin folder name
          </Text>
          <TextField grow label="Bin folder name" value={binName} onChange={setBinName} invalid={binTaken} />
          <Text variant="mono" as="p" className={binTaken ? 'field__error' : undefined}>
            {binTaken
              ? `${root} already has a folder called "${bin}". Pick another name: the library never scans this folder, so everything already inside it would be left out.`
              : 'Deleted photographs are moved into a folder of this name, beside the photographs they came from. It is never scanned.'}
          </Text>
        </div>

        <div className="field">
          <Text variant="label" as="span">
            Sort photos by
          </Text>
          <Select label="Sort photos by" options={ORDERINGS} value={ordering} onChange={setOrdering} />
        </div>

        {/* Asked here rather than left to Settings because both decide what the
            first sync imports, and a library that has already spent an hour
            building renditions for a folder of decade-old rejects has answered
            the question the expensive way. */}
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={includeSubfolders} onChange={(e) => setIncludeSubfolders(e.currentTarget.checked)} />
            Include subfolders
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={mirrorShoots}
              disabled={!includeSubfolders}
              onChange={(e) => setMirrorShoots(e.currentTarget.checked)}
            />
            Make a shoot for every folder holding photos
          </label>
          <Text variant="mono" as="p">
            {includeSubfolders
              ? 'Shoots follow the folders on disk, so the two can never disagree. You can set a folder aside later from the Shoots page.'
              : 'The library is the photographs in the folder above and nothing else, so it has no folders to make shoots from.'}
          </Text>
        </div>

        {store.error != null && <div className="error">{store.error}</div>}

        <div className="dialog__actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={root === '' || name.trim() === '' || bin === '' || binTaken || saving}
            onClick={() => void submit()}
          >
            Add library
          </Button>
        </div>
      </div>
    </Modal>
  );
});
