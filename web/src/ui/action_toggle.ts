import type { ReactNode } from 'react';

/** A setting that modifies the actions around it, rather than an action itself. */
export interface ActionToggle {
  label: string;
  icon?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}
