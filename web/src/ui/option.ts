import type { ReactNode } from 'react';

export interface Option<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  // Colours the pressed state. Used only by the triage verdicts, where
  // traffic-light semantics beat palette purity.
  tone?: 'pick' | 'reject';
  // Keyboard shortcut, shown dimmed after the label.
  hint?: string;
  // Show the icon alone. The label still names the control for screen readers
  // and as a tooltip, so an icon-only button is never anonymous.
  iconOnly?: boolean;
  // In a menu: red, and fenced off below a rule so it is not a neighbour of the
  // action above it.
  destructive?: boolean;
}
