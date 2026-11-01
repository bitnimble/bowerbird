import { Popover } from '@base-ui-components/react/popover';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight } from 'lucide-react';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { menuStyles } from '../../../ui/menu_styles';
import { styles } from './grid_controls.stylex';

export function openedList<T extends string>(row: T, open: boolean, current: T | null): T | null {
  if (open) return row;
  // Moving from one row to the other closes the first *after* the second has opened, so a
  // close is only its own row's to act on.
  return current === row ? null : current;
}

/**
 * A tick list that opens beside the panel rather than in it: a well-travelled library runs to
 * dozens of bodies or lenses, and a panel that tall is one the calendar under it falls off the
 * screen with.
 */
export function SideListFilter<T extends string>({
  label,
  icon,
  open,
  onOpen,
  options,
  selected,
  enabled,
  onToggle,
}: {
  label: string;
  icon: JSX.Element;
  // Which list is open is the panel's to hold, not each row's: two lists open at once
  // sit on top of each other, where a menu's submenus take turns.
  open: boolean;
  onOpen: (open: boolean) => void;
  options: { value: T; label: string }[];
  selected: readonly T[];
  enabled?: ReadonlySet<T>;
  onToggle: (value: T, checked: boolean) => void;
}): JSX.Element {
  return (
    <Popover.Root open={open} onOpenChange={onOpen}>
      {/* Hover as well as press: the row reads as a submenu, and the panel around it is a
          popover, which has no submenu of its own to borrow the behaviour from. */}
      <Popover.Trigger
        {...stylex.props(menuStyles.item, styles.submenu, focusRing.ring)}
        openOnHover
      >
        {icon}
        {label}
        {/* What is ticked out of sight, so the panel says a list is narrowed without it
            being opened. */}
        {selected.length > 0 && <span {...stylex.props(menuStyles.badge)}>{selected.length}</span>}
        <ChevronRight
          size={ICON}
          {...stylex.props(styles.caret, selected.length === 0 && styles.caretAlone)}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          {...stylex.props(menuStyles.positioner)}
          side="right"
          align="start"
          sideOffset={4}
          sticky
        >
          <Popover.Popup {...stylex.props(menuStyles.popup, styles.models)} aria-label={label}>
            {options.map((option) => (
              <label key={option.value} {...stylex.props(menuStyles.item, styles.check)}>
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  disabled={enabled != null && !enabled.has(option.value)}
                  onChange={(event) => onToggle(option.value, event.target.checked)}
                />
                {option.label}
              </label>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
