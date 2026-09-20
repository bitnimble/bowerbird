// The three verdicts, named here for every surface that offers one: this control,
// the marks under a grid tile, and the shortcut sheet.
export const TriageControlStrings = {
  undecided: () => 'Undecided',
  reject: () => 'Reject',
  pick: () => 'Pick',
  /** The compact header buttons keep the key in the tooltip, the hint badge being gone. */
  withHint: (label: string, hint: string) => `${label} (${hint})`,
  triage: () => 'Triage',
};
