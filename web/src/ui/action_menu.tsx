import { Menu } from '@base-ui-components/react/menu';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON } from './icon';
import { type ActionToggle, MenuItems } from './menu_items';
import type { Option } from './option';

// A menu of one-shot actions, as opposed to CheckMenu's independent toggles.
export function ActionMenu<T extends string>({
  trigger,
  label,
  options,
  toggles = [],
  onSelect,
  disabled = false,
}: {
  trigger: ReactNode;
  /** Required when the trigger is an icon, which carries no accessible name. */
  label?: string;
  options: Option<T>[];
  /** Shown below the actions, since these change what the actions do. */
  toggles?: ActionToggle[];
  onSelect: (value: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger className="ui-btn ui-btn--default" aria-label={label} disabled={disabled}>
        {trigger}
        <ChevronDown size={ICON} className="ui-btn__caret" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="ui-positioner" sideOffset={4}>
          <Menu.Popup className="ui-popup">
            <MenuItems options={options} toggles={toggles} onSelect={onSelect} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
