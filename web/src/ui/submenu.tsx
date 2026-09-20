import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { MenuItems } from './menu_items';
import { menuStyles } from './menu_styles';
import type { Option } from './option';

/** A menu row that opens a menu of its own. */
export function Submenu<T extends string>({
  label,
  icon,
  options,
  onSelect,
  disabled = false,
  title,
}: {
  label: string;
  icon?: ReactNode;
  options: Option<T>[];
  onSelect: (value: T) => void;
  disabled?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger {...stylex.props(menuStyles.item)} disabled={disabled} title={title}>
        {icon}
        {label}
        {/* Filled and strokeless, unlike every other icon here: this is punctuation
            on the label rather than an icon of its own, so it is held under the
            label's x-height, and lucide's 2px stroke at that size is half the mark
            again. `Play` draws the triangle's rounded corners in its own path, so
            dropping the stroke costs nothing. */}
        <Play size={7} strokeWidth={0} fill="currentColor" {...stylex.props(menuStyles.into)} />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        {/* Which way "away from the menu it hangs off" is depends on the writing direction. */}
        <Menu.Positioner {...stylex.props(menuStyles.positioner)} side="inline-end" align="start" sideOffset={4}>
          <Menu.Popup {...stylex.props(menuStyles.popup)}>
            <MenuItems options={options} onSelect={onSelect} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
