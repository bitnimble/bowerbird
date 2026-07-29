import { useEffect, useState } from 'react';
import type { Shoot } from '../../api/client';
import { Button, Modal, Text } from '../../ui/ui';

type Disposition = 'keep' | 'remove';

// What becomes of the photographs is asked rather than assumed, because one
// answer is reversible and the other is not (§8.5). Neither touches a file on
// disk, which the dialog says outright: "delete" next to a folder full of RAWs
// is worth being unambiguous about.
export function DeleteShootDialog({
  shoot,
  photoCount,
  onOpenChange,
  onConfirm,
}: {
  shoot: Shoot | null;
  photoCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (photos: Disposition) => void;
}): JSX.Element {
  const [photos, setPhotos] = useState<Disposition>('keep');

  // Reopening starts at the reversible answer rather than at whatever the last
  // delete chose.
  useEffect(() => {
    if (shoot != null) setPhotos('keep');
  }, [shoot]);

  return (
    <Modal open={shoot != null} onOpenChange={onOpenChange} title={`Delete ${shoot?.name ?? 'shoot'}?`}>
      <div className="dialog">
        <Text as="p" variant="muted">
          The folder <code>{shoot?.folder_path}</code> and the {photoCount} {photoCount === 1 ? 'file' : 'files'} in it stay
          exactly where they are on disk. This is about what the catalogue keeps.
        </Text>

        <div className="field">
          <label className="check">
            <input type="radio" name="photos" checked={photos === 'keep'} onChange={() => setPhotos('keep')} />
            Keep the photos in the library
          </label>
          <Text variant="mono" as="p">
            They stay in the grid with their ratings, just not grouped as a shoot. The folder will not become a shoot again on
            its own.
          </Text>

          <label className="check">
            <input type="radio" name="photos" checked={photos === 'remove'} onChange={() => setPhotos('remove')} />
            Remove the photos from the library too
          </label>
          <Text variant="mono" as="p">
            The folder stops being part of the library. Ratings, verdicts and notes on those {photoCount}{' '}
            {photoCount === 1 ? 'photo' : 'photos'} are lost, and putting the folder back re-imports them as new ones.
          </Text>
        </div>

        <div className="dialog__actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(photos)}>
            {photos === 'keep' ? 'Delete shoot' : 'Delete shoot and photos'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
