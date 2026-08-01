import type { ReactNode } from 'react';
import type { ActionToggle } from './action_toggle';
import type { Option } from './option';

/** One button's worth of menu: what it is called, and what it offers. */
export interface MenuSection {
  label: string;
  icon?: ReactNode;
  options: Option<string>[];
  /** Shown below the actions, since these change what the actions do. */
  toggles?: ActionToggle[];
  onSelect: (value: string) => void;
}

// Forgets which values a menu is over, so menus over different ones can be held
// in one list and rendered as buttons or as sections of an OverflowMenu from the
// same declaration. The selected value is looked back up in `options` rather than
// asserted, which is what keeps the narrowing honest.
export function menuSection<T extends string>(section: {
  label: string;
  icon?: ReactNode;
  options: Option<T>[];
  toggles?: ActionToggle[];
  onSelect: (value: T) => void;
}): MenuSection {
  return {
    ...section,
    onSelect: (value) => {
      const picked = section.options.find((o) => o.value === value);
      if (picked != null) section.onSelect(picked.value);
    },
  };
}
