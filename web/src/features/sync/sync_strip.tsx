import { observer } from 'mobx-react-lite';
import { useSyncStore } from '../../app/stores_context';

// Cap the cells so a 50k-photo import doesn't render 50k nodes; past that the
// strip reads as a proportion bar and the mono count carries the exact figure.
const MAX_CELLS = 48;

export const SyncStrip = observer(function SyncStrip(): JSX.Element | null {
  const sync = useSyncStore();
  const status = sync.status;
  if (status == null) return null;

  const queued = status.photos_processing + status.photos_processed;
  const cells = Math.min(queued, MAX_CELLS);
  const doneCells = queued === 0 ? 0 : Math.round((status.photos_processed / queued) * cells);

  return (
    <div className="strip">
      <span className={`status-dot status-dot--${status.status}`} aria-hidden="true" />
      {cells > 0 && (
        <div className="strip__cells" role="img" aria-label={`${status.photos_processed} of ${queued} thumbnails built`}>
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
        {queued > 0 && ` · ${status.photos_processed}/${queued} thumbnails`}
        {status.photos_scanned > 0 && ` · ${status.photos_scanned} scanned`}
        {status.photos_added > 0 && ` · +${status.photos_added}`}
        {status.photos_moved > 0 && ` · ${status.photos_moved} moved`}
        {status.photos_removed > 0 && ` · ${status.photos_removed} missing`}
      </span>
    </div>
  );
});
