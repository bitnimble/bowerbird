import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type Ordering, type RenditionSource } from '../../../../src/schemas/common';
import { useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { CheckLabel } from '../../ui/check_label';
import { DialogActions, DialogBody, DialogColumns, DialogStack } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser } from '../browse/folder_browser';
import { FolderBrowserPresenter } from '../browse/folder_browser_presenter';
import { FolderBrowserStore } from '../browse/folder_browser_store';
import { ORDERINGS } from '../photos/grid/grid_controls';
import { RENDITION_SOURCES } from '../photos/renditions';
import { SettingsStrings } from '../settings/settings_page.strings';
import { AddLibraryStrings } from './add_library_dialog.strings';
import { inferredLibraryName } from './inferred_library_name';
import { newLibraryStart } from './new_library_start';

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
  const { libraries, scan } = usePresenters();
  const [browser, setBrowser] = useState(newBrowser);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [binName, setBinName] = useState('Bin');
  const [readOnly, setReadOnly] = useState(false);
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [includeNonRaw, setIncludeNonRaw] = useState(false);
  const [renditionSource, setRenditionSource] = useState<RenditionSource>('render');
  const [autoStack, setAutoStack] = useState(true);
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
    setReadOnly(false);
    setOrdering('taken_asc');
    setIncludeSubfolders(true);
    setIncludeNonRaw(false);
    setRenditionSource('render');
    setAutoStack(true);
    // Including whatever the last attempt failed with, which is answered by
    // this attempt rather than still standing over it.
    libraries.clearError();
    const next = newBrowser();
    setBrowser(next);
    void next.presenter.open(newLibraryStart(store.libraries.map((library) => library.root_path)));
  }, [open, libraries, store]);

  // The folder name is the library's name until the user types one of their own.
  useEffect(() => {
    if (!nameTouched) setName(path === '' ? '' : inferredLibraryName(path));
  }, [path, nameTouched]);

  // A folder already sitting at this name becomes the bin, so the photographs
  // inside it import as deleted rather than as part of the collection. Said here
  // rather than left to the create, so the reader can pick another name while the
  // name is still being chosen.
  //
  // Only answerable while the walk is standing on the folder the box names, which
  // is every path reached by clicking. A path typed but not opened goes ahead
  // unwarned.
  const root = path.trim();
  const bin = binName.trim();
  const listing = browser.store.listing;
  const binExists = bin !== '' && listing?.path === root && listing.directories.some((directory) => directory.name === bin);
  // A folder the server cannot write in can only be added read-only, so the box
  // is ticked and locked for it rather than letting the create fail.
  const unwritable = listing?.path === root && listing.writable === false;
  const readOnlyLibrary = readOnly || unwritable;

  async function submit(): Promise<void> {
    setSaving(true);
    const { created, readOnlyRoot } = await libraries.create({
      root_path: root,
      name: name.trim(),
      read_only: readOnlyLibrary,
      bin_name: readOnlyLibrary ? null : bin,
      ordering,
      include_subfolders: includeSubfolders,
      include_non_raw: includeNonRaw,
      rendition_source: renditionSource,
      auto_stack: autoStack,
    });
    setSaving(false);
    // The server found the root unwritable after all - `access(2)` can be wrong,
    // and the listing may be of a different folder from the one typed. Ticking
    // the box is the answer, so tick it: the reader can press Add again rather
    // than work out what an error about permissions wants from them.
    if (readOnlyRoot) setReadOnly(true);
    if (created == null) return;
    onOpenChange(false);
    // The server starts the import as the row lands (§9.8), so the strip is
    // pointed at it rather than waiting for someone to press Sync at a run that
    // is already going.
    void scan.watch(created.id);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={AddLibraryStrings.title()}>
      <DialogBody wide height="fixed">
        <DialogColumns>
          <Field>
            <Text variant="label" as="span">
              {AddLibraryStrings.folder()}
            </Text>
            <FolderBrowser
              store={browser.store}
              presenter={browser.presenter}
              label={AddLibraryStrings.libraryRootPath()}
              placeholder={AddLibraryStrings.rootPlaceholder()}
              onPathChange={setPath}
            />
            <Text variant="mono" as="p">
              {AddLibraryStrings.folderHint()}
            </Text>
          </Field>

          <DialogStack>
            <Field>
              <Text variant="label" as="span">
                {AddLibraryStrings.name()}
              </Text>
              <TextField
                grow
                label={SettingsStrings.libraryName()}
                value={name}
                onChange={(value) => {
                  setNameTouched(true);
                  setName(value);
                }}
              />
            </Field>

            <Field>
              <Text variant="label" as="span">
                {AddLibraryStrings.sortPhotosBy()}
              </Text>
              <Select label={AddLibraryStrings.sortPhotosBy()} options={ORDERINGS} value={ordering} onChange={setOrdering} />
            </Field>

            {/* Asked here rather than left to Settings because every one of them
                decides what the first import does, and the import starts as the
                library lands. A library that has already spent an hour building
                renditions for a folder of decade-old rejects, or that has already
                stacked them, has answered the question the expensive way. */}
            <Field>
              <Text variant="label" as="span">
                {SettingsStrings.buildRenditionsFrom()}
              </Text>
              <Select
                label={SettingsStrings.buildRenditionsFrom()}
                options={RENDITION_SOURCES}
                value={renditionSource}
                onChange={setRenditionSource}
              />
              <Text variant="mono" as="p">
                {SettingsStrings.renditionSourceHint()}
              </Text>
            </Field>
          </DialogStack>
        </DialogColumns>

        <DialogColumns ruled>
          <DialogStack>
            <Field>
              <CheckLabel>
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  checked={includeSubfolders}
                  onChange={(e) => setIncludeSubfolders(e.currentTarget.checked)}
                />
                {SettingsStrings.includeSubfolders()}
              </CheckLabel>
            </Field>

            <Field>
              <CheckLabel>
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  checked={includeNonRaw}
                  onChange={(e) => setIncludeNonRaw(e.currentTarget.checked)}
                />
                {SettingsStrings.includeNonRaw()}
              </CheckLabel>
            </Field>

            <Field>
              <CheckLabel>
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  checked={autoStack}
                  onChange={(e) => setAutoStack(e.currentTarget.checked)}
                />
                {SettingsStrings.autoStack()}
              </CheckLabel>
            </Field>
          </DialogStack>

          <DialogStack>
            <Field>
              <CheckLabel>
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  checked={readOnlyLibrary}
                  disabled={unwritable}
                  onChange={(e) => setReadOnly(e.currentTarget.checked)}
                />
                {SettingsStrings.readOnly()}
              </CheckLabel>
              <Text variant="mono" as="p">
                {unwritable ? AddLibraryStrings.unwritableHint() : SettingsStrings.readOnlyHint()}
              </Text>
            </Field>

            {!readOnlyLibrary && (
              <Field>
                <Text variant="label" as="span">
                  {SettingsStrings.binFolderName()}
                </Text>
                <TextField grow label={SettingsStrings.binFolderName()} value={binName} onChange={setBinName} />
                <Text variant="mono" as="p" tone={binExists ? 'warning' : undefined}>
                  {binExists ? AddLibraryStrings.binExistsWarning(root, bin) : AddLibraryStrings.binNameHint()}
                </Text>
              </Field>
            )}
          </DialogStack>
        </DialogColumns>

        {store.error != null && <ErrorBanner>{store.error}</ErrorBanner>}

        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{ModalStrings.cancel()}</Button>
          <Button
            variant="primary"
            // The bin name is not part of the answer for a read-only library, so
            // it must not be part of the guard either - Add would never enable.
            disabled={root === '' || name.trim() === '' || (!readOnlyLibrary && bin === '') || saving}
            onClick={() => void submit()}
          >
            {AddLibraryStrings.title()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
