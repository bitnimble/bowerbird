import * as stylex from '@stylexjs/stylex';
import { createContext, type ReactNode } from 'react';
import { Tooltip } from './tooltip';

const styles = stylex.create({
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
});

/** True inside a `Field`, which stacks: there a growing control takes the full width rather than a flex basis of height. */
export const InField = createContext(false);

/** A control with its caption over it and any hint or warning under it. */
export function Field({
  children,
  tooltip,
  ...rest
}: {
  children: ReactNode;
  /** For a set of choices that answer one question. */
  role?: 'radiogroup';
  'aria-label'?: string;
  tooltip?: string;
}): JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <div {...stylex.props(styles.field)} {...rest}>
        <InField.Provider value>{children}</InField.Provider>
      </div>
    </Tooltip>
  );
}
