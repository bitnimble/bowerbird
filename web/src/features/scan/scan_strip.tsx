import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import {
  type Library,
  type LibraryScanStatus,
  PROCESSING_WORK_KINDS,
} from '../../../../src/schemas/libraries';
import type { ActivityKind, Activity as ServerActivity } from '../../../../src/schemas/activity';
import { ActivityStrings } from '../activity/activity.strings';
import { ActivityStrips, Pace } from '../activity/activity_strips';
import { queueKind, rateKey } from '../libraries/remaining_rates';
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
const BACKUP_WORK: ReadonlySet<ActivityKind> = new Set(['backing_up', 'restoring_backup']);
const NO_RATES: ReadonlyMap<string, number> = new Map();

export const ScanStrip = observer(function ScanStrip({
  library,
  status: current,
  activities,
  rates = NO_RATES,
}: {
  library: Library;
  status?: LibraryScanStatus;
  activities?: readonly ServerActivity[];
  rates?: ReadonlyMap<string, number>;
}): JSX.Element | null {
  const scan = useScanStore();
  const reported = current ?? (scan.libraryId === library.id ? scan.status : null);
  const status = reported?.status === 'processing' ? reported : null;
  const processing = reported?.photos_processing ?? 0;
  const moving = useMoving(library.id);
  const backupStripShown = useBackupStore().statusOf(library.id)?.configured === true;
  const serverActivity = activities?.filter(
    (activity) =>
      activity.kind !== 'rendering' && !(backupStripShown && BACKUP_WORK.has(activity.kind)),
  );
  if (status == null && processing === 0 && (serverActivity?.length ?? moving.length) === 0)
    return null;

  const progress =
    status == null || status.photos_to_scan === 0
      ? null
      : {
          done: status.photos_scanned,
          total: status.photos_to_scan,
        };
  const cells = progress == null ? 0 : Math.min(progress.total, MAX_CELLS);
  const doneCells = progress == null ? 0 : Math.round((progress.done / progress.total) * cells);
  const rate = scan.libraryId === library.id ? scan.rate : (status?.photos_per_second ?? null);
  const secondsLeft =
    progress == null || rate == null || rate <= 0 ? null : (progress.total - progress.done) / rate;

  return (
    <>
      {status != null && (
        <Strip>
          <StatusDot state="processing" />
          {progress != null && cells > 0 && (
            <div
              {...stylex.props(styles.cells)}
              role="img"
              aria-label={ScanStripStrings.cellsLabel(progress.done, progress.total)}
            >
              {Array.from({ length: cells }, (_, i) => (
                <span
                  key={i}
                  {...stylex.props(
                    styles.cell,
                    i < doneCells && styles.done,
                    i === doneCells && styles.active,
                  )}
                />
              ))}
            </div>
          )}
          <StripLabel>
            {scan.isStopping(library.id)
              ? ScanStripStrings.stopping()
              : ScanStripStrings.scanning(status.photos_to_scan > 0)}
            {progress != null && ScanStripStrings.count(progress.done, progress.total)}
            {rate != null && ScanStripStrings.rate(rate.toFixed(1))}
            {secondsLeft != null &&
              secondsLeft > 0 &&
              ActivityStrings.left(durationLabel(secondsLeft))}
          </StripLabel>
        </Strip>
      )}
      {serverActivity != null ? (
        <ActivityStrips activities={serverActivity} libraryId={library.id} rates={rates} />
      ) : (
        moving.map(({ kind, text }) => (
          <Strip key={kind}>
            <StatusDot state="working" />
            <StripLabel>{text}</StripLabel>
          </Strip>
        ))
      )}
      {PROCESSING_WORK_KINDS.map((kind) => {
        const count = reported?.processing_work[kind] ?? 0;
        return (
          count > 0 && (
            <Strip key={kind}>
              <StatusDot state="working" />
              <StripLabel>
                {ScanStripStrings[kind](count)}
                <Pace remaining={count} rate={rates.get(rateKey(library.id, queueKind(kind)))} />
              </StripLabel>
            </Strip>
          )
        );
      })}
    </>
  );
});

type Activity = { kind: 'syncing' | 'fetching' | 'sending'; text: string };

function useMoving(libraryId: string): Activity[] {
  const replication = useReplicationStore();
  const backup = useBackupStore().statusOf(libraryId);
  const backupPeer = backup?.configured === true ? backup.peer_id : null;
  const inFlight = replication
    .transfersOf(libraryId)
    .filter((t) => t.peer_id !== backupPeer && (t.state === 'queued' || t.state === 'active'));
  const fetching = inFlight.some((t) => t.direction === 'pull');
  const sending = inFlight.filter((t) => t.direction === 'push').length;
  const activities: Activity[] = [];
  if (replication.replicating === libraryId)
    activities.push({ kind: 'syncing', text: ScanStripStrings.syncing() });
  if (fetching) activities.push({ kind: 'fetching', text: ScanStripStrings.fetching() });
  if (sending > 0) activities.push({ kind: 'sending', text: ScanStripStrings.sending(sending) });
  return activities;
}
