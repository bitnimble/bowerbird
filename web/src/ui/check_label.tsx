import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

const styles = stylex.create({
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
});

/** A checkbox or radio and its caption, as one target. */
export function CheckLabel({
  style,
  children,
}: {
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  return <label {...stylex.props(styles.label, style)}>{children}</label>;
}
