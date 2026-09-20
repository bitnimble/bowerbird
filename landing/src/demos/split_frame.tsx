import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { color } from '../../../web/src/ui/tokens.stylex';
import { Badge } from './badge';

/** For the `img` a caller hands in as `before` and as `after`. */
export const splitImage = stylex.create({
  before: {
    display: 'block',
    width: '100%',
    height: 'auto',
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
    overflow: 'hidden',
    borderRadius: '4px',
    backgroundColor: '#000',
    userSelect: 'none',
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
  },});

/** `before` sits in flow and sizes the frame; `after` fills it, shown right of the divider at `value` percent. */
export function SplitFrame({
  before,
  after,
  beforeLabel,
  afterLabel,
  label,
  value,
  onChange,
}: {
  before: ReactNode;
  after: ReactNode;
  beforeLabel: string;
  afterLabel: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}): JSX.Element {
  const shown = Math.max(0.001, 1 - value / 100);
  return (
    <div {...stylex.props(styles.split, focusRing.within)}>
      <div>{before}</div>
      {/* Clipped by overflow, not clip-path or a transform: either can flatten an HDR image to SDR. */}
      <div {...stylex.props(styles.after)} style={{ left: `${value}%` }}>
        <div {...stylex.props(styles.afterFrame)} style={{ width: `${100 / shown}%` }}>
          {after}
        </div>
      </div>
      <span {...stylex.props(styles.handle)} style={{ left: `${value}%` }} aria-hidden />
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
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
