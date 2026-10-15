import { PathSegment, route } from '../../../../src/schemas/route';
import { sdrMatchSuffix } from '../../../../src/schemas/sdr_match';
import type { HdrSource } from '../../avif/hdr_pictures';

/** A committed demo scene's HDR still and its 10-bit copies (`scripts/demo-assets.ts`). */
export function demoScene(slug: string): HdrSource {
  return {
    still: route(PathSegment.hdr(), `${slug}-hdr.avif`),
    tenBit: (match) => route(PathSegment.hdr(), `${slug}-hdr-10bit${sdrMatchSuffix(match)}.avif`),
  };
}

/** The swatch strip, which is 10-bit 4:2:0 already and so its own copy wherever it is coded as a still. */
export function demoSwatches(): HdrSource {
  return {
    still: route(PathSegment.hdr(), 'swatches.avif'),
    tenBit: (match) => route(PathSegment.hdr(), `swatches${sdrMatchSuffix(match)}.avif`),
  };
}
