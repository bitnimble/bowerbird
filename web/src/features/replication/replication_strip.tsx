import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { HardDriveDownload, HardDriveUpload } from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import { Button } from '../../ui/button';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import { Spacer } from '../../ui/row';
import { StatusDot, Strip, StripLabel } from '../../ui/strip';
import { color } from '../../ui/tokens.stylex';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import type { ReplicationPresenter } from './replication_presenter';
import { ReplicationStripStrings } from './replication_strip.strings';
import type { ReplicationStore } from './replication_store';

const styles = stylex.create({
  peer: {
    paddingBlock: '4px',
    borderTopWidth: { default: '1px', ':first-child': 0 },
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
});

// One line per peer, in the shape the scan strip set: a dot, a mono label, and
// the two transfer actions the topology allows from here (§6.4 - fetch works
// only from peers that listen, so both directions of bytes are driven from this
// side). A library with no peers renders nothing at all (§10).
export const ReplicationStrip = observer(function ReplicationStrip({
  library,
  store,
  presenter,
}: {
  library: Library;
  store: ReplicationStore;
  presenter: ReplicationPresenter;
}): JSX.Element | null {
  const peers = store.peersOf(library.id);
  const hasPeers = peers.length > 0;
  const keepsOriginals = store.syncsOriginals(library.id);

  useEffect(() => {
    if (hasPeers) void presenter.refreshTransfers();
  }, [hasPeers, presenter]);

  if (!hasPeers) return null;

  return (
    <>
      {peers.map((peer) => {
        const transfers = store.transfersOf(library.id).filter((t) => t.peer_id === peer.peer_id);
        const moving = transfers.filter((t) => t.state === 'active' || t.state === 'queued');
        const sending = moving.filter((t) => t.direction === 'push').length;
        const fetching = moving.filter((t) => t.direction === 'pull').length;
        const failed = transfers.filter((t) => t.state === 'failed').length;

        return (
          <Strip style={styles.peer} key={peer.peer_id}>
            <StatusDot state={moving.length > 0 ? 'working' : 'idle'} />
            <StripLabel tone={peer.last_error == null ? undefined : 'error'} title={peer.last_error ?? undefined}>
              {ReplicationStripStrings.deviceLine(
                peer.name,
                peer.last_replicated_at == null ?
                  ReplicationStripStrings.neverSynced()
                : ReplicationStripStrings.syncedAt(relativeTime(peer.last_replicated_at)),
              )}
              {peer.last_error != null && ReplicationStripStrings.deviceError(peer.last_error)}
              {sending > 0 && ReplicationStripStrings.sending(sending)}
              {fetching > 0 && ReplicationStripStrings.fetching(fetching)}
              {failed > 0 && ReplicationStripStrings.failed(failed)}
            </StripLabel>
            <Spacer />
            {/* Both actions are about bytes, and either end can have said it does
                not keep them (§7.10). Disabled rather than hidden: an action that
                vanishes reads as one this reader failed to find. */}
            <Button
              variant="ghost"
              disabled={!peer.wants_originals}
              title={
                peer.wants_originals ?
                  ReplicationStripStrings.sendOriginalsTitle(peer.name)
                : ReplicationStripStrings.sendOriginalsRefused(peer.name)
              }
              onClick={() => void presenter.sendMissing(library.id, peer.peer_id)}
            >
              <HardDriveUpload size={ICON} />
              {ReplicationStripStrings.sendOriginals()}
            </Button>
            <Button
              variant="ghost"
              disabled={library.read_only || !keepsOriginals}
              title={
                library.read_only ? BulkBarStrings.notOnReadOnlyLibrary()
                : keepsOriginals ? ReplicationStripStrings.fetchOriginalsTitle(peer.name)
                : ReplicationStripStrings.fetchOriginalsRefused()
              }
              onClick={() => void presenter.fetchMissing(library.id, peer.peer_id)}
            >
              <HardDriveDownload size={ICON} />
              {ReplicationStripStrings.fetchOriginals()}
            </Button>
            <Button
              variant="ghost"
              title={ReplicationStripStrings.stopSyncingTitle(peer.name)}
              onClick={() =>
                void presenter.forget(library.id, peer.peer_id, (sole) =>
                  window.confirm(ReplicationStripStrings.stopSyncingWarning(library.name, peer.name, sole)),
                )
              }
            >
              {ReplicationStripStrings.stopSyncing()}
            </Button>
          </Strip>
        );
      })}
    </>
  );
});
