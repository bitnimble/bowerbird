import { CircleDashed, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Triage } from '../../api/client';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';

// Undecided first: it is where every photo starts, and reject/pick then read
// left-to-right as the two directions you can move it. The keys sit together on
// the bottom row so the left hand never leaves them during a pass.
export const TRIAGE_KEYS: Record<string, Triage> = { z: 'untriaged', x: 'rejected', c: 'picked' };

const OPTIONS: Option<Triage>[] = [
  { value: 'untriaged', label: 'Undecided', icon: <CircleDashed size={ICON} />, hint: 'Z' },
  { value: 'rejected', label: 'Reject', icon: <ThumbsDown size={ICON} />, tone: 'reject', hint: 'X' },
  { value: 'picked', label: 'Pick', icon: <ThumbsUp size={ICON} />, tone: 'pick', hint: 'C' },
];

// Icon alone in the header: labels would push the path and the menus off a
// single line. The foot bar still spells the three out for a thumb. Title keeps
// the key so hover still teaches Z/X/C after the hint badge is gone.
const COMPACT_OPTIONS: Option<Triage>[] = OPTIONS.map((option) => ({
  ...option,
  iconOnly: true,
  hint: undefined,
  label: option.hint == null ? option.label : `${option.label} (${option.hint})`,
}));

// Three states, not a checkbox: "not yet decided" is different from "decided
// against", and a two-state control cannot say which one a photo is in.
export function TriageControl({
  value,
  onChange,
  compact = false,
  stretch = false,
}: {
  value: Triage;
  onChange: (next: Triage) => void;
  /** Icons only: the detail header, where labelled buttons do not fit. */
  compact?: boolean;
  /** Fill the row: a phone's foot bar. */
  stretch?: boolean;
}): JSX.Element {
  return (
    <SegmentedControl
      stretch={stretch}
      label="Triage"
      options={compact ? COMPACT_OPTIONS : OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
