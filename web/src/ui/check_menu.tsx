import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonProps } from './button';
import { ICON } from './icon';
import { menuStyles } from './menu_styles';
import type { Option } from './option';

// A menu of independent checkboxes: several can be on at once, and it stays open
// while they are being chosen unless `closeOnSelect` says otherwise.
export function CheckMenu<T extends string>({
  trigger,
  active = false,
  options,
  selected,
  onToggle,
  disabled = false,
  title,
  closeOnSelect = false,
}: {
  trigger: ReactNode;
  active?: boolean;
  options: Option<T>[];
  selected: readonly T[];
  onToggle: (value: T, checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  /** For a menu of one-shot actions rather than a set of filters to tick. */
  closeOnSelect?: boolean;
}): JSX.Element {
  return (
    <Menu.Root>
      {/* The trigger is the button itself, not a wrapper around one: base-ui
          needs a real <button> for its keyboard and ARIA wiring. */}
      <Menu.Trigger {...buttonProps('default', false)} aria-pressed={active} disabled={disabled} title={title}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner {...stylex.props(menuStyles.positioner)} sideOffset={4} align="end">
          <Menu.Popup {...stylex.props(menuStyles.popup)}>
            {options.map((option) => (
              <MenuCheckItem
                key={option.value}
                icon={option.icon}
                label={option.label}
                closeOnClick={closeOnSelect}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => onToggle(option.value, checked)}
              />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A menu row that stays ticked, rather than one that fires once. */
export function MenuCheckItem({
  icon,
  label,
  checked,
  onCheckedChange,
  closeOnClick = false,
}: {
  icon?: ReactNode;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  closeOnClick?: boolean;
}): JSX.Element {
  return (
    <Menu.CheckboxItem
      {...stylex.props(menuStyles.item)}
      closeOnClick={closeOnClick}
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      {icon}
      {label}
      <Menu.CheckboxItemIndicator {...stylex.props(menuStyles.check)}>
        <Check size={ICON} />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}
