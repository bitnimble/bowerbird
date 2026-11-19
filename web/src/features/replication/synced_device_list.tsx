import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { ArrowDownUp, Unlink } from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import { Button } from '../../ui/button';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import { List, ListBody, ListName, ListRow } from '../../ui/list';
import { StatusDot } from '../../ui/strip';
import { Text } from '../../ui/text';
import type { ConfirmPresenter } from '../confirm/confirm_presenter';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import type { ReplicationPresenter } from './replication_presenter';
import type { ReplicationStore } from './replication_store';
import { SyncedDeviceListStrings } from './synced_device_list.strings';

const styles = stylex.create({
  row: {
    flexWrap: 'wrap',
  },
  body: {
    flexBasis: '140px',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: '10px',
  },
  actions: {
    display: 'flex',
    gap: '4px',
    marginLeft: 'auto',
  },
});

export const SyncedDeviceList = observer(function SyncedDeviceList({
  library,
  store,
  presenter,
  confirm,
}: {
  library: Pick<Library, 'id' | 'name' | 'read_only'>;
  store: ReplicationStore;
  presenter: ReplicationPresenter;
  confirm: Pick<ConfirmPresenter, 'ask'>;
}): JSX.Element | null {
  const peers = store.peersOf(library.id);

  if (peers.length === 0) return null;

  const transfersHere = store.transfersOf(library.id);

  return (
    <List>
      {peers.map((peer) => {
        const transfers = transfersHere.filter((t) => t.peer_id === peer.peer_id);
        const moving = transfers.filter((t) => t.state === 'active' || t.state === 'queued');
        const sending = moving.filter((t) => t.direction === 'push').length;
        const fetching = moving.filter((t) => t.direction === 'pull').length;
        const failed = transfers.filter((t) => t.state === 'failed').length;
        const troubled = peer.last_error != null || peer.outdated != null;
        // Disabled rather than hidden: an action that vanishes reads as one this reader failed to find.
        const syncRefusal = !peer.reachable
          ? SyncedDeviceListStrings.cannotReach(peer.name)
          : library.read_only && !peer.wants_originals
            ? BulkBarStrings.libraryIsReadOnly()
            : undefined;

        return (
          <ListRow key={peer.peer_id} style={styles.row}>
            <StatusDot state={moving.length > 0 ? 'working' : 'idle'} />
            <ListBody style={styles.body}>
              <ListName>{peer.name}</ListName>
              <Text
                variant="mono"
                as="div"
                tone={troubled ? 'error' : undefined}
                tooltip={
                  peer.last_error != null && peer.outdated == null
                    ? SyncedDeviceListStrings.deviceErrorTitle()
                    : undefined
                }
              >
                {peer.last_replicated_at == null
                  ? SyncedDeviceListStrings.neverSynced()
                  : SyncedDeviceListStrings.syncedAt(relativeTime(peer.last_replicated_at))}
                {peer.outdated === 'peer'
                  ? SyncedDeviceListStrings.updatePeer(peer.name)
                  : peer.outdated === 'this_device'
                    ? SyncedDeviceListStrings.updateThisDevice()
                    : peer.last_error != null && SyncedDeviceListStrings.deviceError()}
                {sending > 0 && SyncedDeviceListStrings.sending(sending)}
                {fetching > 0 && SyncedDeviceListStrings.fetching(fetching)}
                {failed > 0 && SyncedDeviceListStrings.failed(failed)}
              </Text>
            </ListBody>
            <div {...stylex.props(styles.actions)}>
              <Button
                variant="ghost"
                disabled={syncRefusal != null}
                focusableWhenDisabled
                tooltip={syncRefusal ?? SyncedDeviceListStrings.syncRawsTitle()}
                onClick={() => void presenter.syncRaws(library, peer.peer_id)}
              >
                <ArrowDownUp size={ICON} />
                {SyncedDeviceListStrings.syncRaws()}
              </Button>
              <Button
                variant="ghost"
                tooltip={SyncedDeviceListStrings.removeDeviceTitle()}
                onClick={() =>
                  void presenter.forget(library.id, peer.peer_id, (sole) =>
                    confirm.ask({
                      title: SyncedDeviceListStrings.removeDeviceQuestion(library.name, peer.name),
                      body: SyncedDeviceListStrings.removeDeviceWarning(peer.name, sole),
                      action: SyncedDeviceListStrings.remove(),
                      tone: 'danger',
                    }),
                  )
                }
              >
                <Unlink size={ICON} />
                {SyncedDeviceListStrings.removeDevice()}
              </Button>
            </div>
          </ListRow>
        );
      })}
    </List>
  );
});
