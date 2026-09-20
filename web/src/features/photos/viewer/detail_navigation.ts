import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { type Triage } from '../../../../../src/schemas/photos';
import { useIsTouch } from '../../../app/device';
import { useListingStore, usePresenters, useViewerStore } from '../../../app/stores_context';
import { photoPath } from '../photos_store';
import type { ViewerStore } from './viewer_store';

// Stepping to a neighbour, which the bar's buttons, the arrow keys and a swipe
// all ask for. Stable, and the neighbour is read when the step is taken rather
// than when the handler was made, so nothing here re-renders or re-subscribes as
// the collection shifts around the open photo.
export function useStep(): (step: 'next' | 'prev') => void {
  const listing = useListingStore();
  const store = useViewerStore();
  const navigate = useNavigate();
  const touch = useIsTouch();
  return useCallback(
    (step: 'next' | 'prev') => {
      const id = step === 'next' ? store.nextPhotoId : store.prevPhotoId;
      // A finger leaves the viewer by the back gesture, so the whole run stays on
      // the one entry the collection pushed: an entry per photograph is a run to
      // walk back out of, each frame of it rendered on the way. A mouse has a Back
      // button and no gesture, so there a step keeps pushing.
      if (id != null) navigate(photoPath(id, listing.source), { replace: touch });
    },
    [store, navigate, touch],
  );
}

// Judging a frame in the viewer is one gesture of a cull - decide, and look at
// the next one - so a verdict steps on by itself, from the buttons and from the
// keys alike. Clearing back to undecided does not: that is a correction to the
// photo on screen, and walking away from it would be the wrong answer.
export function useJudge(photoId: string): (verdict: Triage) => void {
  const { photos } = usePresenters();
  const step = useStep();
  return useCallback(
    (verdict: Triage) => {
      void photos.setTriage(photoId, verdict);
      photos.holdVerdict(verdict === 'untriaged' ? null : verdict);
      if (verdict !== 'untriaged') step('next');
    },
    [photos, photoId, step],
  );
}

// What a photograph is called, for the bar and for the frames drawn of it. Off whichever
// row the client is holding, so it answers for a neighbour as well as for the open one -
// the stage mounts several photographs at once, and one name for all of them announced
// each of them as the one being looked at.
export function nameOf(store: ViewerStore, photoId: string): string {
  return store.photoFor(photoId)?.file_path?.split('/').pop() ?? photoId;
}
