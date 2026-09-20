import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color, font } from './tokens.stylex';

const styles = stylex.create({
  empty: {
    paddingBlock: '40px',
    paddingInline: '16px',
    textAlign: 'center',
    color: color.boneDim,
  },
  title: {
    fontFamily: font.display,
    fontSize: '15px',
    color: color.bone,
    marginBottom: '5px',
  },
});

/** What stands where a page's content would be, saying why there is none. */
export function EmptyState({ title, children }: { title?: string; children?: ReactNode }): JSX.Element {
  return (
    <div {...stylex.props(styles.empty)}>
      {title != null && <div {...stylex.props(styles.title)}>{title}</div>}
      {children}
    </div>
  );
}
