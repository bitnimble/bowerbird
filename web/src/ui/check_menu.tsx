import { Menu } from '@base-ui-components/react/menu';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON } from './icon';
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
  closeOnSelect = false,
}: {
  trigger: ReactNode;
  active?: boolean;
  options: Option<T>[];
  selected: readonly T[];
  onToggle: (value: T, checked: boolean) => void;
  disabled?: boolean;
  /** For a menu of one-shot actions rather than a set of filters to tick. */
  closeOnSelect?: boolean;
}): JSX.Element {
  return (
    <Menu.Root>
      {/* The trigger is the button itself, not a wrapper around one: base-ui
          needs a real <button> for its keyboard and ARIA wiring. */}
      <Menu.Trigger className="ui-btn ui-btn--default" aria-pressed={active} disabled={disabled}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="ui-positioner" sideOffset={4}>
          <Menu.Popup className="ui-popup">
            {options.map((option) => (
              <Menu.CheckboxItem
                key={option.value}
                className="ui-item"
                closeOnClick={closeOnSelect}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => onToggle(option.value, checked)}
              >
                <Menu.CheckboxItemIndicator className="ui-item__check">
                  <Check size={ICON} />
                </Menu.CheckboxItemIndicator>
                {option.icon}
                {option.label}
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
