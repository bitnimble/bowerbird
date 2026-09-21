import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { color, font } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { MERGE_PHOTO } from '../photos';
import { Demo } from './demo';

type Point = readonly [number, number];

// Around each person in the frame, in fractions of its width and height. Both stand on the
// paving, which is where the two frames agree: further back they disagree by their own parallax.
const PEOPLE: readonly (readonly Point[])[] = [
  [[0.316, 0.670], [0.342, 0.670], [0.352, 0.722], [0.360, 0.782], [0.358, 0.810], [0.300, 0.810], [0.297, 0.768], [0.308, 0.708]],
  [[0.474, 0.648], [0.502, 0.648], [0.516, 0.702], [0.526, 0.800], [0.524, 0.846], [0.468, 0.846], [0.462, 0.782], [0.466, 0.700]],
];

const FRAMES = [
  { name: 'DSC00131', src: MERGE_PHOTO.people, alt: DEMO.merge.frameWith },
  { name: 'DSC00130', src: MERGE_PHOTO.clear, alt: DEMO.merge.frameWithout },
];

const LIT = ':is([aria-pressed=true], :focus-visible)';

const styles = stylex.create({
  stage: {
    position: 'relative',
    aspectRatio: '3 / 2',
  },
  photo: {
    position: 'absolute',
    inset: 0,
    display: 'block',
    width: '100%',
    height: '100%',
    borderRadius: '4px',
  },
  piece: {
    pointerEvents: 'none',
    overflow: 'hidden',
  },
  pieceImage: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    // The two frames were taken by hand a moment apart, so the second sits about 2.6% across
    // and 2.9% down from the first. Measured on the ground around both people: without it the
    // paving joints and the bollards behind them step sideways at the edge of the piece.
    transform: 'translate(2.6%, -2.9%)',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  outline: {
    fill: { default: 'transparent', ':hover': 'rgb(255 255 255 / 8%)' },
    stroke: { default: color.glass, '[aria-pressed=true]': color.moss },
    vectorEffect: 'non-scaling-stroke',
    strokeWidth: { default: 1.25, [LIT]: 2.5 },
    strokeOpacity: { default: 0.8, [LIT]: 1 },
    strokeDasharray: { default: null, '[aria-pressed=true]': '4 3' },
    filter: 'drop-shadow(0 0 1px rgb(0 0 0 / 65%))',
    cursor: 'pointer',
    outline: 'none',
  },
  frames: {
    display: 'flex',
    gap: '10px',
  },
  figure: {
    margin: 0,
    width: '180px',
    maxWidth: '50%',
  },
  frame: {
    display: 'block',
    width: '100%',
    height: 'auto',
    borderRadius: '4px',
  },
  name: {
    display: 'block',
    marginTop: '3px',
    fontFamily: font.mono,
    fontSize: '11px',
    color: color.boneDim,
  },
});

export function MergeDemo(): JSX.Element {
  const [taken, setTaken] = useState<readonly boolean[]>(PEOPLE.map(() => false));

  const toggle = (index: number): void => {
    setTaken((was) => was.map((one, at) => (at === index ? !one : one)));
  };

  return (
    <Demo>
      <div {...stylex.props(styles.stage)}>
        <img {...stylex.props(styles.photo)} src={MERGE_PHOTO.people} alt={DEMO.merge.alt} />
        {PEOPLE.map((piece, index) =>
          taken[index] === true ? (
            <div key={index} {...stylex.props(styles.photo, styles.piece)} style={{ clipPath: polygon(piece) }}>
              <img {...stylex.props(styles.pieceImage)} src={MERGE_PHOTO.clear} alt="" />
            </div>
          ) : null,
        )}
        <svg {...stylex.props(styles.overlay)} viewBox="0 0 1 1" preserveAspectRatio="none">
          {PEOPLE.map((piece, index) => (
            <path
              key={index}
              d={`M${piece.map(([x, y]) => `${x},${y}`).join('L')}Z`}
              {...stylex.props(styles.outline)}
              role="button"
              tabIndex={0}
              aria-label={DEMO.merge.person(index)}
              aria-pressed={taken[index] === true}
              onClick={() => toggle(index)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle(index);
              }}
            />
          ))}
        </svg>
      </div>
      <div {...stylex.props(styles.frames)}>
        {FRAMES.map((frame) => (
          <figure key={frame.name} {...stylex.props(styles.figure)}>
            <img {...stylex.props(styles.frame)} src={frame.src} alt={frame.alt} />
            <figcaption {...stylex.props(styles.name)}>{frame.name}</figcaption>
          </figure>
        ))}
      </div>
    </Demo>
  );
}

function polygon(points: readonly Point[]): string {
  return `polygon(${points.map(([x, y]) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`).join(', ')})`;
}
