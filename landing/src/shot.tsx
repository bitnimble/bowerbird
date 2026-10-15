import * as stylex from '@stylexjs/stylex';
import { sdrMatchSuffix } from '../../src/schemas/sdr_match';
import { HdrPicture } from '../../web/src/avif/hdr_picture';
import { color } from '../../web/src/ui/tokens.stylex';
import { SHOT_SIZE, type Shot as ShotSpec } from './features';
import { useHdrDisplay } from './hdr_display';

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
    maxWidth: '380px',
    marginInline: 'auto',
  },
  image: {
    display: 'block',
    width: '100%',
    height: 'auto',
  },
  // Held while Firefox's video is made, which is no element until then.
  shape: (ratio: string) => ({ aspectRatio: ratio }),
});

function shotUrl(file: string): string {
  return `${import.meta.env.BASE_URL}shots/${file}`;
}

export function Shot({ src, alt, frame, avif, hdr }: ShotSpec): JSX.Element {
  const { width, height } = SHOT_SIZE[frame];
  const showsHdr = useHdrDisplay() && hdr != null;
  return (
    <figure
      {...stylex.props(
        styles.shot,
        frame === 'phone' && styles.phone,
        showsHdr && styles.shape(`${width} / ${height}`),
      )}
    >
      {showsHdr ? (
        <HdrPicture
          source={{
            still: shotUrl(`${hdr}.avif`),
            tenBit: (match) => shotUrl(`${hdr}${sdrMatchSuffix(match)}.avif`),
          }}
          alt={alt}
          style={styles.image}
        />
      ) : (
        <picture>
          {avif != null && <source type="image/avif" srcSet={shotUrl(avif)} />}
          <img
            {...stylex.props(styles.image)}
            src={shotUrl(src)}
            alt={alt}
            width={width}
            height={height}
            loading="lazy"
          />
        </picture>
      )}
    </figure>
  );
}
