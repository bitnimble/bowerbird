export const StackTriageStrings = {
  pickA: () => 'Pick A',
  pickB: () => 'Pick B',
  both: () => 'Pick both',
  bothKey: () => 'Space',
  keysUndo: () => '⌘Z',
  neither: () => 'Reject both',

  queue: () => 'Queue',
  queueLeft: (left: number) => `(${left})`,
  queueCount: (left: number, members: number, remaining: number) =>
    `${left} left (out of ${members}) · up to ${remaining} ${remaining === 1 ? 'round' : 'rounds'}`,
  completed: () => 'Completed',
  nothingJudgedYet: () => 'No verdicts yet',
  keptTheRest: () => 'Picked the remaining photos',
  upcoming: () => 'Upcoming',
  nothingAfterThisRound: () => 'Nothing after this round',
  andMore: (count: number) => `and ${count} more`,

  bothRejected: () => '2 Rejects',

  /** The way out of the session, which is not a wizard's previous step. */
  back: () => 'Back',
  keepTheRest: () => 'Pick remaining photos',

  presentation: () => 'Presentation',
  flip: () => 'Flip',
  split: () => 'Split',

  whichPhotoToShow: () => 'Which photo to show',
  showA: () => 'Show A',
  showB: () => 'Show B',
  peek: () => 'Hold to see the other photo',
  peekTitle: () => 'Hold to see the other photo (Shift)',
  slot: (side: 'a' | 'b', key: string) => `${side === 'a' ? 'A' : 'B'} ${key}`,

  notSaved: (count: number) => `We couldn't save ${count} ${count === 1 ? 'verdict' : 'verdicts'}.`,
  retry: () => 'Retry',

  finishing: () => 'Finishing…',
  loadingTheStack: () => 'Loading the stack…',
  couldNotOpenTheStack: () => "We couldn't open this stack. Try again.",
  nothingToCompare: () => 'No photos to triage',
  tooFewPhotos: () => 'This stack needs at least 2 photos to triage.',

  round: (number: number, a: string, b: string, left: number) => `Round ${number}: ${a} and ${b}. ${left} left.`,
};
