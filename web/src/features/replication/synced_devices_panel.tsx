import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { type Library } from '../../../../src/schemas/libraries';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { isThinShell } from '../../app/thin_shell';
import { Panel } from '../../ui/panel';
import { Text } from '../../ui/text';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import { OriginalsChoice } from './originals_choice';
import { SyncedDeviceList } from './synced_device_list';
import { SyncedDevicesStrings } from './synced_devices_panel.strings';

const styles = stylex.create({
  originals: {
    paddingBlock: '8px',
  },
});

// Which devices sync this library, and what this one keeps of it (§7.10).
export const SyncedDevicesPanel = observer(function SyncedDevicesPanel({
  library,
}: {
  library: Pick<Library, 'id' | 'name' | 'read_only'>;
}): JSX.Element {
  const store = useReplicationStore();
  const { replication, confirm } = usePresenters();

  return (
    <Panel title={SyncedDevicesStrings.heading()}>
      <SyncedDeviceList library={library} store={store} presenter={replication} confirm={confirm} />

      {!store.hasPeers(library.id) && (
        <Text variant="muted" as="p">
          {SyncedDevicesStrings.onThisDeviceOnly()}
        </Text>
      )}

      {/* §7.10. Only where there is another device to hold them: on a library
          nobody else has, "don't keep the RAWs" names nowhere for them to be. */}
      {store.hasPeers(library.id) && !isThinShell() && (
        <div {...stylex.props(styles.originals)}>
          <OriginalsChoice
            keeps={store.syncsOriginals(library.id)}
            disabled={library.read_only}
            tooltip={library.read_only ? BulkBarStrings.libraryIsReadOnly() : undefined}
            onChange={(keeps) => void replication.setSyncOriginals(library.id, keeps)}
          />
        </div>
      )}
    </Panel>
  );
});
