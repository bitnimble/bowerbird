import * as stylex from '@stylexjs/stylex';
import { color } from '../../web/src/ui/tokens.stylex';
import { SHOT_SIZE, type Shot as ShotSpec } from './features';

const styles = stylex.create({
  shot: {
    margin: 0,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    overflow: 'hidden',
    backgroundColor: color.bower,
  },
  phone: {
    maxWidth: '300px',
    marginInline: 'auto',
  },
  image: {
    display: 'block',
    width: '100%',
    height: 'auto',
  },
});

export function Shot({ shot }: { shot: ShotSpec }): JSX.Element {
  const { width, height } = SHOT_SIZE[shot.frame];
  return (
    <figure {...stylex.props(styles.shot, shot.frame === 'phone' && styles.phone)}>
      <img
        {...stylex.props(styles.image)}
        src={`${import.meta.env.BASE_URL}shots/${shot.src}`}
        alt={shot.alt}
        width={width}
        height={height}
        loading="lazy"
      />
    </figure>
  );
}
