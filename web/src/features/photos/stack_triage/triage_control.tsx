import { CircleDashed, ThumbsDown, ThumbsUp } from 'lucide-react';
import { type Triage } from '../../../../../src/schemas/photos';
import { ICON } from '../../../ui/icon';
import type { Option } from '../../../ui/option';
import { SegmentedControl } from '../../../ui/segmented_control';
import { TriageControlStrings } from './triage_control.strings';

// Undecided first: it is where every photo starts, and reject/pick then read
// left-to-right as the two directions you can move it. The keys sit together on
// the bottom row so the left hand never leaves them during a pass.
export const TRIAGE_KEYS: Record<string, Triage> = { z: 'untriaged', x: 'rejected', c: 'picked' };

const OPTIONS: Option<Triage>[] = [
  { value: 'untriaged', label: TriageControlStrings.undecided(), icon: <CircleDashed size={ICON} />, hint: 'Z' },
  { value: 'rejected', label: TriageControlStrings.reject(), icon: <ThumbsDown size={ICON} />, tone: 'reject', hint: 'X' },
  { value: 'picked', label: TriageControlStrings.pick(), icon: <ThumbsUp size={ICON} />, tone: 'pick', hint: 'C' },
];

const OPTIONS_WITHOUT_HINTS: Option<Triage>[] = OPTIONS.map((option) => ({ ...option, hint: undefined }));

// Three states, not a checkbox: "not yet decided" is different from "decided
// against", and a two-state control cannot say which one a photo is in.
export function TriageControl({
  value,
  held = null,
  onChange,
  stretch = false,
}: {
  value: Triage;
  /** Shown in place of `value` for a beat, where the viewer steps on as soon as a verdict lands. */
  held?: Triage | null;
  onChange: (next: Triage) => void;
  /** Fill the row: a phone's foot bar. */
  stretch?: boolean;
}): JSX.Element {
  return (
    <SegmentedControl
      stretch={stretch}
      label={TriageControlStrings.triage()}
      options={stretch ? OPTIONS_WITHOUT_HINTS : OPTIONS}
      value={value}
      held={held}
      onChange={onChange}
    />
  );
}
