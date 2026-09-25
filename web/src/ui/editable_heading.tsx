import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { focusRing } from './focus_ring';
import { Heading } from './heading';
import { Text } from './text';
import { TextField } from './text_field';
import { color, size } from './tokens.stylex';
import { Tooltip } from './tooltip';

const styles = stylex.create({
  edit: {
    font: 'inherit',
    color: 'inherit',
    backgroundColor: { default: 'transparent', ':hover': color.glass },
    borderWidth: 0,
    paddingBlock: 0,
    paddingInline: '4px',
    marginBlock: 0,
    marginInline: '-4px',
    borderRadius: size.radius,
    cursor: 'text',
  },
});

export function EditableHeading({
  value,
  label,
  editable,
  refusal,
  validate,
  onRename,
}: {
  value: string;
  /** What renaming this is called: the field has no visible label, and the button hints with it. */
  label: string;
  editable: boolean;
  /** Why a title that is not editable cannot be renamed. */
  refusal?: string;
  /** Why `draft` cannot be saved, or null. An empty or unchanged draft is refused here already. */
  validate?: (draft: string) => string | null;
  onRename: (name: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft == null || !editable) {
    return (
      <Heading>
        {editable ?
          // Named by its text rather than by what it does: a heading takes its own
          // name from its content, so an aria-label here would leave a reader
          // listing the headings hearing "Rename Beach" where the title should be.
          <Tooltip label={label}>
            <button type="button" {...stylex.props(styles.edit, focusRing.ring)} onClick={() => setDraft(value)}>
              {value}
            </button>
          </Tooltip>
        : <Tooltip label={refusal}>
            <span>{value}</span>
          </Tooltip>
        }
      </Heading>
    );
  }

  const next = draft.trim();
  const unchanged = next === '' || next === value;
  const error = unchanged ? null : (validate?.(next) ?? null);

  // Blur takes the edit away whatever state it is in, so a draft that cannot be
  // saved is dropped rather than left standing over a title it does not name.
  const save = (): void => {
    setDraft(null);
    if (error == null && !unchanged) onRename(next);
  };

  return (
    <Heading>
      <TextField
        grow
        autoFocus
        label={label}
        value={draft}
        onChange={setDraft}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && error == null) save();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      {error != null && (
        <Text variant="mono" tone="error">
          {error}
        </Text>
      )}
    </Heading>
  );
}
