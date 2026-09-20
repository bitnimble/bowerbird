import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { textStyles } from './text';
import { color, font } from './tokens.stylex';

const pulse = stylex.keyframes({ '50%': { opacity: 0.35 } });

const styles = stylex.create({
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '6px',
  },
  label: {
    fontFamily: font.mono,
    fontSize: '11px',
    color: color.boneDim,
    whiteSpace: 'nowrap',
  },
  dot: {
    width: '7px',
    height: '7px',
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
  title,
  children,
}: {
  tone?: 'error';
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span {...stylex.props(styles.label, tone === 'error' && textStyles.error)} title={title}>
      {children}
    </span>
  );
}

/** Idle is still; `processing` is the scan, `working` whatever runs after or beside it. */
export function StatusDot({ state = 'idle' }: { state?: 'idle' | 'processing' | 'working' }): JSX.Element {
  return (
    <span
      {...stylex.props(styles.dot, state !== 'idle' && styles.pulse, state !== 'idle' && styles[state])}
      aria-hidden="true"
    />
  );
}
