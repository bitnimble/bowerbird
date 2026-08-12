import { Radio } from '@base-ui-components/react/radio';
import { RadioGroup } from '@base-ui-components/react/radio-group';
import { Toggle } from '@base-ui-components/react/toggle';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';
import type { Option } from './option';

/**
 * One-of-N. The buttons are `.ui-btn`s like any other, so a filter chip and a
 * toolbar button cannot drift apart in height or type.
 *
 * **`as="radio"` says one-of-N to a screen reader, and it is not the default.** A radio group is
 * the honest role for every control here - it names the group, says which member is current, and
 * moves the selection with the arrow keys - and that last part is why it is opt-in. The grid's
 * filters and view switcher sit on a page where the arrow keys walk the *photographs*, so a
 * radio group under the reader's focus would eat them: click "Rejects", press right, and the
 * selection changes instead of the cursor moving. Where a control is the only thing arrow keys
 * could sensibly mean - the editor's tool selector, on a stage with no cursor to walk - it takes
 * the role and the behaviour together.
 *
 * The two render identically. What differs is the role, the arrow keys, and that a radio cannot
 * be un-chosen - which is what a one-of-N means, and which the toggle group has to ignore an
 * empty selection by hand to imitate.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  stretch = false,
  as = 'toggle',
}: {
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  stretch?: boolean;
  as?: 'toggle' | 'radio';
}): JSX.Element {
  const className = `ui-seg${stretch ? ' ui-seg--stretch' : ''}`;
  const itemClass = (option: Option<T>): string =>
    `ui-btn ui-btn--seg${option.tone == null ? '' : ` ui-btn--${option.tone}`}${
      option.iconOnly === true ? ' ui-btn--icon' : ''
    }`;
  const contents = (option: Option<T>): JSX.Element => (
    <>
      {option.icon}
      {option.iconOnly === true ? null : option.label}
      {option.hint != null && <span className="ui-btn__hint">{option.hint}</span>}
    </>
  );

  if (as === 'radio') {
    return (
      <RadioGroup
        className={className}
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
            className={itemClass(option)}
          >
            {contents(option)}
          </Radio.Root>
        ))}
      </RadioGroup>
    );
  }

  return (
    <ToggleGroup
      className={className}
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
          className={itemClass(option)}
        >
          {contents(option)}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
