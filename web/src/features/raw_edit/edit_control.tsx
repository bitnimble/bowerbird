import * as stylex from '@stylexjs/stylex';
import { RotateCcw } from 'lucide-react';
import { focusRing } from '../../ui/focus_ring';
import { Text } from '../../ui/text';
import { EditControlStrings } from './edit_control.strings';
import { styles } from './raw_edit_panel.stylex';

/** One parameter: what it is, where it stands, and the two ways back to where it started. */
export function EditControl({
  label,
  value,
  reset,
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
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.control)} onDoubleClick={reset ?? undefined}>
      <div {...stylex.props(styles.head)}>
        {/* Body rather than `label`: the group's own title wears that. */}
        <Text as="span" style={styles.name}>
          {label}
        </Text>
        <Text variant="mono" as="span" style={styles.value}>
          {value}
        </Text>
        {/* Held in the row rather than removed from it, so crossing the rest position does
            not shuffle the label and the number sideways under the pointer. */}
        <button
          type="button"
          {...stylex.props(styles.reset, focusRing.ring, reset == null && styles.resetClean)}
          title={EditControlStrings.resetControl(label)}
          aria-label={EditControlStrings.resetControl(label)}
          disabled={reset == null}
          onClick={reset ?? undefined}
        >
          <RotateCcw size={12} {...stylex.props(styles.resetIcon)} />
        </button>
      </div>
      {children}
    </div>
  );
}
