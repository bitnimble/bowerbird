import * as stylex from '@stylexjs/stylex';

const COARSE = '@media (pointer: coarse)';

export const calendarSize = stylex.defineVars({
  // Seven columns of these, and 7 * 40 still fits the narrowest phone.
  day: { default: '30px', [COARSE]: '40px' },
  dayButton: { default: '28px', [COARSE]: '38px' },
});
