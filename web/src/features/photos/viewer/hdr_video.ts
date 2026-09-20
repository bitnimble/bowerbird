import { hdrVideoUrl, needsHdrVideo } from 'avif-hdr-video';
import { useEffect, useState } from 'react';

// Firefox composites HDR for video and only video, so an HDR AVIF renders there as a
// washed-out picture rather than not at all. The fix is a container away - the same AV1
// frame in an MP4 goes down the video path - and it is done here rather than by the server,
// which would mean a second file stored per photo for one browser to read (DESIGN 10.7).
//
// `avif-hdr-video` also ships an `install()` that swaps `<img>` for `<video>` on its
// own. Not used here: React owns these nodes, and the stage already knows how to show a
// video, so all this needs from the package is the URL.

// Every twin made, by the owner it belongs to and the still it was rewrapped from. Held
// rather than made per ask: a twin is the whole AVIF fetched again and rewrapped, so
// rebuilding one costs a reader flipping between a render and the camera's JPEG that much
// on every press - tens of megabytes each way on a native-resolution rendition, which is
// long enough that the stage reads as one that will not move.
const twins = new Map<string, string>();

// How many mounted views each owner has. An MP4 is resident whole for as long as its URL
// is alive, so what an owner made goes the moment nothing is asking for it - the viewer
// stepping to the next photograph, or the demo page unmounting a comparison.
const asking = new Map<string, number>();

function retain(owner: string): void {
  asking.set(owner, (asking.get(owner) ?? 0) + 1);
}

function release(owner: string): void {
  const left = (asking.get(owner) ?? 0) - 1;
  if (left > 0) {
    asking.set(owner, left);
    return;
  }
  asking.delete(owner);
  for (const [key, twin] of twins) {
    if (!key.startsWith(`${owner}:`)) continue;
    URL.revokeObjectURL(twin);
    twins.delete(key);
  }
}

/** A rewrapped still: the file it was made from, and the MP4 standing in for it. */
export interface HdrTwin {
  still: string;
  url: string;
}

/**
 * The MP4 twin of `source`, or null while there is nothing to show through one - the wrong
 * browser, an SDR rendition, or bytes still in flight.
 *
 * **It names the still it was made from**, and a caller may only put it in that file's
 * place. This is state, so it lags the rendition being asked for by a render: substituted
 * for whatever is on screen at the time, a twin that has not caught up stands in for the
 * *next* rendition - the camera's JPEG drawn from the render's video, under a picker that
 * has already moved - and nothing later in the chain can tell that from the truth.
 *
 * `owner` is what the twin is kept alive by: the photograph in the viewer, the comparison
 * on the HDR page. Both of one owner's stills are held at once, which is what makes the
 * flip between them free, and all of them go when the last view of that owner unmounts.
 */
export function useHdrVideo(owner: string, source: string, hdr: boolean): HdrTwin | null {
  const [url, setUrl] = useState<HdrTwin | null>(null);

  useEffect(() => {
    retain(owner);
    return () => release(owner);
  }, [owner]);

  useEffect(() => {
    if (!hdr || !needsHdrVideo()) {
      setUrl(null);
      return;
    }
    const key = `${owner}:${source}`;
    const already = twins.get(key);
    if (already != null) {
      setUrl({ still: source, url: already });
      return;
    }
    let live = true;
    void hdrVideoUrl(source)
      .then((twin) => {
        if (twin == null) {
          if (live) setUrl(null);
          return;
        }
        // Nothing is holding this owner any more and `release` has already swept: it ran
        // while this was in flight, so the map it emptied never held this one and nothing
        // would revoke it. A whole MP4, resident until the tab goes.
        if (!asking.has(owner)) {
          URL.revokeObjectURL(twin);
          return;
        }
        // Kept even where the view has moved off this still: it moved off by a keypress that
        // comes straight back here, and `release` is what bounds that.
        twins.set(key, twin);
        if (live) setUrl({ still: source, url: twin });
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
      setUrl(null);
    };
  }, [owner, source, hdr]);

  return url;
}
