import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  spacer: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
});

/** Controls and text on one line, wrapping onto the next where there is no room. */
export function Row({
  as: As = 'div',
  style,
  children,
  ...rest
}: {
  /** `label` for a control and its caption as one target. */
  as?: 'div' | 'label';
  style?: stylex.StyleXStyles;
  children: ReactNode;
  role?: 'group';
  'aria-label'?: string;
  /** Why a control in this row is unavailable, which a disabled control cannot say itself. */
  title?: string;
  onMouseLeave?: () => void;
}): JSX.Element {
  return (
    <As {...stylex.props(styles.row, style)} {...rest}>
      {children}
    </As>
  );
}

/** Pushes what follows it in a row to the far end. */
export function Spacer(): JSX.Element {
  return <span {...stylex.props(styles.spacer)} />;
}
