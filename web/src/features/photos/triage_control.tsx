import { CircleDashed, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Triage } from '../../api/client';
import { ICON, type Option, SegmentedControl } from '../../ui/ui';

// Undecided first: it is where every photo starts, and reject/pick then read
// left-to-right as the two directions you can move it. The keys sit together on
// the bottom row so the left hand never leaves them during a pass.
export const TRIAGE_KEYS: Record<string, Triage> = { z: 'untriaged', x: 'rejected', c: 'picked' };

const OPTIONS: Option<Triage>[] = [
  { value: 'untriaged', label: 'Undecided', icon: <CircleDashed size={ICON} />, hint: 'Z' },
  { value: 'rejected', label: 'Reject', icon: <ThumbsDown size={ICON} />, tone: 'reject', hint: 'X' },
  { value: 'picked', label: 'Pick', icon: <ThumbsUp size={ICON} />, tone: 'pick', hint: 'C' },
];

// Three states, not a checkbox: "not yet decided" is different from "decided
// against", and a two-state control cannot say which one a photo is in.
export function TriageControl({ value, onChange }: { value: Triage; onChange: (next: Triage) => void }): JSX.Element {
  return <SegmentedControl stretch label="Triage" options={OPTIONS} value={value} onChange={onChange} />;
}
