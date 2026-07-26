import { CircleDashed, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Triage } from '../../api/client';
import { ICON, type Option, SegmentedControl } from '../../ui/ui';

const OPTIONS: Option<Triage>[] = [
  { value: 'rejected', label: 'Reject', icon: <ThumbsDown size={ICON} />, tone: 'reject' },
  { value: 'untriaged', label: 'Undecided', icon: <CircleDashed size={ICON} /> },
  { value: 'picked', label: 'Pick', icon: <ThumbsUp size={ICON} />, tone: 'pick' },
];

// Three states, not a checkbox: "not yet decided" is different from "decided
// against", and a two-state control cannot say which one a photo is in.
export function TriageControl({ value, onChange }: { value: Triage; onChange: (next: Triage) => void }): JSX.Element {
  return <SegmentedControl stretch label="Triage" options={OPTIONS} value={value} onChange={onChange} />;
}
