import { hdrVideoUrl, needsHdrVideo } from 'avif-hdr-video';
import { useEffect, useState } from 'react';

// Firefox composites HDR for video and only video, so an HDR AVIF renders there as a
// washed-out picture rather than not at all. The fix is a container away - the same AV1
// frame in an MP4 goes down the video path - and it is done here rather than by the
// server, which used to encode a second file per photo for one browser to read
// (DESIGN 10.7).
//
// `avif-hdr-video` also ships an `install()` that swaps `<img>` for `<video>` on its
// own. Not used here: React owns these nodes, and the stage already knows how to show a
// video, so all this needs from the package is the URL.

/**
 * An object URL for the MP4 twin of `source`, or null while there is nothing to show
 * through one - the wrong browser, an SDR rendition, or bytes still in flight.
 *
 * Ephemeral view state, like the rest of what the stage holds locally: it belongs to the
 * element on screen and is revoked the moment that element points somewhere else, since
 * the whole MP4 is held in memory until it is.
 */
export function useHdrVideo(source: string, hdr: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hdr || !needsHdrVideo()) {
      setUrl(null);
      return;
    }
    let live = true;
    let made: string | null = null;
    void hdrVideoUrl(source)
      .then((twin) => {
        made = twin;
        // Revoked rather than shown: the photo moved on while the bytes were in flight.
        if (!live) return release(made);
        setUrl(twin);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
      setUrl(null);
      release(made);
    };
  }, [source, hdr]);

  return url;
}

function release(url: string | null): void {
  if (url != null) URL.revokeObjectURL(url);
}
