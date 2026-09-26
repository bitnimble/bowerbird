import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { type Library } from '../../../../src/schemas/libraries';
import { useBackupStore, useReplicationStore, useScanStore } from '../../app/stores_context';
import { durationLabel } from '../../ui/format';
import { StatusDot, Strip, StripLabel } from '../../ui/strip';
import { color } from '../../ui/tokens.stylex';
import { ScanStripStrings } from './scan_strip.strings';

const pulse = stylex.keyframes({ '50%': { opacity: 0.35 } });

const styles = stylex.create({
  cells: {
    display: 'flex',
    gap: '2px',
  },
  cell: {
    width: '5px',
    height: '14px',
    backgroundColor: color.slate,
  },
  done: {
    backgroundColor: color.satin,
  },
  active: {
    backgroundColor: color.glass,
    animationName: pulse,
    animationDuration: '1s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
});

// Cap the cells so a 50k-photo import doesn't render 50k nodes; past that the
// strip reads as a proportion bar and the mono count carries the exact figure.
const MAX_CELLS = 48;

// One line for everything a library is doing in the background: its scan, and what it is
// exchanging with its devices and its backup.
export const ScanStrip = observer(function ScanStrip({ library }: { library: Library }): JSX.Element | null {
  const scan = useScanStore();
  const status = scan.libraryId === library.id ? scan.status : null;
  const moving = useMoving(library.id);
  if (status == null && moving.length === 0) return null;

  // The scan reports its own progress (§9.6), so the same strip covers both
  // phases of a run rather than sitting empty through the first one.
  const progress = status == null ? null : scan.progress;
  const cells = progress == null ? 0 : Math.min(progress.total, MAX_CELLS);
  const doneCells = progress == null ? 0 : Math.round((progress.done / progress.total) * cells);
  // The tallies are what the scan concluded, so they only mean anything once it has.
  const settled = status != null && status.status !== 'processing';
  const busy = status != null && status.status !== 'idle';

  return (
    <Strip>
      <StatusDot
        state={
          status?.status === 'processing' ? 'processing'
          : busy || moving.length > 0 ? 'working'
          : 'idle'
        }
      />
      {progress != null && cells > 0 && (
        <div
          {...stylex.props(styles.cells)}
          role="img"
          aria-label={ScanStripStrings.cellsLabel(progress.done, progress.total, progress.counting)}
        >
          {Array.from({ length: cells }, (_, i) => (
            <span
              key={i}
              {...stylex.props(
                styles.cell,
                i < doneCells && styles.done,
                i === doneCells && scan.isBusy && styles.active,
              )}
            />
          ))}
        </div>
      )}
      <StripLabel>
        {/* Idle says nothing a transfer in its place does not say better. */}
        {status != null && (busy || moving.length === 0) ?
          ScanStripStrings.status(status.status)
        : ScanStripStrings.moving(moving, false)}
        {status != null && (
          <>
            {progress != null && ScanStripStrings.count(progress.done, progress.total, progress.counting)}
            {progress != null && scan.rate != null && ScanStripStrings.rate(scan.rate.toFixed(1), progress.counting)}
            {scan.secondsLeft != null && ScanStripStrings.eta(durationLabel(scan.secondsLeft))}
            {/* What an idle library still owes, which is not nothing after a stopped
                or killed import. Said rather than drawn: a bar would read as a run
                in progress. A scan is what picks the work back up. */}
            {status.status === 'idle' && status.photos_processing > 0 && ScanStripStrings.outstanding(status.photos_processing)}
            {settled && status.photos_scanned > 0 && ScanStripStrings.scanned(status.photos_scanned)}
            {settled && status.photos_added > 0 && ScanStripStrings.added(status.photos_added)}
            {settled && status.photos_moved > 0 && ScanStripStrings.moved(status.photos_moved)}
            {settled && status.photos_removed > 0 && ScanStripStrings.missing(status.photos_removed)}
          </>
        )}
        {busy && moving.length > 0 && ScanStripStrings.moving(moving, true)}
      </StripLabel>
    </Strip>
  );
});

function useMoving(libraryId: string): string[] {
  const replication = useReplicationStore();
  const backup = useBackupStore();
  const backupPeer = backup.statusOf(libraryId)?.peer_id;
  const inFlight = replication
    .transfersOf(libraryId)
    .filter((t) => t.state === 'queued' || t.state === 'active');
  const fetching = inFlight.filter((t) => t.direction === 'pull').length;
  const sending = inFlight.filter((t) => t.direction === 'push' && t.peer_id !== backupPeer).length;
  const backingUp = inFlight.filter((t) => t.direction === 'push' && t.peer_id === backupPeer).length;
  return [
    ...(replication.replicating === libraryId ? [ScanStripStrings.syncing()] : []),
    ...(fetching > 0 ? [ScanStripStrings.fetching(fetching)]
    : backup.fetchingBack === libraryId ? [ScanStripStrings.fetchingFromBackup()]
    : []),
    ...(sending > 0 ? [ScanStripStrings.sending(sending)] : []),
    ...(backingUp > 0 ? [ScanStripStrings.backingUp(backingUp)]
    : backup.running === libraryId ? [ScanStripStrings.backingUpNow()]
    : []),
  ];
}
