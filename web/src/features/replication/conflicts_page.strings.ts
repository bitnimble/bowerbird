export const ConflictsPageStrings = {
  heading: () => 'Choose your edits',
  nothingToDecide: () => 'No edits to choose',
  nothingToDecideHint: () => 'Photos edited on 2 devices while apart appear here.',
  candidateMeta: (when: string, edits: number) => `${when} · ${edits} ${edits === 1 ? 'edit' : 'edits'}`,
  keepThese: () => 'Keep these edits',
};
