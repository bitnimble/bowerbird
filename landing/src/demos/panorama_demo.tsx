import * as stylex from '@stylexjs/stylex';
import { DEMO } from '../features';
import { PANORAMA_FRAMES, PANORAMA_PHOTO } from '../photos';
import { Demo } from './demo';

const styles = stylex.create({
  panorama: {
    display: 'block',
    width: '100%',
    height: 'auto',
    borderRadius: '4px',
  },
  frames: {
    display: 'flex',
    gap: '8px',
  },
  frame: {
    display: 'block',
    flex: '1 1 0',
    minWidth: 0,
    height: 'auto',
    borderRadius: '3px',
  },
});

export function PanoramaDemo(): JSX.Element {
  return (
    <Demo>
      <img {...stylex.props(styles.panorama)} src={PANORAMA_PHOTO} alt={DEMO.panorama.alt} />
      <div {...stylex.props(styles.frames)}>
        {PANORAMA_FRAMES.map((frame, at) => (
          <img key={frame} {...stylex.props(styles.frame)} src={frame} alt={DEMO.panorama.frame(at)} />
        ))}
      </div>
    </Demo>
  );
}
