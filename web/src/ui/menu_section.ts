import type { ReactNode } from 'react';
import type { Option } from './option';

/** One heading's worth of menu: what it is called, and what it offers. */
export interface MenuSection {
  /** Absent in a popup of one group, where a heading names what nothing else could be. */
  label?: string;
  /** Absent for a section that is a panel of controls rather than a list of actions. */
  options?: Option<string>[];
  onSelect?: (value: string) => void;
  /**
   * Above the section's own items - a control, or a `Submenu`. Brings its own
   * handler, so `onSelect` below never sees it.
   */
  content?: ReactNode;
}

// Forgets which values a menu is over, so menus over different ones can be held in
// one list and rendered as the sections of a single popup. The selected value is
// looked back up in `options` rather than asserted, which is what keeps the
// narrowing honest.
export function menuSection<T extends string>(section: {
  label?: string;
  options?: Option<T>[];
  onSelect?: (value: T) => void;
  content?: ReactNode;
}): MenuSection {
  return {
    ...section,
    onSelect: (value) => {
      const picked = section.options?.find((o) => o.value === value);
      if (picked != null) section.onSelect?.(picked.value);
    },
  };
}
