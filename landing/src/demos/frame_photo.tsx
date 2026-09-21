import * as stylex from '@stylexjs/stylex';
import { DEMO_PHOTO, type DemoPhoto } from '../photos';

/** A made-up frame: one of the demo photos, reframed and re-exposed to stand in for another shot. */
export type Frame = {
  name: string;
  scene: DemoPhoto;
  exposure: number;
  zoom: number;
  shift: number;
};

const styles = stylex.create({
  photo: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
});

export function FramePhoto({ frame, alt }: { frame: Frame; alt: string }): JSX.Element {
  return (
    <img
      {...stylex.props(styles.photo)}
      src={DEMO_PHOTO[frame.scene]}
      alt={alt}
      style={{ filter: `brightness(${frame.exposure})`, transform: `scale(${frame.zoom}) translateX(${frame.shift}%)` }}
    />
  );
}
