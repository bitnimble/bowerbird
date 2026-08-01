import { Button as BaseButton } from '@base-ui-components/react/button';
import { cloneElement, type ReactElement, type ReactNode } from 'react';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  iconOnly?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-current'?: 'page';
  onClick?: (event: React.MouseEvent) => void;
  // For a button whose meaning is press-and-hold rather than press: stack
  // triage's peek shows the other photo for as long as it is held.
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerCancel?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  // Renders the button as something else (a router Link, an anchor) while
  // keeping the metrics and keyboard behaviour.
  render?: ReactElement<Record<string, unknown>>;
}

export function Button({ variant = 'default', iconOnly = false, className, render, ...props }: ButtonProps): JSX.Element {
  const classes = `ui-btn ui-btn--${variant}${iconOnly ? ' ui-btn--icon' : ''}${className == null ? '' : ` ${className}`}`;
  // A link that looks like a button is still a link. Handing it to base-ui would
  // relabel it role="button", costing the link role and open-in-new-tab.
  if (render != null) return cloneElement(render, { className: classes, ...props });
  return <BaseButton className={classes} {...props} />;
}
