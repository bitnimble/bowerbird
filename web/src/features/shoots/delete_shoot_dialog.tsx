import { useEffect, useState } from 'react';
import { api, type Shoot } from '../../api/client';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { Text } from '../../ui/text';

type Disposition = 'keep' | 'remove';

// What becomes of the photographs is asked rather than assumed, because one
// answer is reversible and the other is not (§8.5). Neither touches a file on
// disk, which the dialog says outright: "delete" next to a folder full of RAWs
// is worth being unambiguous about.
export function DeleteShootDialog({
  shoot,
  onOpenChange,
  onConfirm,
}: {
  shoot: Shoot | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (photos: Disposition) => void;
}): JSX.Element {
  const [photos, setPhotos] = useState<Disposition>('keep');
  // Counted by the server, because what `remove` takes is every row under the
  // folder - which includes binned photos and photos in a subfolder that is not
  // a shoot, neither of which any count on this page can see. Null until it
  // lands, so the dialog never states a number it has invented.
  const [count, setCount] = useState<number | null>(null);

  // Reopening starts at the reversible answer rather than at whatever the last
  // delete chose.
  useEffect(() => {
    setPhotos('keep');
    setCount(null);
    if (shoot == null) return;
    let current = true;
    void api
      .getShootRemoval(shoot.id)
      .then((removal) => current && setCount(removal.photos))
      .catch(() => current && setCount(null));
    return () => {
      current = false;
    };
  }, [shoot]);

  const photographs = count == null ? 'the photographs' : `${count} ${count === 1 ? 'photo' : 'photos'}`;

  return (
    <Modal open={shoot != null} onOpenChange={onOpenChange} title={`Delete ${shoot?.name ?? 'shoot'}?`}>
      <div className="dialog">
        <Text as="p" variant="muted">
          The folder <code>{shoot?.folder_path}</code> and the files in it stay exactly where they are on disk. This is about
          what the catalogue keeps.
        </Text>

        {/* A radiogroup rather than two loose radios, so the question is read out
            with the answers, and each answer is read with what it costs. */}
        <div className="field" role="radiogroup" aria-label="What happens to the photographs">
          <label className="check">
            <input
              type="radio"
              name="photos"
              checked={photos === 'keep'}
              aria-describedby="delete-shoot-keep"
              onChange={() => setPhotos('keep')}
            />
            Keep the photos in the library
          </label>
          <Text variant="mono" as="p" id="delete-shoot-keep">
            They stay in the grid with their ratings, just not grouped as a shoot. The folder will not become a shoot again on
            its own.
          </Text>

          <label className="check">
            <input
              type="radio"
              name="photos"
              checked={photos === 'remove'}
              aria-describedby="delete-shoot-remove"
              onChange={() => setPhotos('remove')}
            />
            Remove the photos from the library too
          </label>
          <Text variant="mono" as="p" id="delete-shoot-remove">
            The folder stops being part of the library. Ratings, verdicts and notes on {photographs} are lost, and putting the
            folder back re-imports them as new ones. Anything of theirs already in the Bin is forgotten too, though no file is
            deleted either way.
          </Text>
        </div>

        <div className="dialog__actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          {/* The irreversible half waits for the count, so it can never be taken
              against a number the reader was not shown. */}
          <Button variant="danger" disabled={photos === 'remove' && count == null} onClick={() => onConfirm(photos)}>
            {photos === 'keep' ? 'Delete shoot' : `Delete shoot and ${photographs}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
