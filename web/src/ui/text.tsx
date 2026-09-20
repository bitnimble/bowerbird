import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color, font } from './tokens.stylex';

type TextVariant = 'body' | 'muted' | 'mono' | 'label';

// Set against a 14px body, so the body's own step up on a phone would leave them reading smaller.
const COARSE = '@media (pointer: coarse)';

export const textStyles = stylex.create({
  body: {},
  muted: {
    color: color.boneDim,
  },
  mono: {
    fontFamily: font.mono,
    fontSize: { default: '11px', [COARSE]: '13px' },
    color: color.boneDim,
  },
  monoParagraph: {
    marginTop: 0,
    marginInline: 0,
    marginBottom: '4px',
  },
  label: {
    fontFamily: font.mono,
    fontSize: { default: '10px', [COARSE]: '12px' },
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: color.boneDim,
  },
  error: {
    color: '#f0a9a3',
  },
  warning: {
    color: color.ochre,
  },
});

// Four text roles, no free-floating font sizes. `label` is the small uppercase
// caption that titles a panel or a sidebar section.
export function Text({
  variant = 'body',
  as: As = 'span',
  tone,
  style,
  children,
  ...rest
}: {
  variant?: TextVariant;
  as?: 'span' | 'p' | 'div' | 'dt' | 'dd';
  /** Says the text is a problem with what it sits under, rather than a description of it. */
  tone?: 'error' | 'warning';
  style?: stylex.StyleXStyles;
  children: ReactNode;
  title?: string;
  /** So a control can point at this text with `aria-describedby`. */
  id?: string;
}): JSX.Element {
  return (
    <As
      {...stylex.props(
        textStyles[variant],
        variant === 'mono' && As === 'p' && textStyles.monoParagraph,
        tone != null && textStyles[tone],
        style,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}
