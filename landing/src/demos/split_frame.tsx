import * as stylex from '@stylexjs/stylex';
import { useRef, useState, type ReactNode } from 'react';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { Spinner } from '../../../web/src/ui/spinner';
import { color } from '../../../web/src/ui/tokens.stylex';
import { Badge } from './badge';

/** For the `img` a caller hands in as `before` and as `after`. */
export const splitImage = stylex.create({
  before: {
    display: 'block',
    width: 'auto',
    height: 'auto',
    maxWidth: '100%',
    // A portrait photograph is otherwise a metre of demo beside three lines of text.
    maxHeight: '760px',
  },
  after: {
    display: 'block',
    width: '100%',
    height: '100%',
  },
});

const styles = stylex.create({
  split: {
    position: 'relative',
    // Hugs the picture, so a frame narrower than the column has no bars down its sides.
    width: 'fit-content',
    marginInline: 'auto',
    overflow: 'hidden',
    borderRadius: '4px',
    backgroundColor: '#000',
    userSelect: 'none',
  },
  pending: {
    minHeight: '240px',
    minWidth: '240px',
  },
  contents: {
    display: 'contents',
  },
  // Hidden rather than unmounted, so the pair is still downloading while the spinner turns.
  // On the contents rather than the frame: a hidden element leaves the accessibility tree, and
  // the frame is what carries `aria-busy`.
  hidden: {
    visibility: 'hidden',
  },
  spinner: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  after: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    overflow: 'hidden',
  },
  afterFrame: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
  },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '2px',
    marginLeft: '-1px',
    backgroundColor: color.bone,
    boxShadow: '0 0 4px rgb(0 0 0 / 60%)',
    pointerEvents: 'none',
    '::after': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: '26px',
      height: '26px',
      marginTop: '-13px',
      marginLeft: '-13px',
      borderWidth: '2px',
      borderStyle: 'solid',
      borderColor: color.bone,
      borderRadius: '50%',
      backgroundColor: color.bower,
    },
  },
  tag: {
    position: 'absolute',
    top: '8px',
    pointerEvents: 'none',
  },
  tagBefore: {
    left: '8px',
  },
  tagAfter: {
    right: '8px',
  },
  input: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    opacity: 0,
    cursor: 'ew-resize',
    appearance: 'none',
    touchAction: 'pan-y',
    '::-webkit-slider-thumb': { appearance: 'none', width: '44px', height: '2000px' },
    '::-moz-range-thumb': { width: '44px', height: '2000px' },
  },
});

export function SplitFrame({
  before,
  after,
  beforeLabel,
  afterLabel,
  label,
  value,
  onChange,
  loading = false,
}: {
  before: ReactNode;
  after: ReactNode;
  beforeLabel: string;
  afterLabel: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  loading?: boolean;
}): JSX.Element {
  const latestValue = useRef(value);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shownValue = dragValue ?? value;
  const shown = Math.max(0.001, 1 - shownValue / 100);
  const commit = (): void => {
    if (dragValue == null) return;
    setDragValue(null);
    onChange(latestValue.current);
  };

  return (
    <div {...stylex.props(styles.split, loading && styles.pending, focusRing.within)} aria-busy={loading}>
      <div {...stylex.props(styles.contents, loading && styles.hidden)}>
        <div>{before}</div>
        {/* Clipped by overflow, not clip-path or a transform: either can flatten an HDR image to SDR. */}
        <div {...stylex.props(styles.after)} style={{ left: `${shownValue}%` }}>
          <div {...stylex.props(styles.afterFrame)} style={{ width: `${100 / shown}%` }}>
            {after}
          </div>
        </div>
        <span {...stylex.props(styles.handle)} style={{ left: `${shownValue}%` }} aria-hidden />
        <Badge style={[styles.tag, styles.tagBefore]} aria-hidden>
          {beforeLabel}
        </Badge>
        <Badge style={[styles.tag, styles.tagAfter]} aria-hidden>
          {afterLabel}
        </Badge>
        <input
          {...stylex.props(styles.input)}
          type="range"
          min={0}
          max={100}
          step={1}
          value={shownValue}
          aria-label={label}
          onPointerDown={() => {
            latestValue.current = value;
            setDragValue(value);
          }}
          onPointerUp={commit}
          onPointerCancel={() => setDragValue(null)}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            latestValue.current = next;
            if (dragValue == null) onChange(next);
            else setDragValue(next);
          }}
        />
      </div>
      {loading && (
        <span {...stylex.props(styles.spinner)}>
          <Spinner />
        </span>
      )}
    </div>
  );
}
