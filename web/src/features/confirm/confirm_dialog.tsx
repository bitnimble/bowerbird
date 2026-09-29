import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useConfirmStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Text } from '../../ui/text';

export const ConfirmDialog = observer(function ConfirmDialog(): JSX.Element | null {
  const { request } = useConfirmStore();
  const { confirm } = usePresenters();
  const asking = request != null;

  useEffect(() => {
    if (!asking) return;
    // Base UI sees a dialog asked over another as a sibling, not a child, so the one underneath
    // would take Escape and close with the question still up.
    const cancel = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      confirm.answer(false);
    };
    window.addEventListener('keydown', cancel, { capture: true });
    return () => window.removeEventListener('keydown', cancel, { capture: true });
  }, [asking, confirm]);

  if (request == null) return null;

  return (
    <Modal open onOpenChange={(open) => !open && confirm.answer(false)} title={request.title}>
      <DialogBody>
        {request.body != null && <Text as="p">{request.body}</Text>}
        <DialogActions>
          <Button onClick={() => confirm.answer(false)}>{ModalStrings.cancel()}</Button>
          <Button
            variant={request.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => confirm.answer(true)}
          >
            {request.action}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
