import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { color, font } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { MERGE_PHOTO } from '../photos';
import { Demo } from './demo';

type Point = readonly [number, number];

interface Piece {
  /** Around the person on the frame with people, in fractions of its width and height. */
  outline: readonly Point[];
  /** Where the other frame is drawn under this piece, in percent of the frame. */
  shift: Point;
}

// Both people stand on the paving, which is where the two frames agree: further back they disagree
// by their own parallax.
const PEOPLE: readonly Piece[] = [
  {
    outline: [
      [0.316, 0.67],
      [0.342, 0.67],
      [0.352, 0.722],
      [0.36, 0.782],
      [0.358, 0.81],
      [0.3, 0.81],
      [0.297, 0.768],
      [0.308, 0.708],
    ],
    // Per piece, measured on a band around each outline: the paving under the 2 people is at
    // different depths, and 1 shift for both leaves the curb behind this one 4 px out.
    shift: [2.72, -2.42],
  },
  {
    outline: [
      [0.474, 0.648],
      [0.502, 0.648],
      [0.516, 0.702],
      [0.526, 0.8],
      [0.524, 0.846],
      [0.468, 0.846],
      [0.462, 0.782],
      [0.466, 0.7],
    ],
    shift: [2.67, -2.86],
  },
];

const UNTAKEN = PEOPLE.map(() => false);

const PEOPLE_FRAME = 0;

const FRAMES = [
  { name: 'DSC00131', src: MERGE_PHOTO.people, alt: DEMO.merge.alt },
  { name: 'DSC00130', src: MERGE_PHOTO.clear, alt: DEMO.merge.clearAlt },
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
  thumb: {
    display: 'block',
    width: '180px',
    maxWidth: '50%',
    padding: 0,
    borderStyle: 'none',
    borderRadius: '6px',
    backgroundColor: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
  },
  frame: {
    display: 'block',
    width: '100%',
    height: 'auto',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '6px',
  },
  frameShown: {
    borderColor: color.moss,
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
  const [taken, setTaken] = useState<readonly boolean[]>(UNTAKEN);
  const [shown, setShown] = useState(PEOPLE_FRAME);
  const stage = FRAMES[shown]!;
  const other = FRAMES[shown === PEOPLE_FRAME ? 1 : PEOPLE_FRAME]!;
  const pieces = PEOPLE.map((piece) => placed(piece, shown));
  const label = shown === PEOPLE_FRAME ? DEMO.merge.removePerson : DEMO.merge.addPerson;

  const toggle = (index: number): void => {
    setTaken((was) => was.map((one, at) => (at === index ? !one : one)));
  };

  const show = (index: number): void => {
    setShown(index);
    setTaken(UNTAKEN);
  };

  return (
    <Demo>
      <div {...stylex.props(styles.stage)}>
        <img {...stylex.props(styles.photo)} src={stage.src} alt={stage.alt} />
        {pieces.map((piece, index) =>
          taken[index] === true ? (
            <div
              key={index}
              {...stylex.props(styles.photo, styles.piece)}
              style={{ clipPath: polygon(piece.outline) }}
            >
              <img
                {...stylex.props(styles.pieceImage)}
                style={{ transform: `translate(${piece.shift[0]}%, ${piece.shift[1]}%)` }}
                src={other.src}
                alt=""
              />
            </div>
          ) : null,
        )}
        <svg {...stylex.props(styles.overlay)} viewBox="0 0 1 1" preserveAspectRatio="none">
          {pieces.map((piece, index) => (
            <path
              key={index}
              d={`M${piece.outline.map(([x, y]) => `${x},${y}`).join('L')}Z`}
              {...stylex.props(styles.outline)}
              role="button"
              tabIndex={0}
              aria-label={label(index)}
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
        {FRAMES.map((frame, index) => (
          <button
            key={frame.name}
            type="button"
            {...stylex.props(styles.thumb, focusRing.ring)}
            aria-label={DEMO.merge.showFrame(frame.name)}
            aria-pressed={shown === index}
            onClick={() => show(index)}
          >
            <img
              {...stylex.props(styles.frame, shown === index && styles.frameShown)}
              src={frame.src}
              alt=""
            />
            <span {...stylex.props(styles.name)}>{frame.name}</span>
          </button>
        ))}
      </div>
    </Demo>
  );
}

/** `piece` on frame `shown`, drawing the other frame under it. */
function placed(piece: Piece, shown: number): Piece {
  if (shown === PEOPLE_FRAME) return piece;
  const [dx, dy] = piece.shift;
  return {
    outline: piece.outline.map(([x, y]) => [x - dx / 100, y - dy / 100] as const),
    shift: [-dx, -dy],
  };
}

function polygon(points: readonly Point[]): string {
  return `polygon(${points.map(([x, y]) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`).join(', ')})`;
}
