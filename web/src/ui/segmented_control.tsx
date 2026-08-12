import { Radio } from '@base-ui-components/react/radio';
import { RadioGroup } from '@base-ui-components/react/radio-group';
import type { Option } from './option';

// One-of-N. The buttons are `.ui-btn`s like any other, so a filter chip and a
// toolbar button cannot drift apart in height or type.
//
// **A radio group and not a toggle group.** They look identical and do not sound it: a toggle
// group is a row of independent pressed/unpressed buttons, which is what a screen reader
// announced - "Crop, toggle button, not pressed" beside two more, with nothing saying the three
// are one choice or which of them is current. A radio group says one of three, names the group,
// and moves the selection with the arrow keys rather than only the focus.
//
// The pressed item cannot be unpressed, which is what a one-of-N means and what a radio gives
// for free; the toggle group had to ignore the empty selection by hand.
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
    <RadioGroup
      className={`ui-seg${stretch ? ' ui-seg--stretch' : ''}`}
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next as T);
      }}
    >
      {options.map((option) => (
        <Radio.Root
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
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
