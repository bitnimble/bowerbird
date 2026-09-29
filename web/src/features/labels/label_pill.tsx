import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { focusRing } from '../../ui/focus_ring';
import { LabelPillStrings } from './label_pill.strings';

const styles = stylex.create({
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    height: '22px',
    paddingInline: '8px 3px',
    borderRadius: '11px',
    fontSize: '13.2px',
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
  remove: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    padding: 0,
    borderWidth: 0,
    borderRadius: '8px',
    backgroundColor: { default: 'transparent', ':hover': 'rgba(0, 0, 0, 0.18)' },
    color: 'inherit',
    cursor: 'pointer',
  },
});

const DARK_TEXT = '#14161a';
const LIGHT_TEXT = '#f4f1ea';

/** Whichever of a dark and a light text reads better on a label's colour. */
export function textOn(colour: string): string {
  const channel = (offset: number): number => {
    const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Where the contrast against black and against white cross.
  return luminance > 0.179 ? DARK_TEXT : LIGHT_TEXT;
}

export function LabelPill({
  name,
  colour,
  onRemove,
}: {
  name: string;
  colour: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <span
      role="listitem"
      {...stylex.props(styles.pill)}
      style={{ backgroundColor: colour, color: textOn(colour) }}
    >
      {name}
      <button
        type="button"
        {...stylex.props(styles.remove, focusRing.ring)}
        aria-label={LabelPillStrings.remove(name)}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}
