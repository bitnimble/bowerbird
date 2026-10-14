import { hdrVideoUrl, needsHdrVideo } from 'avif-hdr-video';
import { useCallback, useEffect, useState } from 'react';

/** A rewrapped still: the file it was made from, and the MP4 standing in for it. */
export interface HdrTwin {
  still: string;
  url: string;
}

/**
 * Firefox's MP4 twins of HDR stills (DESIGN 10.7.2), held per owner - the photo in the viewer, a
 * comparison on the HDR page - until the last view of that owner unmounts.
 */
export class HdrTwins {
  private readonly twins = new Map<string, HdrTwin[]>();
  private readonly failed = new Map<string, Set<string>>();
  private readonly asking = new Map<string, number>();

  constructor(
    readonly rewrap: (source: string, init?: RequestInit) => Promise<string | null> = hdrVideoUrl,
    readonly needed: () => boolean = needsHdrVideo,
  ) {}

  retain(owner: string): void {
    this.asking.set(owner, (this.asking.get(owner) ?? 0) + 1);
  }

  release(owner: string): void {
    const left = (this.asking.get(owner) ?? 0) - 1;
    if (left > 0) {
      this.asking.set(owner, left);
      return;
    }
    this.asking.delete(owner);
    this.failed.delete(owner);
    for (const twin of this.twins.get(owner) ?? []) URL.revokeObjectURL(twin.url);
    this.twins.delete(owner);
  }

  held(owner: string, still: string): HdrTwin | null {
    return this.twins.get(owner)?.find((twin) => twin.still === still) ?? null;
  }

  hasFailed(owner: string, still: string): boolean {
    return this.failed.get(owner)?.has(still) === true;
  }

  /** Keeps `twin`, dropping any of an older version of its still; false where nothing holds `owner`. */
  keep(owner: string, twin: HdrTwin): boolean {
    if (!this.asking.has(owner)) {
      URL.revokeObjectURL(twin.url);
      return false;
    }
    const file = fileOf(twin.still);
    const kept = (this.twins.get(owner) ?? []).filter((each) => {
      if (fileOf(each.still) !== file) return true;
      URL.revokeObjectURL(each.url);
      return false;
    });
    this.twins.set(owner, [...kept, twin]);
    return true;
  }

  /** A twin that would not play: dropped, and not made again while `owner` is held. */
  fail(owner: string, still: string): void {
    const twin = this.held(owner, still);
    if (twin != null) {
      URL.revokeObjectURL(twin.url);
      this.twins.set(
        owner,
        (this.twins.get(owner) ?? []).filter((each) => each !== twin),
      );
    }
    const failed = this.failed.get(owner) ?? new Set();
    failed.add(still);
    this.failed.set(owner, failed);
  }
}

export const hdrTwins = new HdrTwins();

function fileOf(still: string): string {
  return still.split('?')[0] ?? still;
}

/**
 * Has the server make these 10-bit copies before the reader steps onto them, on Firefox: the
 * first ask for one is an encode, which the dark still would otherwise sit in front of.
 */
export function useTenBitCopiesAhead(
  tenBitSources: readonly string[],
  twins: HdrTwins = hdrTwins,
): void {
  const key = tenBitSources.join('\n');
  useEffect(() => {
    if (key === '' || !twins.needed()) return;
    // HEAD: the server builds the copy to answer it, and no bytes cross until they are shown.
    for (const url of key.split('\n')) void fetch(url, { method: 'HEAD' }).catch(() => undefined);
  }, [key, twins]);
}

/**
 * The MP4 twin of `source`, rewrapped from `tenBitSource`, or null while there is nothing to
 * show through one: the wrong browser, an SDR rendition, bytes in flight, or a twin that failed.
 * `failed` is for a twin that will not play, and puts the still back.
 *
 * **It names the still it was made from**, and a caller may only put it in that file's place:
 * it lags the rendition being asked for by a render.
 */
export function useHdrVideo(
  owner: string,
  source: string,
  tenBitSource: string,
  hdr: boolean,
  twins: HdrTwins = hdrTwins,
): { twin: HdrTwin | null; failed: () => void } {
  const [twin, setTwin] = useState<HdrTwin | null>(null);

  useEffect(() => {
    twins.retain(owner);
    return () => twins.release(owner);
  }, [owner, twins]);

  useEffect(() => {
    if (!hdr || !twins.needed() || twins.hasFailed(owner, source)) {
      setTwin(null);
      return;
    }
    const already = twins.held(owner, source);
    if (already != null) {
      setTwin(already);
      return;
    }
    const abort = new AbortController();
    void twins
      .rewrap(tenBitSource, { signal: abort.signal })
      .then((url) => {
        if (url == null) {
          if (!abort.signal.aborted) setTwin(null);
          return;
        }
        const made = { still: source, url };
        // Kept even where the view has moved off this still: it moved off by a keypress that
        // comes straight back here, and `release` is what bounds that.
        if (twins.keep(owner, made) && !abort.signal.aborted) setTwin(made);
      })
      .catch(() => {
        if (!abort.signal.aborted) setTwin(null);
      });
    return () => {
      abort.abort();
      setTwin(null);
    };
  }, [owner, source, tenBitSource, hdr, twins]);

  const failed = useCallback(() => {
    twins.fail(owner, source);
    setTwin(null);
  }, [owner, source, twins]);

  return { twin, failed };
}
