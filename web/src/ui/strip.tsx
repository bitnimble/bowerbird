import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { textStyles } from './text';
import { color, font } from './tokens.stylex';
import { Tooltip } from './tooltip';

const pulse = stylex.keyframes({ '50%': { opacity: 0.35 } });

const DOT_PX = 7;
const GAP_PX = 8;

const styles = stylex.create({
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${GAP_PX}px`,
    marginTop: '6px',
  },
  label: {
    fontFamily: font.mono,
    fontSize: '12.1px',
    color: color.boneDim,
    minWidth: 0,
    maxWidth: `calc(100% - ${DOT_PX + GAP_PX}px)`,
    overflowWrap: 'anywhere',
  },
  dot: {
    width: `${DOT_PX}px`,
    height: `${DOT_PX}px`,
    borderRadius: '50%',
    backgroundColor: color.boneDim,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  pulse: {
    animationName: pulse,
    animationDuration: '1s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  processing: {
    backgroundColor: color.glass,
  },
  working: {
    backgroundColor: color.satin,
  },
  queued: {
    backgroundColor: color.ochre,
  },
});

/** One line of status about a job running in the background: a dot, and what it says. */
export function Strip({
  style,
  children,
}: {
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  return <div {...stylex.props(styles.strip, style)}>{children}</div>;
}

export function StripLabel({
  tone,
  tooltip,
  children,
}: {
  tone?: 'error';
  tooltip?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <span {...stylex.props(styles.label, tone === 'error' && textStyles.error)}>{children}</span>
    </Tooltip>
  );
}

/**
 * Idle is still; `processing` is the scan, `working` whatever runs after or beside it, `queued`
 * work waiting its turn.
 */
export function StatusDot({
  state = 'idle',
}: {
  state?: 'idle' | 'processing' | 'working' | 'queued';
}): JSX.Element {
  const moving = state === 'processing' || state === 'working';
  return (
    <span
      {...stylex.props(styles.dot, moving && styles.pulse, state !== 'idle' && styles[state])}
      aria-hidden="true"
    />
  );
}
