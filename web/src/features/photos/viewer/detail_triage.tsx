import { observer } from 'mobx-react-lite';
import { useViewerStore } from '../../../app/stores_context';
import { TriageControl } from '../stack_triage/triage_control';
import { useJudge } from './detail_navigation';

// The verdict and the rating, both off the grid row: they are right from the
// first frame and stay hittable while the detail is in flight, and judging a
// photo re-renders nothing but the one of these that changed.
export const PhotoTriage = observer(function PhotoTriage({
  photoId,
  stretch = false,
}: {
  photoId: string;
  stretch?: boolean;
}): JSX.Element {
  const store = useViewerStore();
  const judge = useJudge(photoId);

  return (
    <TriageControl
      stretch={stretch}
      value={store.photoFor(photoId)?.triage ?? 'untriaged'}
      held={store.heldVerdict}
      onChange={judge}
    />
  );
});
