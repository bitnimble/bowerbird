import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type Ordering } from '../../../../src/schemas/common';
import type { ShootNode } from '../../app/sidebar_store';
import { usePresenters, useShootsStore, useSidebarStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { ORDERINGS } from '../photos/grid/grid_controls';
import { AddShootStrings } from './add_shoot_dialog.strings';

function parentOptions(trees: ShootNode[], parentPath: string): Option<string>[] {
  const options: Option<string>[] = [{ value: '', label: AddShootStrings.noParentShoot() }];
  const walk = (nodes: ShootNode[], depth: number): void => {
    for (const { shoot, children } of nodes) {
      options.push({ value: shoot.folder_path, label: shoot.name, depth });
      walk(children, depth + 1);
    }
  };
  walk(trees, 0);
  // Opened from a plain folder's or a hidden shoot's row, which no shoot option names.
  if (!options.some((option) => option.value === parentPath))
    options.splice(1, 0, { value: parentPath, label: parentPath });
  return options;
}

export const AddShootDialog = observer(function AddShootDialog({
  libraryId,
  parentPath,
  open,
  onOpenChange,
  onCreated,
}: {
  libraryId: string;
  /** Root-relative folder the parent field starts on; `''` is the library root. */
  parentPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (shootId: string) => void;
}): JSX.Element {
  const store = useShootsStore();
  const sidebar = useSidebarStore();
  const { shoots, sidebar: sidebarPresenter } = usePresenters();
  const [name, setName] = useState('');
  const [parent, setParent] = useState(parentPath);
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setParent(parentPath);
    setOrdering('taken_asc');
    // Including whatever the last attempt failed with, which is answered by this
    // attempt rather than still standing over it.
    shoots.clearError();
    void sidebarPresenter.loadShoots(libraryId);
  }, [open, parentPath, libraryId, shoots, sidebarPresenter]);

  async function submit(): Promise<void> {
    setSaving(true);
    const shootId = await shoots.create(libraryId, name.trim(), parent, ordering);
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
              {parent === ''
                ? name || AddShootStrings.unnamed()
                : `${parent}/${name || AddShootStrings.unnamed()}`}
            </code>
            {AddShootStrings.makesTheFolderAfter()}
          </Text>
        </Field>

        <Field>
          <Text variant="label" as="span">
            {AddShootStrings.parentShoot()}
          </Text>
          <Select
            label={AddShootStrings.parentShoot()}
            options={parentOptions(sidebar.shootTrees.get(libraryId) ?? [], parentPath)}
            value={parent}
            onChange={setParent}
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

        {store.error != null && <ErrorBanner>{store.error}</ErrorBanner>}

        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{ModalStrings.cancel()}</Button>
          <Button
            variant="primary"
            disabled={name.trim() === '' || saving}
            onClick={() => void submit()}
          >
            {AddShootStrings.createShoot()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
