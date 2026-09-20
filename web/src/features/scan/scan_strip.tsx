import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useScanStore } from '../../app/stores_context';
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

export const ScanStrip = observer(function ScanStrip(): JSX.Element | null {
  const scan = useScanStore();
  const status = scan.status;
  if (status == null) return null;

  // The scan reports its own progress (§9.6), so the same strip covers both
  // phases of a run rather than sitting empty through the first one.
  const progress = scan.progress;
  const cells = progress == null ? 0 : Math.min(progress.total, MAX_CELLS);
  const doneCells = progress == null ? 0 : Math.round((progress.done / progress.total) * cells);
  // The tallies are what the scan concluded, so they only mean anything once it has.
  const settled = status.status !== 'processing';

  return (
    <Strip>
      <StatusDot state={status.status === 'rendition' ? 'working' : status.status} />
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
        {ScanStripStrings.status(status.status)}
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
      </StripLabel>
    </Strip>
  );
});
