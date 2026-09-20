import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type Ordering } from '../../../../src/schemas/common';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
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
import { AddAlbumStrings } from './add_album_dialog.strings';
import { AlbumsPageStrings } from './albums_page.strings';

export const AddAlbumDialog = observer(function AddAlbumDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (albumId: string) => void;
}): JSX.Element {
  const store = useAlbumsStore();
  const { albums } = usePresenters();
  const [name, setName] = useState('');
  const [ordering, setOrdering] = useState<Ordering>('taken_asc');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setOrdering('taken_asc');
    // Including whatever the last attempt failed with, which is answered by this
    // attempt rather than still standing over it.
    albums.clearError();
  }, [open, albums]);

  async function submit(): Promise<void> {
    setSaving(true);
    const albumId = await albums.create(name.trim(), ordering);
    setSaving(false);
    if (albumId == null) return;
    onCreated?.(albumId);
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={AddAlbumStrings.title()}>
      <DialogBody>
        <Field>
          <Text variant="label" as="span">
            {AddLibraryStrings.name()}
          </Text>
          <TextField
            grow
            autoFocus
            label={AlbumsPageStrings.albumName()}
            placeholder={AlbumsPageStrings.albumName()}
            value={name}
            onChange={setName}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() !== '' && !saving) void submit();
            }}
          />
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
            {AlbumsPageStrings.createAlbum()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
