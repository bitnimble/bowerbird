import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type Ordering } from '../../../../src/schemas/common';
import { usePresenters, useShootsStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { ORDERINGS } from '../photos/grid/grid_controls';
import { AddShootStrings } from './add_shoot_dialog.strings';

// Only what a folder cannot answer. Where the shoot goes is decided by the row its + menu was
// opened from (§18.3.2), so this dialog needs no picker of its own: the page is already a view
// of the folders.
export const AddShootDialog = observer(function AddShootDialog({
  libraryId,
  parentPath,
  open,
  onOpenChange,
  onCreated,
}: {
  libraryId: string;
  /** Root-relative folder the new folder is created in; `''` is the library root. */
  parentPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (shootId: string) => void;
}): JSX.Element {
  const store = useShootsStore();
  const { shoots } = usePresenters();
  const [name, setName] = useState('');
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setOrdering('taken_asc');
    // Including whatever the last attempt failed with, which is answered by this
    // attempt rather than still standing over it.
    shoots.clearError();
  }, [open, shoots]);

  async function submit(): Promise<void> {
    setSaving(true);
    const shootId = await shoots.create(libraryId, name.trim(), parentPath, ordering);
    setSaving(false);
    if (shootId == null) return;
    onCreated?.(shootId);
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={AddShootStrings.title()}>
      <DialogBody>
        <Field>
          <Text variant="label" as="span">
            {AddLibraryStrings.name()}
          </Text>
          <TextField
            grow
            label={AddShootStrings.shootName()}
            placeholder={AddShootStrings.shootName()}
            value={name}
            onChange={setName}
          />
          <Text variant="mono" as="p">
            {AddShootStrings.makesTheFolderBefore()}
            <code>
              {parentPath === '' ?
                name || AddShootStrings.unnamed()
              : `${parentPath}/${name || AddShootStrings.unnamed()}`}
            </code>
            {AddShootStrings.makesTheFolderAfter()}
          </Text>
        </Field>

        <Field>
          <Text variant="label" as="span">
            {AddLibraryStrings.sortPhotosBy()}
          </Text>
          <Select label={AddLibraryStrings.sortPhotosBy()} options={ORDERINGS} value={ordering} onChange={setOrdering} />
        </Field>

        {store.error != null && <ErrorBanner>{store.error}</ErrorBanner>}

        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{ModalStrings.cancel()}</Button>
          <Button variant="primary" disabled={name.trim() === '' || saving} onClick={() => void submit()}>
            {AddShootStrings.createShoot()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
