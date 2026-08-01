import { Menu } from '@base-ui-components/react/menu';
import { MoreHorizontal } from 'lucide-react';
import { Fragment } from 'react';
import { ICON } from './icon';
import { MenuAction, MenuItems } from './menu_items';
import type { MenuSection } from './menu_section';

// Every menu of a bar that has run out of width, in one popup under one button,
// each still under its own heading. Flat sections rather than submenus: a
// submenu needs a hover or a second tap to open, and this exists for the screens
// that have neither a pointer nor room to spare.
export function OverflowMenu({ label, sections }: { label: string; sections: MenuSection[] }): JSX.Element {
  // Lifted out of their sections to the foot of the menu. A rule below its own
  // heading is enough to fence one off in a menu of its own, but here it would
  // still sit a row above the next section's ordinary actions, halfway up a long
  // popup someone is scrolling with a thumb.
  const destructive = sections.flatMap((section) =>
    section.options.filter((o) => o.destructive === true).map((option) => ({ option, onSelect: section.onSelect })),
  );
  // A section that had nothing but destructive actions would otherwise be a
  // heading over nothing.
  const headed = sections
    .map((section) => ({ ...section, options: section.options.filter((o) => o.destructive !== true) }))
    .filter((section) => section.options.length > 0 || (section.toggles?.length ?? 0) > 0);

  return (
    <Menu.Root>
      <Menu.Trigger className="ui-btn ui-btn--default ui-btn--icon" aria-label={label}>
        <MoreHorizontal size={ICON} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="ui-positioner" sideOffset={4}>
          <Menu.Popup className="ui-popup">
            {headed.map((section, i) => (
              <Fragment key={section.label}>
                {i > 0 && <Menu.Separator className="ui-item__rule" />}
                <Menu.Group>
                  <Menu.GroupLabel className="ui-text ui-text--label ui-item__group">{section.label}</Menu.GroupLabel>
                  <MenuItems options={section.options} toggles={section.toggles} onSelect={section.onSelect} />
                </Menu.Group>
              </Fragment>
            ))}
            {destructive.length > 0 && <Menu.Separator className="ui-item__rule" />}
            {destructive.map(({ option, onSelect }) => (
              <MenuAction key={option.value} option={option} onSelect={onSelect} />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
