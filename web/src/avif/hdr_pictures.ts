import { hdrMp4, hdrVideoSdrMatch, needsHdrVideo } from 'avif-hdr-video';
import type { SdrMatch } from '../../../src/schemas/sdr_match';

/** A still that may be an HDR AVIF, and its 10-bit 4:2:0 copy coded to each `SdrMatch`. */
export interface HdrSource {
  still: string;
  tenBit: (match: SdrMatch) => string;
}

/**
 * Which file the page fetches for every picture that may be an HDR AVIF, and whether it shows
 * as a video (DESIGN §10.7.2). On Firefox the still is fetched only for its pixels, never to show.
 */
export class HdrPictures {
  private readonly plain = new Set<string>();
  private readonly shown = new Map<string, number>();

  constructor(
    readonly throughVideo: boolean = needsHdrVideo(),
    private readonly match: SdrMatch = hdrVideoSdrMatch(),
    // A closure: bare `fetch` called as `this.fetcher(...)` throws "Illegal invocation".
    private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response> = (
      url,
      init,
    ) => fetch(url, init),
  ) {}

  /** The file fetched to show `source`. */
  shownFile(source: HdrSource): string {
    return this.throughVideo ? source.tenBit(this.match) : source.still;
  }

  /** The file to decode `source`'s pixels from. */
  pixelFile(source: HdrSource): string {
    const shown = this.shownFile(source);
    // A copy's SDR range is coded to how this platform shows video, so its pixels are not the
    // still's; a copy found not to be HDR is the file itself, already fetched.
    return this.plain.has(shown) ? shown : source.still;
  }

  /**
   * An object URL for the MP4 standing in for `source`, to hand back to `release`; null where the
   * page shows the file itself.
   */
  async video(source: HdrSource, init?: RequestInit): Promise<string | null> {
    if (!this.throughVideo) return null;
    const file = this.shownFile(source);
    const response = await this.fetcher(file, init);
    if (!response.ok) throw new Error(`${response.status} for ${file}`);
    const mp4 = rewrapped(new Uint8Array(await response.arrayBuffer()));
    if (mp4 == null) {
      this.plain.add(file);
      return null;
    }
    this.shown.set(file, (this.shown.get(file) ?? 0) + 1);
    return URL.createObjectURL(new Blob([mp4], { type: 'video/mp4' }));
  }

  /** Whether a video of `source` is on the page. */
  isShown(source: HdrSource): boolean {
    return this.shown.has(this.shownFile(source));
  }

  release(source: HdrSource, url: string): void {
    URL.revokeObjectURL(url);
    const file = this.shownFile(source);
    const left = (this.shown.get(file) ?? 1) - 1;
    if (left > 0) this.shown.set(file, left);
    else this.shown.delete(file);
  }
}

function rewrapped(file: Uint8Array): Uint8Array<ArrayBuffer> | null {
  try {
    return hdrMp4(file);
  } catch {
    // Not a single-frame AVIF: a JPEG rendition, served whole for its copy.
    return null;
  }
}

export const hdrPictures = new HdrPictures();
