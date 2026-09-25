import * as stylex from '@stylexjs/stylex';
import { PathSegment, route } from '../../../src/schemas/route';

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

/**
 * A PQ image on screen for the life of the page, which is what keeps Chrome on Windows
 * presenting the window in HDR.
 */
export function HdrOutput(): JSX.Element {
  // Chrome only leaves SDR output while an HDR-tagged image is painted somewhere, and a WebGPU
  // canvas drawn from a worker does not count, so without this every stage and editor clips at
  // SDR white. Painted, not hidden: an unpainted image may not count either.
  return <img src={route(PathSegment.hdr(), 'swatches.avif')} alt="" aria-hidden {...stylex.props(styles.pixel)} />;
}
