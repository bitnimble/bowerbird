import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { type Library } from '../../../../src/schemas/libraries';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { focusRing } from '../../ui/focus_ring';
import { Panel } from '../../ui/panel';
import { Row } from '../../ui/row';
import { Text } from '../../ui/text';
import { ReplicationStrip } from './replication_strip';
import { SyncedDevicesStrings } from './synced_devices_panel.strings';

// Which devices sync this library, and what this one keeps of it (§7.10).
export const SyncedDevicesPanel = observer(function SyncedDevicesPanel({
  library,
}: {
  library: Library;
}): JSX.Element {
  const store = useReplicationStore();
  const { replication } = usePresenters();

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
        <>
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
          <Row as="label">
            <input
              {...stylex.props(focusRing.ring)}
              type="checkbox"
              aria-label={SyncedDevicesStrings.autoTransferOriginals()}
              checked={store.autoTransfersOriginals(library.id)}
              onChange={(e) => void replication.setAutoTransferOriginals(library.id, e.currentTarget.checked)}
            />
            <Text as="span">{SyncedDevicesStrings.autoTransferOriginals()}</Text>
          </Row>
        </>
      )}
    </Panel>
  );
});
