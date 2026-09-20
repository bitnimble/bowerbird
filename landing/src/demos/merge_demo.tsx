import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../web/src/ui/button';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { menuStyles } from '../../../web/src/ui/menu_styles';
import { Row } from '../../../web/src/ui/row';
import { Text } from '../../../web/src/ui/text';
import { color } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { PHOTOS } from '../photos';
import { Demo, DemoBar } from './demo';

type Point = readonly [number, number];

const ASPECT = 3 / 2;

// Fractions of the photograph's width and height.
const PIECES: readonly (readonly Point[])[] = [
  [[0.27, 0.02], [0.62, 0.02], [0.6, 0.2], [0.47, 0.3], [0.3, 0.24]],
  [[0.03, 0.3], [0.2, 0.25], [0.32, 0.45], [0.22, 0.62], [0.05, 0.55]],
  [[0.37, 0.37], [0.5, 0.38], [0.56, 0.6], [0.66, 0.8], [0.5, 0.92], [0.44, 0.62]],
  [[0.58, 0.52], [0.76, 0.46], [0.92, 0.6], [0.82, 0.8], [0.64, 0.7]],
];

// Stand-ins for other frames of the burst: the same photograph, exposed differently.
const FRAMES = [
  { name: 'DSC_2201', look: 'none' },
  { name: 'DSC_2202', look: 'brightness(1.35)' },
  { name: 'DSC_2203', look: 'brightness(0.7) contrast(1.15)' },
  { name: 'DSC_2204', look: 'saturate(1.6) brightness(1.1)' },
] as const;

const UNCHANGED = PIECES.map(() => 0);

const NARROW = '@media (max-width: 600px)';
const SWATCH = { default: '112px', [NARROW]: '64px' };
const LIT = ':is([aria-expanded=true], :focus-visible)';

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
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  outline: {
    fill: { default: 'transparent', '[aria-expanded=true]': 'rgb(255 255 255 / 8%)' },
    stroke: color.glass,
    vectorEffect: 'non-scaling-stroke',
    strokeWidth: { default: 1.25, [LIT]: 2.5 },
    strokeOpacity: { default: 0.8, [LIT]: 1 },
    filter: 'drop-shadow(0 0 1px rgb(0 0 0 / 65%))',
    cursor: 'pointer',
    outline: 'none',
  },
  popup: {
    position: 'absolute',
    zIndex: 5,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'max-content',
    maxWidth: '100%',
    padding: '8px',
  },
  swatches: {
    flexWrap: 'nowrap',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  swatch: {
    width: SWATCH,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
    cursor: 'pointer',
  },
  crop: {
    position: 'relative',
    display: 'block',
    height: SWATCH,
    overflow: 'hidden',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '4px',
    backgroundColor: '#000',
  },
  cropCurrent: {
    borderColor: color.glass,
  },
  cropImage: {
    position: 'absolute',
    maxWidth: 'none',
  },
  name: {
    display: 'block',
    fontSize: '11px',
    lineHeight: '16px',
    color: color.boneDim,
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

export function MergeDemo(): JSX.Element {
  const [picks, setPicks] = useState<readonly number[]>(UNCHANGED);
  const [open, setOpen] = useState<number | null>(null);
  const pieceRefs = useRef<(SVGPathElement | null)[]>([]);

  const close = useCallback((): void => {
    if (open != null) pieceRefs.current[open]?.focus();
    setOpen(null);
  }, [open]);

  const choose = (piece: number, frame: number): void => {
    setPicks((was) => was.map((pick, index) => (index === piece ? frame : pick)));
    close();
  };

  return (
    <Demo>
      <DemoBar>
        <Text variant="mono">{DEMO.merge.hint}</Text>
        <Button disabled={picks.every((pick) => pick === 0)} onClick={() => setPicks(UNCHANGED)}>
          {DEMO.merge.reset}
        </Button>
      </DemoBar>
      <div {...stylex.props(styles.stage)}>
        <img {...stylex.props(styles.photo)} src={PHOTOS.rapids.sdr} alt={DEMO.merge.alt} />
        {PIECES.map((piece, index) => {
          const frame = FRAMES[picks[index] ?? 0];
          if (frame == null || frame.look === 'none') return null;
          return (
            <img
              key={index}
              {...stylex.props(styles.photo, styles.piece)}
              src={PHOTOS.rapids.sdr}
              alt=""
              style={{ filter: frame.look, clipPath: polygon(piece) }}
            />
          );
        })}
        <svg {...stylex.props(styles.overlay)} viewBox="0 0 1 1" preserveAspectRatio="none">
          {PIECES.map((piece, index) => (
            <path
              key={index}
              ref={(path) => {
                pieceRefs.current[index] = path;
              }}
              d={`M${piece.map(([x, y]) => `${x},${y}`).join('L')}Z`}
              {...stylex.props(styles.outline)}
              role="button"
              tabIndex={0}
              aria-label={DEMO.merge.region(index)}
              aria-expanded={open === index}
              onClick={() => setOpen(index)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setOpen(index);
              }}
            />
          ))}
        </svg>
        {open != null && <Popup piece={open} current={picks[open] ?? 0} onChoose={(frame) => choose(open, frame)} onClose={close} />}
      </div>
    </Demo>
  );
}

function Popup({
  piece,
  current,
  onChoose,
  onClose,
}: {
  piece: number;
  current: number;
  onChoose: (frame: number) => void;
  onClose: () => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const points = PIECES[piece] ?? [];
  const box = bounds(points);

  useEffect(() => {
    root.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) === true) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  const below = box.y1 < 0.6;
  return (
    <div
      ref={root}
      {...stylex.props(menuStyles.popup, styles.popup)}
      role="dialog"
      aria-label={DEMO.merge.frames}
      style={below ? { top: `calc(${box.y1 * 100}% + 8px)` } : { bottom: `calc(${(1 - box.y0) * 100}% + 8px)` }}
    >
      <Row style={styles.swatches}>
        {FRAMES.map((frame, index) => (
          <button
            key={frame.name}
            type="button"
            aria-label={DEMO.merge.frame(frame.name)}
            aria-current={index === current ? 'true' : undefined}
            {...stylex.props(styles.swatch, focusRing.ring)}
            onClick={() => onChoose(index)}
          >
            <span {...stylex.props(styles.crop, index === current && styles.cropCurrent)}>
              <img
                {...stylex.props(styles.cropImage)}
                src={PHOTOS.rapids.sdr}
                alt=""
                style={{ ...cropOf(points), filter: frame.look, clipPath: polygon(points) }}
              />
            </span>
            <span {...stylex.props(styles.name)}>{frame.name}</span>
          </button>
        ))}
      </Row>
    </div>
  );
}

function polygon(points: readonly Point[]): string {
  return `polygon(${points.map(([x, y]) => `${x * 100}% ${y * 100}%`).join(', ')})`;
}

function bounds(points: readonly Point[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Places the whole photograph in a square swatch so that the piece fills it, with a margin. */
function cropOf(points: readonly Point[]): React.CSSProperties {
  const { x0, y0, x1, y1 } = bounds(points);
  const width = x1 - x0;
  const height = (y1 - y0) / ASPECT;
  const span = Math.max(width, height) * 1.1;
  return {
    width: `${100 / span}%`,
    height: `${100 / span / ASPECT}%`,
    left: `${((-x0 + (span - width) / 2) / span) * 100}%`,
    top: `${((-y0 / ASPECT + (span - height) / 2) / span) * 100}%`,
  };
}
