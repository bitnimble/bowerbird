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
  // One of a set of alternatives, and the one in force: marked with a dot rather
  // than a pressed state, a menu row having none.
  active?: boolean;
  // Offered but not selectable - the action exists here whatever the library or
  // the photo is, and greying it says why it cannot be taken.
  disabled?: boolean;
  // Where a disabled row says what would make it selectable.
  tooltip?: string;
}
