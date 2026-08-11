import { Toggle } from '@base-ui-components/react/toggle';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';
import type { Option } from './option';

// One-of-N. The buttons are `.ui-btn`s like any other, so a filter chip and a
// toolbar button cannot drift apart in height or type.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  stretch = false,
}: {
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  stretch?: boolean;
}): JSX.Element {
  return (
    <ToggleGroup
      className={`ui-seg${stretch ? ' ui-seg--stretch' : ''}`}
      aria-label={label}
      value={value == null ? [] : [value]}
      onValueChange={(next) => {
        const picked = next[next.length - 1];
        // Pressing the pressed item yields an empty array; a one-of-N control has
        // no "none", so that press is simply ignored.
        if (typeof picked === 'string') onChange(picked as T);
      }}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          aria-label={option.iconOnly === true ? option.label : undefined}
          title={option.iconOnly === true ? option.label : undefined}
          data-testid={option.testId}
          className={`ui-btn ui-btn--seg${option.tone == null ? '' : ` ui-btn--${option.tone}`}${
            option.iconOnly === true ? ' ui-btn--icon' : ''
          }`}
        >
          {option.icon}
          {option.iconOnly === true ? null : option.label}
          {option.hint != null && <span className="ui-btn__hint">{option.hint}</span>}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
