import { Select as BaseSelect } from '@base-ui-components/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { ICON } from './icon';
import type { Option } from './option';

export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}): JSX.Element {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => next != null && onChange(next as T)}
      // Without this the trigger renders the raw value, not the label.
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger className="ui-btn ui-btn--default" aria-label={label}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="ui-btn__caret">
          <ChevronDown size={ICON} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="ui-positioner" sideOffset={4}>
          <BaseSelect.Popup className="ui-popup">
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className="ui-item">
                <BaseSelect.ItemIndicator className="ui-item__check">
                  <Check size={ICON} />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
