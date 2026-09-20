import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, EllipsisVertical } from 'lucide-react';
import { buttonProps } from './button';
import { ICON } from './icon';
import { MenuAction, MenuItems } from './menu_items';
import type { MenuSection } from './menu_section';
import { menuStyles } from './menu_styles';
import { Section, Sections } from './section';

const NARROW = '@media (max-width: 860px)';

const styles = stylex.create({
  wide: { display: { default: null, [NARROW]: 'none' } },
  narrow: { display: { default: 'none', [NARROW]: 'block' } },
});

// Every menu a bar offers, in one popup under one button, each still under its
// own heading.
export function OverflowMenu({ label, sections }: { label: string; sections: MenuSection[] }): JSX.Element {
  // Lifted out of their sections to the foot of the menu. A rule below its own
  // heading is enough to fence one off in a menu of its own, but here it would
  // still sit a row above the next section's ordinary actions, halfway up a long
  // popup someone is scrolling with a thumb.
  const destructive = sections.flatMap((section) =>
    (section.options ?? [])
      .filter((o) => o.destructive === true)
      .map((option) => ({ option, onSelect: section.onSelect ?? (() => undefined) })),
  );
  // A section that had nothing but destructive actions would otherwise be a
  // heading over nothing.
  const headed = sections
    .map((section) => ({ ...section, options: (section.options ?? []).filter((o) => o.destructive !== true) }))
    .filter((section) => section.options.length > 0 || section.content != null);

  return (
    <Menu.Root>
      <Menu.Trigger {...buttonProps('default', true)} aria-label={label} title={label}>
        {/* Both drawn and one shown, rather than a media query read in JS: nothing here
            depends on the width except which glyph, and a hook would re-render the bar on
            every frame of a resize to answer it. */}
        <Ellipsis size={ICON} {...stylex.props(styles.wide)} />
        <EllipsisVertical size={ICON} {...stylex.props(styles.narrow)} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner {...stylex.props(menuStyles.positioner)} sideOffset={4} align="end">
          <Menu.Popup {...stylex.props(menuStyles.popup)}>
            {/* Absent rather than empty: a menu of nothing but destructive actions would
                otherwise open on a blank group and a rule above its first row. */}
            {headed.length > 0 && (
              <Sections>
                {headed.map((section, index) => (
                  <Section key={section.label ?? index} label={section.label}>
                    {section.content}
                    <MenuItems options={section.options} onSelect={section.onSelect ?? (() => undefined)} />
                  </Section>
                ))}
              </Sections>
            )}
            {headed.length > 0 && destructive.length > 0 && <Menu.Separator {...stylex.props(menuStyles.rule)} />}
            {destructive.map(({ option, onSelect }) => (
              <MenuAction key={option.value} option={option} onSelect={onSelect} />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
