/**
 * Which of the stage's modes the pointer is in.
 *
 * One value rather than the two booleans below it because that is what the header's selector
 * is: a one-of-N, where "neither" is a choice a reader makes rather than a state they fall into.
 */
export type EditTool = 'cursor' | 'crop' | 'perspective' | 'repair' | 'loupe';
