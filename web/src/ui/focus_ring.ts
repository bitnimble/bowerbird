import * as stylex from '@stylexjs/stylex';
import { color } from './tokens.stylex';

export const focusRing = stylex.create({
  ring: {
    outline: { default: null, ':focus-visible': `2px solid ${color.glass}` },
    outlineOffset: { default: null, ':focus-visible': '2px' },
  },
  /** For a control whose focus lands on an element inside it that draws nothing, such as a slider thumb's range input. */
  within: {
    outline: { default: null, ':has(:focus-visible)': `2px solid ${color.glass}` },
    outlineOffset: { default: null, ':has(:focus-visible)': '2px' },
  },
});
