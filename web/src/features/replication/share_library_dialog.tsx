import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Copy } from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { Field } from '../../ui/field';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { Row, Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { PhotoDetailStrings } from '../photos/viewer/photo_detail_page.strings';
import { ShareLibraryStrings } from './share_library_dialog.strings';

// Where to reach this device (§9.1). Nothing is issued and nothing is recorded:
// the other device asks what is here and picks, so all this screen has to do is
// say which address to type. The network is the boundary (§11.1).
export const ShareLibraryDialog = observer(function ShareLibraryDialog({
  library,
  open,
  onOpenChange,
}: {
  library: Library;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const store = useReplicationStore();
  const { replication } = usePresenters();

  useEffect(() => {
    if (open) void replication.loadReachable();
  }, [open, replication]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={ShareLibraryStrings.title(library.name)}>
      <DialogBody>
        <Text as="p">{ShareLibraryStrings.instructions()}</Text>

        <Field>
          <Text variant="label" as="span">
            {ShareLibraryStrings.addressOfThisDevice()}
          </Text>
          {store.reachable.length === 0 ? (
            <Text variant="mono" as="p">
              {ShareLibraryStrings.workingItOut()}
            </Text>
          ) : (
            store.reachable.map((address) => (
              <Row key={address.url}>
                <Text variant="mono">{address.url}</Text>
                {address.kind === 'interface' && <Text variant="muted">{ShareLibraryStrings.ifReachable()}</Text>}
                <Spacer />
                <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(address.url)}>
                  <Copy size={ICON} />
                  {ShareLibraryStrings.copy()}
                </Button>
              </Row>
            ))
          )}
          {/* The first is the address this browser is on, so it is the one known
              to work; the rest are assembled from this machine's own interfaces
              and are guesses, which in a container are usually its own private
              network rather than anything another device can reach. */}
          <Text variant="mono" as="p">
            {ShareLibraryStrings.whichAddress()}
          </Text>
        </Field>

        <DialogActions>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {PhotoDetailStrings.done()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
