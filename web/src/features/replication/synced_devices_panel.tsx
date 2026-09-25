import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { RefreshCw, Share2 } from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import { ReplicationStrip } from './replication_strip';
import { ShareLibraryDialog } from './share_library_dialog';
import { SyncedDevicesStrings } from './synced_devices_panel.strings';

// Which devices sync this library, what this one keeps of it (§7.10), and the
// way to add another.
export const SyncedDevicesPanel = observer(function SyncedDevicesPanel({
  library,
}: {
  library: Library;
}): JSX.Element {
  const store = useReplicationStore();
  const { replication } = usePresenters();
  const [sharing, setSharing] = useState(false);
  const syncing = store.replicating === library.id;
  const readOnlyRefusal = library.read_only ? BulkBarStrings.notOnReadOnlyLibrary() : undefined;

  return (
    <Panel title={SyncedDevicesStrings.heading()}>
      <ReplicationStrip library={library} store={store} presenter={replication} />

      {store.peersOf(library.id).length === 0 && (
        <Text variant="muted" as="p">
          {SyncedDevicesStrings.onThisDeviceOnly()}
        </Text>
      )}

      {/* §7.10. Only where there is another device to hold them: on a library
          nobody else has, "don't keep the RAWs" names nowhere for them to be. */}
      {store.hasPeers(library.id) && (
        <Row as="label">
          <input
            {...stylex.props(focusRing.ring)}
            type="checkbox"
            aria-label={SyncedDevicesStrings.keepOriginalsOnThisDevice()}
            checked={store.syncsOriginals(library.id)}
            onChange={(e) => void replication.setSyncOriginals(library.id, e.currentTarget.checked)}
          />
          <Text as="span">{SyncedDevicesStrings.keepOriginalsOnThisDevice()}</Text>
          {/* What is true now, in the same words the add dialog uses: a hint that
              describes the *other* state reads as a description of this one. */}
          <Text variant="muted" as="span">
            {store.syncsOriginals(library.id) ? SyncedDevicesStrings.keepsOriginals() : SyncedDevicesStrings.catalogueOnly()}
          </Text>
        </Row>
      )}

      <Row>
        <Button disabled={library.read_only} tooltip={readOnlyRefusal} onClick={() => setSharing(true)}>
          <Share2 size={ICON} />
          {SyncedDevicesStrings.syncToAnotherDevice()}
        </Button>
        <Spacer />
        {store.hasPeers(library.id) && (
          <Button
            disabled={syncing || library.read_only}
            tooltip={readOnlyRefusal}
            onClick={() => void replication.replicate(library.id)}
          >
            <RefreshCw size={ICON} />
            {syncing ? SyncedDevicesStrings.syncing() : SyncedDevicesStrings.syncNow()}
          </Button>
        )}
      </Row>
      <ShareLibraryDialog library={library} open={sharing} onOpenChange={setSharing} />
    </Panel>
  );
});
