import type { ReactNode } from 'react';

type TextVariant = 'body' | 'muted' | 'mono' | 'label';

// Four text roles, no free-floating font sizes. `label` is the small uppercase
// caption that titles a panel or a rail section.
export function Text({
  variant = 'body',
  as: As = 'span',
  className,
  children,
  ...rest
}: {
  variant?: TextVariant;
  as?: 'span' | 'p' | 'div' | 'dt' | 'dd';
  className?: string;
  children: ReactNode;
  title?: string;
  /** So a control can point at this text with `aria-describedby`. */
  id?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <As className={`ui-text ui-text--${variant}${className == null ? '' : ` ${className}`}`} {...rest}>
      {children}
    </As>
  );
}
