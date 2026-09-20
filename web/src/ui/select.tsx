import { Select as BaseSelect } from '@base-ui-components/react/select';
import * as stylex from '@stylexjs/stylex';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonProps, buttonStyles } from './button';
import { ICON } from './icon';
import { menuStyles } from './menu_styles';
import type { Option } from './option';

export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
  icon,
  style,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * The accessible name. An `aria-label` replaces an element's content for naming purposes, so
   * an `icon` control's `label` has to carry the value too - nothing else is left to say it.
   */
  label: string;
  /** Drawn in place of the value, for a control that can spend a square and not a sentence. */
  icon?: ReactNode;
  /** On the trigger. */
  style?: stylex.StyleXStyles;
}): JSX.Element {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => next != null && onChange(next as T)}
      // Without this the trigger renders the raw value, not the label.
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger {...buttonProps('default', icon != null, style)} aria-label={label}>
        {icon ?? (
          <>
            <BaseSelect.Value />
            <BaseSelect.Icon {...stylex.props(buttonStyles.caret)}>
              <ChevronDown size={ICON} />
            </BaseSelect.Icon>
          </>
        )}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner {...stylex.props(menuStyles.positioner)} sideOffset={4} align="start">
          <BaseSelect.Popup {...stylex.props(menuStyles.popup)}>
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} {...stylex.props(menuStyles.item)}>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator {...stylex.props(menuStyles.check)}>
                  <Check size={ICON} />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
