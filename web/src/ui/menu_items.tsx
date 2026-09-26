import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import { buttonStyles } from './button';
import { menuStyles } from './menu_styles';
import type { Option } from './option';
import { Tooltip } from './tooltip';

export function MenuAction<T extends string>({
  option,
  onSelect,
}: {
  option: Option<T>;
  onSelect: (value: T) => void;
}): JSX.Element {
  return (
    <Tooltip label={option.tooltip}>
      <Menu.Item
        {...stylex.props(menuStyles.item, option.destructive === true && menuStyles.destructive)}
        disabled={option.disabled === true}
        aria-current={option.active === true}
        render={option.link}
        onClick={option.link == null ? () => onSelect(option.value) : undefined}
      >
        {option.icon}
        {option.label}
        {option.active === true && <span {...stylex.props(menuStyles.dot)} aria-hidden />}
        {/* Out of the accessible name: it would read as part of the label ("Embedded
            JPEG I"), and the shortcut is already announced by the ? help. */}
        {option.hint != null && (
          <span {...stylex.props(buttonStyles.hint, menuStyles.hint)} aria-hidden>
            {option.hint}
          </span>
        )}
      </Menu.Item>
    </Tooltip>
  );
}

// The body of one menu: its actions, the destructive ones fenced off below a
// rule. Its own component so several menus can be laid out in a single popup
// when there is no room for a button each.
export function MenuItems<T extends string>({
  options,
  onSelect,
}: {
  options: Option<T>[];
  onSelect: (value: T) => void;
}): JSX.Element {
  const item = (option: Option<T>): JSX.Element => <MenuAction key={option.value} option={option} onSelect={onSelect} />;
  const destructive = options.filter((o) => o.destructive === true);

  return (
    <>
      {options.filter((o) => o.destructive !== true).map(item)}
      {destructive.length > 0 && <Menu.Separator {...stylex.props(menuStyles.rule)} />}
      {destructive.map(item)}
    </>
  );
}
