import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color, font } from './tokens.stylex';

const styles = stylex.create({
  list: {
    display: 'grid',
    gridTemplateColumns: '108px 1fr',
    gap: '5px 10px',
    fontFamily: font.mono,
    fontSize: '11px',
    margin: 0,
  },
  term: {
    color: color.boneDim,
  },
  value: {
    margin: 0,
    wordBreak: 'break-all',
    minWidth: 0,
  },
});

/** Names down the left and what they hold down the right: a `MetaTerm` then a `MetaValue`, repeated. */
export function MetaList({ style, children }: { style?: stylex.StyleXStyles; children: ReactNode }): JSX.Element {
  return <dl {...stylex.props(styles.list, style)}>{children}</dl>;
}

export function MetaTerm({ children }: { children: ReactNode }): JSX.Element {
  return <dt {...stylex.props(styles.term)}>{children}</dt>;
}

export function MetaValue({ children }: { children: ReactNode }): JSX.Element {
  return <dd {...stylex.props(styles.value)}>{children}</dd>;
}
