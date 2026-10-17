import * as stylex from '@stylexjs/stylex';
import { PathSegment, route } from '../../../src/schemas/route';
import { sdrMatchSuffix } from '../../../src/schemas/sdr_match';
import { HdrPicture } from '../avif/hdr_picture';
import type { HdrSource } from '../avif/hdr_pictures';

const styles = stylex.create({
  pixel: {
    position: 'fixed',
    left: 0,
    bottom: 0,
    width: '1px',
    height: '1px',
    pointerEvents: 'none',
  },
});

/** The committed swatch strip (`scripts/demo-assets.ts`), 10-bit 4:2:0 already and so its own copy as a still. */
const SWATCHES: HdrSource = {
  still: route(PathSegment.hdr(), 'swatches.avif'),
  tenBit: (match) => route(PathSegment.hdr(), `swatches${sdrMatchSuffix(match)}.avif`),
};

/**
 * An HDR picture on screen for the life of the page, which is what keeps Chrome on Windows
 * presenting the window in HDR.
 */
export function HdrOutput(): JSX.Element {
  // Chrome only leaves SDR output while an HDR-tagged image is painted somewhere, and a WebGPU
  // canvas drawn from a worker does not count, so without this every stage and editor clips at
  // SDR white. Painted, not hidden: an unpainted image may not count either.
  return <HdrPicture source={SWATCHES} alt="" style={styles.pixel} />;
}
