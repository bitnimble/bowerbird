import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import {
  CreateLibraryRequestSchema,
  DEFAULT_BIN_NAME,
  type CreateLibraryRequest,
} from '../../../../src/schemas/libraries';
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
import { newFolderBrowser } from '../browse/folder_browser_presenter';
import { ORDERINGS } from '../photos/grid/grid_controls';
import { DENOISERS } from '../raw_edit/denoisers';
import { RawEditPanelStrings } from '../raw_edit/raw_edit_panel.strings';
import { SettingsStrings } from '../settings/settings_page.strings';
import { AddLibraryStrings } from './add_library_dialog.strings';
import { inferredLibraryName } from './inferred_library_name';
import { commonParent } from './common_parent';

const NEW_LIBRARY = CreateLibraryRequestSchema.omit({ root_path: true }).parse({});

// Everything a library needs before it exists, in one place: where its photos
// are, what to call it, and how its gallery is ordered to begin with.
//
// The folder is walked as well as typed because the path is read on the server,
// which may not be the machine this page is open on, so a path that exists here
// is not necessarily one the server can open.
export const AddLibraryDialog = observer(function AddLibraryDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A library whose folder is already chosen: its root is fixed, and the rest starts from it. */
  preset?: CreateLibraryRequest;
}): JSX.Element {
  const store = useLibrariesStore();
  const { libraries, scan } = usePresenters();
  const [browser, setBrowser] = useState(newFolderBrowser);
  // From the preset as well as the reset below: a dialog mounted open runs the
  // name inference in the same commit, which would blank the preset's name.
  const [path, setPath] = useState(preset?.root_path ?? '');
  const [name, setName] = useState(preset?.name ?? '');
  const [nameTouched, setNameTouched] = useState(preset?.name != null);
  const [binName, setBinName] = useState(DEFAULT_BIN_NAME);
  const [readOnly, setReadOnly] = useState(NEW_LIBRARY.read_only);
  const [ordering, setOrdering] = useState(NEW_LIBRARY.ordering);
  const [includeSubfolders, setIncludeSubfolders] = useState(NEW_LIBRARY.include_subfolders);
  const [includeNonRaw, setIncludeNonRaw] = useState(NEW_LIBRARY.include_non_raw);
  const [renditionSource, setRenditionSource] = useState(NEW_LIBRARY.rendition_source);
  const [autoStack, setAutoStack] = useState(NEW_LIBRARY.auto_stack);
  const [denoiser, setDenoiser] = useState(NEW_LIBRARY.denoiser);
  const [saving, setSaving] = useState(false);

  // Reopening starts over rather than resuming wherever the last attempt was
  // browsing, which is rarely where the next library lives. A fresh walk rather
  // than a re-`open()` of the old one, so the picker holds no answer at all
  // until the first listing lands.
  useEffect(() => {
    if (!open) return;
    const start = preset ?? NEW_LIBRARY;
    setName(start.name ?? '');
    setNameTouched(start.name != null);
    setBinName(start.bin_name ?? DEFAULT_BIN_NAME);
    setReadOnly(start.read_only);
    setOrdering(start.ordering);
    setIncludeSubfolders(start.include_subfolders);
    setIncludeNonRaw(start.include_non_raw);
    setRenditionSource(start.rendition_source);
    setAutoStack(start.auto_stack);
    setDenoiser(start.denoiser);
    // Including whatever the last attempt failed with, which is answered by
    // this attempt rather than still standing over it.
    libraries.clearError();
    if (preset != null) {
      setPath(preset.root_path);
      return;
    }
    const next = newFolderBrowser();
    setBrowser(next);
    void next.presenter.open(commonParent(store.libraries.map((library) => library.root_path)));
  }, [open, libraries, store, preset]);

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
  const root = path;
  const bin = binName.trim();
  const listing = browser.store.listing;
  const binExists =
    bin !== '' &&
    listing?.path === root &&
    listing.directories.some((directory) => directory.name === bin);
  // A folder the server cannot write in can only be added read-only, so the box
  // is ticked and locked for it rather than letting the create fail.
  const unwritable = listing?.path === root && listing.writable === false;
  const readOnlyLibrary = readOnly || unwritable;

  async function submit(): Promise<void> {
    setSaving(true);
    const { created, readOnlyRoot } = await libraries.create({
      ...(preset ?? NEW_LIBRARY),
      root_path: root,
      name: name.trim(),
      read_only: readOnlyLibrary,
      bin_name: readOnlyLibrary ? null : bin,
      ordering,
      include_subfolders: includeSubfolders,
      include_non_raw: includeNonRaw,
      rendition_source: renditionSource,
      auto_stack: autoStack,
      denoiser,
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
            {preset == null ? (
              <>
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
              </>
            ) : (
              <Text variant="mono" as="p">
                {preset.root_path}
              </Text>
            )}
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
              <Select
                label={AddLibraryStrings.sortPhotosBy()}
                options={ORDERINGS}
                value={ordering}
                onChange={setOrdering}
              />
            </Field>

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

            {/* Asked here rather than left to Settings because every one of them
                decides what the first import does, and the import starts as the
                library lands. A library that has already spent an hour building
                renditions for a folder of decade-old rejects, or that has already
                stacked them, has answered the question the expensive way. */}
            <Field>
              <CheckLabel>
                <input
                  {...stylex.props(focusRing.ring)}
                  type="checkbox"
                  checked={renditionSource === 'render'}
                  onChange={(e) =>
                    setRenditionSource(e.currentTarget.checked ? 'render' : 'embedded')
                  }
                />
                {SettingsStrings.preRenderImported()}
              </CheckLabel>
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
              <Text variant="mono" as="p">
                {SettingsStrings.includeNonRawHint()}
              </Text>
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
                <TextField
                  grow
                  label={SettingsStrings.binFolderName()}
                  value={binName}
                  onChange={setBinName}
                />
                <Text variant="mono" as="p" tone={binExists ? 'warning' : undefined}>
                  {binExists
                    ? AddLibraryStrings.binExistsWarning(root, bin)
                    : AddLibraryStrings.binNameHint()}
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
            disabled={
              root.trim() === '' || name.trim() === '' || (!readOnlyLibrary && bin === '') || saving
            }
            onClick={() => void submit()}
          >
            {AddLibraryStrings.title()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
