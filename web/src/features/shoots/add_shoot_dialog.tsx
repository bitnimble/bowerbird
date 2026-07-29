import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { Ordering } from '../../api/client';
import { usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, Modal, Select, Text, TextField } from '../../ui/ui';
import { ORDERINGS } from '../photos/grid_controls';

// Only what a folder cannot answer. Where the shoot goes is decided by the row
// its + menu was opened from (§18.3.2), so the picker that used to re-walk the
// tree inside this dialog is gone: the page is already a view of the folders.
export const AddShootDialog = observer(function AddShootDialog({
  libraryId,
  parentPath,
  open,
  onOpenChange,
}: {
  libraryId: string;
  /** Root-relative folder the new folder is created in; `''` is the library root. */
  parentPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    const created = await shoots.create(libraryId, name.trim(), parentPath, ordering);
    setSaving(false);
    if (created) onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New shoot">
      <div className="dialog">
        <div className="field">
          <Text variant="label" as="span">
            Name
          </Text>
          <TextField grow label="Shoot name" placeholder="Shoot name" value={name} onChange={setName} />
          <Text variant="mono" as="p">
            Makes the folder <code>{parentPath === '' ? name || 'name' : `${parentPath}/${name || 'name'}`}</code>. Renaming the
            shoot later is a label change and never moves it.
          </Text>
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
          <Button variant="primary" disabled={name.trim() === '' || saving} onClick={() => void submit()}>
            Create shoot
          </Button>
        </div>
      </div>
    </Modal>
  );
});
