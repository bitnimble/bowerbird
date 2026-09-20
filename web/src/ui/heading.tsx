import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, type ReactNode } from 'react';
import { font } from './tokens.stylex';

export const headingStyles = stylex.create({
  base: {
    fontFamily: font.display,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    marginTop: 0,
    marginInline: 0,
    marginBottom: '8px',
  },
  h1: {
    fontSize: '20px',
  },
  h2: {
    fontSize: '17px',
  },
  inline: {
    marginBottom: 0,
  },
});

/** True inside a row that already holds the space under itself, such as a `PageHead`. */
export const HeadingInRow = createContext(false);

export function Heading({
  level = 2,
  style,
  children,
}: {
  level?: 1 | 2;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  const inRow = useContext(HeadingInRow);
  const As = level === 1 ? 'h1' : 'h2';
  return (
    <As {...stylex.props(headingStyles.base, headingStyles[As], inRow && headingStyles.inline, style)}>{children}</As>
  );
}
