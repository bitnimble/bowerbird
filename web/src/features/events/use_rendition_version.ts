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
// Held here rather than in a store because its life is the view's: a version for
// a photo nobody is looking at buys nothing, and a store of them would grow with
// every photo an import touches and need a cap and an eviction rule to stand in
// for what unmounting does for free. Losing one costs a revalidation and nothing
// else - the plain URL still carries an ETag (§13.5).
export function useRenditionVersion(photoId: string | null): number {
  const { events } = usePresenters();
  // Paired with the photo it belongs to, so the render between a new id arriving
  // and the effect that subscribes for it does not spend the last photo's
  // version on this one's URL.
  const [rebuilt, setRebuilt] = useState<{ photoId: string; at: number } | null>(null);

  useEffect(() => {
    if (photoId == null) return;
    return events.watch(photoId, () => setRebuilt({ photoId, at: Date.now() }));
  }, [events, photoId]);

  return rebuilt?.photoId === photoId ? rebuilt.at : 0;
}
