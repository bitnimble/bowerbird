import { Menu } from '@base-ui-components/react/menu';
import { Check } from 'lucide-react';
import type { ActionToggle } from './action_toggle';
import { ICON } from './icon';
import type { Option } from './option';

export function MenuAction<T extends string>({
  option,
  onSelect,
}: {
  option: Option<T>;
  onSelect: (value: T) => void;
}): JSX.Element {
  return (
    <Menu.Item
      className={`ui-item ui-item--action${option.destructive === true ? ' ui-item--destructive' : ''}`}
      onClick={() => onSelect(option.value)}
    >
      {option.icon}
      {option.label}
      {/* Out of the accessible name: it would read as part of the label ("Embedded
          JPEG I"), and the shortcut is already announced by the ? help. */}
      {option.hint != null && (
        <span className="ui-btn__hint" aria-hidden>
          {option.hint}
        </span>
      )}
    </Menu.Item>
  );
}

// The body of one menu: its actions, the destructive ones fenced off below a
// rule, then the toggles that change what those actions do. Its own component so
// several menus can be laid out in a single popup when there is no room for a
// button each.
export function MenuItems<T extends string>({
  options,
  toggles = [],
  onSelect,
}: {
  options: Option<T>[];
  toggles?: ActionToggle[];
  onSelect: (value: T) => void;
}): JSX.Element {
  const item = (option: Option<T>): JSX.Element => <MenuAction key={option.value} option={option} onSelect={onSelect} />;
  const destructive = options.filter((o) => o.destructive === true);

  return (
    <>
      {options.filter((o) => o.destructive !== true).map(item)}
      {destructive.length > 0 && <Menu.Separator className="ui-item__rule" />}
      {destructive.map(item)}
      {toggles.length > 0 && <Menu.Separator className="ui-item__rule" />}
      {toggles.map((toggle) => (
        <Menu.CheckboxItem
          key={toggle.label}
          className="ui-item ui-item--action"
          // Stays open: this changes what the actions above it do, so it is
          // set on the way to picking one rather than instead of picking one.
          closeOnClick={false}
          checked={toggle.checked}
          onCheckedChange={toggle.onChange}
        >
          {toggle.icon}
          {toggle.label}
          {/* The span, not the indicator, holds the column: the indicator is
              unmounted when unticked and the row would jump on every click. */}
          <span className="ui-item__check ui-item__check--end">
            <Menu.CheckboxItemIndicator>
              <Check size={ICON} />
            </Menu.CheckboxItemIndicator>
          </span>
        </Menu.CheckboxItem>
      ))}
    </>
  );
}
