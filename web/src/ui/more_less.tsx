import * as stylex from '@stylexjs/stylex';
import { ChevronDown } from 'lucide-react';
import { focusRing } from './focus_ring';
import { MoreLessStrings } from './more_less.strings';
import { color, font } from './tokens.stylex';

const COARSE = '@media (pointer: coarse)';

const styles = stylex.create({
  button: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingTop: { default: '6px', [COARSE]: '10px' },
    paddingBottom: { default: 0, [COARSE]: '10px' },
    paddingInline: 0,
    margin: 0,
    cursor: 'pointer',
    fontFamily: font.mono,
    fontSize: { default: '11px', [COARSE]: '13px' },
    color: { default: color.boneDim, ':hover': color.bone },
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
  },
  chevron: {
    transition: 'transform 120ms ease',
  },
  open: {
    transform: 'rotate(180deg)',
  },
});

// Keeps a panel to a few lines: the rest is one click away, at the same type
// size, so nothing reads as a different level of importance than it is.
export function MoreLess({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button type="button" {...stylex.props(styles.button, focusRing.ring)} aria-expanded={open} onClick={onToggle}>
      <ChevronDown size={12} {...stylex.props(styles.chevron, open && styles.open)} />
      {open ? MoreLessStrings.showLess() : MoreLessStrings.showMore(count)}
    </button>
  );
}
