import * as stylex from '@stylexjs/stylex';
import { splitImage } from './split_frame';

const styles = stylex.create({
  frame: {
    position: 'relative',
    width: 'fit-content',
    marginInline: 'auto',
    borderRadius: '4px',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  over: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    // Hidden rather than unmounted, so a swap is instant rather than a fresh decode.
    opacity: 0,
  },
  shown: {
    opacity: 1,
  },
});

/** Renditions of 1 photo stacked in 1 frame, showing the one `shown` names. The first sizes the frame. */
export function SwapFrame<T extends string>({
  photos,
  shown,
}: {
  photos: readonly { value: T; src: string; alt: string }[];
  shown: T;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.frame)}>
      {photos.map((photo, index) => (
        <img
          key={photo.value}
          {...stylex.props(
            splitImage.before,
            index > 0 && styles.over,
            index > 0 && photo.value === shown && styles.shown,
          )}
          src={photo.src}
          alt={photo.value === shown ? photo.alt : ''}
        />
      ))}
    </div>
  );
}
