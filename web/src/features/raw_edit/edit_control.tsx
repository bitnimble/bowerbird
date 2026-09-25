import * as stylex from '@stylexjs/stylex';
import { RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { focusRing } from '../../ui/focus_ring';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Text, textStyles } from '../../ui/text';
import { Tooltip } from '../../ui/tooltip';
import { EditControlStrings } from './edit_control.strings';
import { typedValue, type TypedRange } from './edit_sliders';
import { styles } from './raw_edit_panel.stylex';

/** One parameter chosen from a list: its name, and the list at the row's end. */
export function SelectControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.control, styles.selectRow)}>
      <Text as="span" style={styles.name}>
        {label}
      </Text>
      <Select style={styles.selectEnd} label={label} options={options} value={value} onChange={onChange} />
    </div>
  );
}

/** One parameter: what it is, where it stands, and the two ways back to where it started. */
export function EditControl({
  label,
  value,
  reset,
  typing,
  children,
}: {
  label: string;
  value: string;
  /**
   * How to put this parameter back, or null where there is nothing to put back *or* nothing
   * that could act on it yet: the button and the double click both read this one value, so a
   * row whose slider is shut must pass null or it still takes a double click.
   */
  reset: (() => void) | null;
  /** Makes the readout a field a value can be typed into, in the units it reads in. Null while shut. */
  typing?: Typing | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.control)} onDoubleClick={reset ?? undefined}>
      <div {...stylex.props(styles.head)}>
        {/* Body rather than `label`: the group's own title wears that. */}
        <Text as="span" style={styles.name}>
          {label}
        </Text>
        {typing == null ?
          <Text variant="mono" as="span" style={styles.value}>
            {value}
          </Text>
        : <TypedReadout label={label} value={value} typing={typing} />}
        {/* Held in the row rather than removed from it, so crossing the rest position does
            not shuffle the label and the number sideways under the pointer. */}
        <Tooltip label={EditControlStrings.resetControl(label)}>
          <button
            type="button"
            {...stylex.props(styles.reset, focusRing.ring, reset == null && styles.resetClean)}
            aria-label={EditControlStrings.resetControl(label)}
            disabled={reset == null}
            onClick={reset ?? undefined}
          >
            <RotateCcw size={12} {...stylex.props(styles.resetIcon)} />
          </button>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

export interface Typing extends TypedRange {
  set: (value: number) => void;
}

function TypedReadout({ label, value, typing }: { label: string; value: string; typing: Typing }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = (): void => {
    // An untouched draft is the readout, rounded: committing it would round the stored value.
    const typed = draft == null || draft === value || cancelled.current ? null : typedValue(draft, typing);
    cancelled.current = false;
    setDraft(null);
    if (typed != null) typing.set(typed);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      {...stylex.props(textStyles.mono, styles.value, styles.typed, focusRing.ring)}
      aria-label={EditControlStrings.valueOf(label)}
      value={draft ?? value}
      onFocus={(event) => {
        setDraft(value);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') cancelled.current = true;
        if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
      }}
      // Selecting a word of the number is a double click, which on the row resets it.
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
