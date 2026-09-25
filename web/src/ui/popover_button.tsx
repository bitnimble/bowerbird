import { Popover } from '@base-ui-components/react/popover';
import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { buttonProps, buttonStyles } from './button';
import { menuStyles } from './menu_styles';
import { PanelsInPopup } from './panel';
import { Tooltip } from './tooltip';

export function PopoverButton({
  trigger,
  label,
  iconOnly = false,
  active = false,
  badge,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  /** The name a trigger that is only an icon cannot say for itself. */
  label?: string;
  iconOnly?: boolean;
  active?: boolean;
  /** A count in the trigger's corner, for a toolbar whose controls are all one icon wide. */
  badge?: number;
  /** Which of the trigger's edges the popup lines up with: `end` for a trigger at a bar's end. */
  align?: 'start' | 'end';
  children: ReactNode;
}): JSX.Element {
  return (
    <Popover.Root>
      <Tooltip label={iconOnly ? label : undefined}>
        <Popover.Trigger
          {...buttonProps('default', iconOnly, badge != null && buttonStyles.holdsBadge)}
          aria-label={label}
          aria-pressed={active}
        >
          {trigger}
          {badge != null && <span {...stylex.props(buttonStyles.badge)}>{badge}</span>}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner {...stylex.props(menuStyles.positioner)} sideOffset={4} align={align}>
          <Popover.Popup {...stylex.props(menuStyles.popup, menuStyles.popupPad)}>
            <PanelsInPopup.Provider value>{children}</PanelsInPopup.Provider>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
