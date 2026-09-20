import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color, font } from '../../../web/src/ui/tokens.stylex';

const styles = stylex.create({
  badge: {
    fontFamily: font.mono,
    fontSize: '9px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    paddingBlock: '2px',
    paddingInline: '5px',
    borderRadius: '2px',
    backgroundColor: 'rgba(10, 12, 16, 0.82)',
    color: color.boneDim,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  pick: {
    color: color.moss,
  },
  reject: {
    color: color.rose,
  },
});

export function Badge({
  tone,
  style,
  children,
  ...rest
}: {
  tone?: 'pick' | 'reject';
  style?: stylex.StyleXStyles;
  children: ReactNode;
  'aria-hidden'?: boolean;
}): JSX.Element {
  return (
    <span {...stylex.props(styles.badge, tone != null && styles[tone], style)} {...rest}>
      {children}
    </span>
  );
}
