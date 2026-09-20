import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonProps, buttonStyles } from './button';
import { ICON } from './icon';
import { MenuItems } from './menu_items';
import { menuStyles } from './menu_styles';
import type { Option } from './option';

// A menu of one-shot actions, as opposed to CheckMenu's independent toggles.
export function ActionMenu<T extends string>({
  trigger,
  label,
  options,
  onSelect,
  disabled = false,
  iconOnly = false,
}: {
  trigger: ReactNode;
  /** Required when the trigger is an icon, which carries no accessible name. */
  label?: string;
  options: Option<T>[];
  onSelect: (value: T) => void;
  disabled?: boolean;
  /** Icon trigger with no caret: row overflow (⋮), not a labelled dropdown. */
  iconOnly?: boolean;
}): JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger {...buttonProps('default', iconOnly)} aria-label={label} disabled={disabled}>
        {trigger}
        {!iconOnly && <ChevronDown size={ICON} {...stylex.props(buttonStyles.caret)} />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner {...stylex.props(menuStyles.positioner)} sideOffset={4} align="end">
          <Menu.Popup {...stylex.props(menuStyles.popup)}>
            <MenuItems options={options} onSelect={onSelect} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
