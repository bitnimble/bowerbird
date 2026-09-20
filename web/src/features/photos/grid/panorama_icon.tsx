import { LensConcave } from 'lucide-react';

/**
 * A panorama, as a frame whose long edges bow the way a wide lens draws them.
 *
 * Lucide's lens stands on end, so it is turned on its side: what matters is the bow, and a straight
 * rectangle is what a single wide photograph is.
 */
export function PanoramaIcon({ size = 24 }: { size?: number }): React.ReactElement {
  return <LensConcave size={size} style={{ transform: 'rotate(90deg)' }} aria-hidden="true" />;
}
