import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { type Shoot } from '../../../../src/schemas/shoots';
import { shootsApi } from '../../api/shoots';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { CheckLabel } from '../../ui/check_label';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { Text } from '../../ui/text';
import { ModalStrings } from '../../ui/modal.strings';
import { DeleteShootStrings } from './delete_shoot_dialog.strings';
import { ShootsPageStrings } from './shoots_page.strings';

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
    void shootsApi
      .removal(shoot.id)
      .then((removal) => current && setCount(removal.photos))
      .catch(() => current && setCount(null));
    return () => {
      current = false;
    };
  }, [shoot]);

  const photographs = count == null ? DeleteShootStrings.thePhotographs() : ShootsPageStrings.photoCount(count);

  return (
    <Modal
      open={shoot != null}
      onOpenChange={onOpenChange}
      title={DeleteShootStrings.title(shoot?.name ?? DeleteShootStrings.fallbackName())}
    >
      <DialogBody>
        <Text as="p" variant="muted">
          {DeleteShootStrings.filesStayBefore()}
          <code>{shoot?.folder_path}</code>
          {DeleteShootStrings.filesStayAfter()}
        </Text>

        {/* A radiogroup rather than two loose radios, so the question is read out
            with the answers, and each answer is read with what it costs. */}
        <Field role="radiogroup" aria-label={DeleteShootStrings.question()}>
          <CheckLabel>
            <input
              {...stylex.props(focusRing.ring)}
              type="radio"
              name="photos"
              checked={photos === 'keep'}
              aria-describedby="delete-shoot-keep"
              onChange={() => setPhotos('keep')}
            />
            {DeleteShootStrings.keep()}
          </CheckLabel>
          <Text variant="mono" as="p" id="delete-shoot-keep">
            {DeleteShootStrings.keepHint()}
          </Text>

          <CheckLabel>
            <input
              {...stylex.props(focusRing.ring)}
              type="radio"
              name="photos"
              checked={photos === 'remove'}
              aria-describedby="delete-shoot-remove"
              onChange={() => setPhotos('remove')}
            />
            {DeleteShootStrings.removeOption()}
          </CheckLabel>
          <Text variant="mono" as="p" id="delete-shoot-remove">
            {DeleteShootStrings.removeHint(photographs)}
          </Text>
        </Field>

        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{ModalStrings.cancel()}</Button>
          {/* The irreversible half waits for the count, so it can never be taken
              against a number the reader was not shown. */}
          <Button variant="danger" disabled={photos === 'remove' && count == null} onClick={() => onConfirm(photos)}>
            {photos === 'keep' ? DeleteShootStrings.deleteShoot() : DeleteShootStrings.deleteShootAndPhotos(photographs)}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
}
