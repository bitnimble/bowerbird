import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { Button } from '../../../web/src/ui/button';
import { color } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { PHOTOS } from '../photos';
import { Demo, DemoBar } from './demo';

const WIDTH = 0.4;

// Where each frame sits in the finished picture, and how it lies before stitching.
const FRAMES = [
  { left: 0, apart: 'translate(-6%, 6%) rotate(-3deg)' },
  { left: 0.3, apart: 'translate(0, -7%) rotate(2deg)' },
  { left: 0.6, apart: 'translate(6%, 4%) rotate(-1.5deg)' },
];

const styles = stylex.create({
  panorama: {
    position: 'relative',
    aspectRatio: '3 / 2',
    transform: 'scale(0.84)',
    transition: 'transform 600ms ease',
  },
  stitched: {
    transform: 'none',
  },
  frame: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundRepeat: 'no-repeat',
    boxShadow: `0 0 0 1px ${color.glass}, 0 8px 24px rgb(0 0 0 / 50%)`,
    transition: 'transform 600ms ease, box-shadow 600ms ease',
  },
  frameStitched: {
    boxShadow: 'none',
  },
});

export function PanoramaDemo(): JSX.Element {
  const [stitched, setStitched] = useState(false);
  return (
    <Demo>
      <DemoBar>
        <Button variant="primary" aria-pressed={stitched} onClick={() => setStitched((was) => !was)}>
          {stitched ? DEMO.panorama.apart : DEMO.panorama.stitch}
        </Button>
      </DemoBar>
      <div {...stylex.props(styles.panorama, stitched && styles.stitched)} role="img" aria-label={DEMO.panorama.alt}>
        {FRAMES.map((frame) => (
          <div
            key={frame.left}
            {...stylex.props(styles.frame, stitched && styles.frameStitched)}
            style={{
              left: `${frame.left * 100}%`,
              width: `${WIDTH * 100}%`,
              backgroundImage: `url(${PHOTOS.sunset.sdr})`,
              backgroundSize: `${100 / WIDTH}% 100%`,
              backgroundPosition: `${(frame.left / (1 - WIDTH)) * 100}% 0`,
              transform: stitched ? 'none' : frame.apart,
            }}
          />
        ))}
      </div>
    </Demo>
  );
}
