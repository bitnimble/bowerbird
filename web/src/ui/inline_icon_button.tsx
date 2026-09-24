import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { focusRing } from './focus_ring';
import { color } from './tokens.stylex';

const styles = stylex.create({
  button: {
    paddingBlock: 0,
    paddingRight: 0,
    paddingLeft: '6px',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'pointer',
    verticalAlign: '-2px',
  },
});

/** An icon-only button that sits in a line of text, after the value it acts on. */
export function InlineIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button type="button" {...stylex.props(styles.button, focusRing.ring)} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
