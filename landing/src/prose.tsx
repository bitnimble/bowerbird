import * as stylex from '@stylexjs/stylex';
import type { MDXComponents } from 'mdx/types';
import { createContext, useContext, type ReactNode } from 'react';
import { Heading } from '../../web/src/ui/heading';
import { Text } from '../../web/src/ui/text';
import { font } from '../../web/src/ui/tokens.stylex';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  title: {
    maxWidth: '24ch',
    fontFamily: font.display,
    fontWeight: 700,
    fontSize: { default: '44px', [WIDE]: '56px' },
    letterSpacing: '-0.02em',
    lineHeight: 1.05,
    textWrap: 'balance',
    marginTop: 0,
    marginInline: 0,
    marginBottom: '20px',
  },
  paragraph: {
    marginTop: 0,
    marginInline: 0,
    marginBottom: '12px',
    lineHeight: 1.6,
  },
  bullets: {
    marginTop: 0,
    marginInline: 0,
    marginBottom: '14px',
    paddingLeft: '18px',
    lineHeight: 1.6,
  },
  columns: {
    columnCount: { default: null, [WIDE]: 2 },
    columnGap: '48px',
  },
  bullet: {
    marginTop: { default: null, ':not(:first-child)': '6px' },
  },
  sectionTitle: {
    fontSize: { default: '24px', [WIDE]: '30px' },
    letterSpacing: '-0.02em',
    lineHeight: 1.15,
    marginBottom: '16px',
  },
});

export function Title({ children }: { children?: ReactNode }): JSX.Element {
  return <h1 {...stylex.props(styles.title)}>{children}</h1>;
}

export function SectionTitle({ children }: { children?: ReactNode }): JSX.Element {
  return <Heading style={styles.sectionTitle}>{children}</Heading>;
}

export function Paragraph({
  muted = false,
  style,
  children,
}: {
  muted?: boolean;
  style?: stylex.StyleXStyles;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Text as="p" variant={muted ? 'muted' : 'body'} style={[styles.paragraph, style]}>
      {children}
    </Text>
  );
}

const InColumns = createContext(false);

export function Columns({ children }: { children?: ReactNode }): JSX.Element {
  return <InColumns.Provider value>{children}</InColumns.Provider>;
}

function Bullets({ children }: { children?: ReactNode }): JSX.Element {
  const inColumns = useContext(InColumns);
  return <ul {...stylex.props(styles.bullets, inColumns && styles.columns)}>{children}</ul>;
}

export const PROSE: MDXComponents = {
  h1: Title,
  h2: SectionTitle,
  p: ({ children }) => <Paragraph muted>{children}</Paragraph>,
  ul: Bullets,
  li: ({ children }) => <li {...stylex.props(styles.bullet)}>{children}</li>,
};
