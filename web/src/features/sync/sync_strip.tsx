import { observer } from 'mobx-react-lite';
import { useSyncStore } from '../../app/stores_context';

// Cap the cells so a 50k-photo import doesn't render 50k nodes; past that the
// strip reads as a proportion bar and the mono count carries the exact figure.
const MAX_CELLS = 48;

export const SyncStrip = observer(function SyncStrip(): JSX.Element | null {
  const sync = useSyncStore();
  const status = sync.status;
  if (status == null) return null;

  // The scan reports its own progress (§9.6), so the same strip covers both
  // phases of a run rather than sitting empty through the first one.
  const progress = sync.progress;
  const cells = progress == null ? 0 : Math.min(progress.total, MAX_CELLS);
  const doneCells = progress == null ? 0 : Math.round((progress.done / progress.total) * cells);
  // The tallies are what the scan concluded, so they only mean anything once it has.
  const scanning = status.status === 'scanning';

  return (
    <div className="strip">
      <span className={`status-dot status-dot--${status.status}`} aria-hidden="true" />
      {progress != null && cells > 0 && (
        <div className="strip__cells" role="img" aria-label={`${progress.done} of ${progress.total} ${progress.noun}`}>
          {Array.from({ length: cells }, (_, i) => (
            <span
              key={i}
              className={`strip__cell${i < doneCells ? ' strip__cell--done' : i === doneCells && sync.isBusy ? ' strip__cell--active' : ''}`}
            />
          ))}
        </div>
      )}
      <span className="strip__label">
        {sync.label}
        {progress != null && ` · ${progress.done}/${progress.total} ${progress.noun}`}
        {/* What an idle library still owes, which is not nothing after a stopped
            or killed import. Said rather than drawn: a bar would read as a run
            in progress. A sync is what picks the work back up. */}
        {status.status === 'idle' && status.photos_processing > 0 && ` · ${status.photos_processing} renditions outstanding`}
        {!scanning && status.photos_scanned > 0 && ` · ${status.photos_scanned} scanned`}
        {!scanning && status.photos_added > 0 && ` · +${status.photos_added}`}
        {!scanning && status.photos_moved > 0 && ` · ${status.photos_moved} moved`}
        {!scanning && status.photos_removed > 0 && ` · ${status.photos_removed} missing`}
      </span>
    </div>
  );
});
