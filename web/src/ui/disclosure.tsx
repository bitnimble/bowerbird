import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { focusRing } from './focus_ring';
import { color, font } from './tokens.stylex';

const styles = stylex.create({
  summary: {
    cursor: 'pointer',
    fontFamily: font.display,
    fontSize: '14.3px',
    paddingBlock: '2px',
    color: { default: color.boneDim, ':hover': color.bone },
  },
});

export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <details>
      <summary {...stylex.props(styles.summary, focusRing.ring)}>{title}</summary>
      {children}
    </details>
  );
}
