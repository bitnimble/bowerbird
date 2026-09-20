import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { textStyles } from './text';
import { size } from './tokens.stylex';

const styles = stylex.create({
  banner: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#4a2a2a',
    backgroundColor: '#1e1315',
    borderRadius: size.radius,
    paddingBlock: '6px',
    paddingInline: '10px',
    marginBottom: '10px',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
});

/** Something that went wrong, and any way of putting it right. */
export function ErrorBanner({ children }: { children: ReactNode }): JSX.Element {
  return <div {...stylex.props(styles.banner, textStyles.error)}>{children}</div>;
}
