import * as stylex from '@stylexjs/stylex';
import { color, size } from './tokens.stylex';

const AUTOFILL = ':-webkit-autofill';

/** The dark bed text is typed into, so a field cannot fall back to the browser's light surface. */
export const fieldStyles = stylex.create({
  bed: {
    backgroundColor: color.field,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: size.radius,
    color: color.bone,
  },
  // Chrome paints its own autofill colours over the background, so only an inset shadow can cover them.
  autofill: {
    WebkitTextFillColor: { default: null, [AUTOFILL]: color.bone },
    caretColor: { default: null, [AUTOFILL]: color.bone },
    boxShadow: { default: null, [AUTOFILL]: `0 0 0 1000px ${color.field} inset` },
  },
});
