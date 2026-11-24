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
import { DialogActions, DialogBody, DialogStack } from '../../ui/dialog_layout';
import { Disclosure } from '../../ui/disclosure';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { FolderBrowser, FolderChooser } from '../browse/folder_browser';
import { newFolderBrowser } from '../browse/folder_browser_presenter';
import { ORDERINGS } from '../photos/grid/grid_controls';
import { DENOISERS } from '../raw_edit/denoisers';
import { RawEditPanelStrings } from '../raw_edit/raw_edit_panel.strings';
import { SettingsStrings } from '../settings/settings_page.strings';
import { AddLibraryStrings } from './add_library_dialog.strings';
import { inferredLibraryName } from './inferred_library_name';
import { commonParent } from './common_parent';

const styles = stylex.create({
  advanced: {
    marginTop: '12px',
  },
});

const NEW_LIBRARY = CreateLibraryRequestSchema.omit({ root_path: true }).parse({});

interface AddLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A library whose folder is already chosen: its root is fixed, and the rest starts from it. */
  preset?: CreateLibraryRequest;
}

export function AddLibraryDialog(props: AddLibraryDialogProps): JSX.Element | null {
  return props.open ? <AddLibraryFlow {...props} /> : null;
}

const AddLibraryFlow = observer(function AddLibraryFlow({
  onOpenChange,
  preset,
}: AddLibraryDialogProps): JSX.Element {
  const store = useLibrariesStore();
  const { libraries, scan } = usePresenters();
  const start = preset ?? NEW_LIBRARY;
  const [browser] = useState(newFolderBrowser);
  const [asking, setAsking] = useState(preset == null);
  const [typedName, setTypedName] = useState<string | null>(preset?.name ?? null);
  const [binName, setBinName] = useState(start.bin_name ?? DEFAULT_BIN_NAME);
  const [readOnly, setReadOnly] = useState(start.read_only);
  const [ordering, setOrdering] = useState(start.ordering);
  const [includeSubfolders, setIncludeSubfolders] = useState(start.include_subfolders);
  const [includeNonRaw, setIncludeNonRaw] = useState(start.include_non_raw);
  const [renditionSource, setRenditionSource] = useState(start.rendition_source);
  const [autoStack, setAutoStack] = useState(start.auto_stack);
  const [denoiser, setDenoiser] = useState(start.denoiser);
  const [saving, setSaving] = useState(false);

  // Whatever the last attempt failed with is answered by this attempt rather
  // than still standing over it.
  useEffect(() => libraries.clearError(), [libraries]);

  const root = preset?.root_path ?? browser.store.selectedPath;
  const name = typedName ?? inferredLibraryName(root);

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

  function answered(): void {
    // On error too: a failed native picker has nowhere else to say so.
    if (browser.store.selection != null || browser.store.error != null) setAsking(false);
    else onOpenChange(false);
  }

  async function submit(): Promise<void> {
    setSaving(true);
    const { created, readOnlyRoot } = await libraries.create({
      ...start,
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
    // The listing's `writable` comes from `access(2)`, which can be wrong.
    if (readOnlyRoot) setReadOnly(true);
    if (created == null) return;
    onOpenChange(false);
    // The server starts the import as the row lands (§9.8), so the strip is
    // pointed at it rather than waiting for someone to press Sync at a run that
    // is already going.
    void scan.watch(created.id);
  }

  if (asking) {
    return (
      <FolderChooser
        store={browser.store}
        presenter={browser.presenter}
        label={AddLibraryStrings.libraryRootPath()}
        placeholder={AddLibraryStrings.rootPlaceholder()}
        start={commonParent(store.libraries.map((library) => library.root_path))}
        open
        onClose={answered}
      />
    );
  }

  return (
    <Modal open onOpenChange={onOpenChange} title={AddLibraryStrings.title()}>
      <DialogBody height="capped">
        <Field>
          <Text variant="label" as="span">
            {AddLibraryStrings.folder()}
          </Text>
          {preset == null ? (
            <FolderBrowser
              store={browser.store}
              presenter={browser.presenter}
              label={AddLibraryStrings.libraryRootPath()}
              placeholder={AddLibraryStrings.rootPlaceholder()}
            />
          ) : (
            <Text variant="mono" as="p">
              {preset.root_path}
            </Text>
          )}
          {unwritable && (
            <Text variant="mono" as="p">
              {AddLibraryStrings.unwritableHint()}
            </Text>
          )}
        </Field>

        <Field>
          <Text variant="label" as="span">
            {SettingsStrings.libraryName()}
          </Text>
          <TextField
            grow
            label={SettingsStrings.libraryName()}
            value={name}
            onChange={setTypedName}
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
            {binExists && (
              <Text variant="mono" as="p" tone="warning">
                {AddLibraryStrings.binExistsWarning(root, bin)}
              </Text>
            )}
          </Field>
        )}

        <Disclosure title={AddLibraryStrings.advancedSettings()}>
          <div {...stylex.props(styles.advanced)}>
            <DialogStack>
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
                  {SettingsStrings.readOnlyHint()}
                </Text>
              </Field>
            </DialogStack>
          </div>
        </Disclosure>

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
