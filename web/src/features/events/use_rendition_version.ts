import { useEffect, useState } from 'react';
import { usePresenters } from '../../app/stores_context';

// What to append to a photo's rendition URLs so the browser fetches them again
// after the server has rewritten the files. 0 until this photo is known to have
// moved, which `renditionUrl` leaves out of the URL entirely.
//
// A remount is not enough on its own: three fresh <img> elements with the same
// src produce one network request between them, because the browser serves the
// later ones out of its in-memory resource cache without revalidating. The URL
// itself has to differ, and this is the part of it that differs.
//
// The value lives on the presenter, keyed by photo; this only subscribes to it,
// so that a view showing a photo re-renders when that photo is rebuilt and no
// view is woken by anyone else's.
export function useRenditionVersion(photoId: string | null): number {
  const { events } = usePresenters();
  const [, rebuilt] = useState(0);

  useEffect(() => {
    if (photoId == null) return;
    return events.watch(photoId, () => rebuilt((n) => n + 1));
  }, [events, photoId]);

  return photoId == null ? 0 : events.versionOf(photoId);
}
