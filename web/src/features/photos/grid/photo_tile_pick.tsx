import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import type React from 'react';
import { focusRing } from '../../../ui/focus_ring';
import { color, size } from '../../../ui/tokens.stylex';
import { tileMarker } from './grid.stylex';
import { PhotoGridStrings } from './photo_grid.strings';

const COARSE = '@media (pointer: coarse)';
const EDGE_INSET = `calc(${size.tilePad} + 6px)`;

const styles = stylex.create({
  // Top left, the corner a photograph is least often about, and the size a finger needs.
  pick: {
    position: 'absolute',
    left: EDGE_INSET,
    top: EDGE_INSET,
    zIndex: 3,
    width: '24px',
    height: '24px',
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: 'rgb(232 228 218 / 0.85)',
    borderRadius: size.radius,
    backgroundColor: 'rgb(9 11 14 / 0.35)',
    color: color.bone,
    cursor: 'pointer',
    // :focus-visible rather than :focus-within, so the box a click left focused does not stay
    // drawn on a tile the pointer has moved off. A finger has no hover and a tap leaves one
    // stuck, so on a touch screen the box waits for a long press to start a selection, and until
    // then does not take a tap meant for the photo.
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover', tileMarker)]: 1,
      [stylex.when.ancestor(':has(:focus-visible)', tileMarker)]: 1,
      [COARSE]: 0,
    },
    pointerEvents: { default: null, [COARSE]: 'none' },
    transitionProperty: 'opacity',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
  },
  selecting: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover', tileMarker)]: 1,
      [stylex.when.ancestor(':has(:focus-visible)', tileMarker)]: 1,
      [COARSE]: 1,
    },
    pointerEvents: 'auto',
  },
  picked: {
    opacity: 1,
    backgroundColor: color.satin,
    borderColor: color.satin,
  },
  tick: {
    opacity: 0,
  },
  ticked: {
    opacity: 1,
  },
});

export function PhotoTilePick({
  checked,
  selecting,
  name,
  onToggle,
}: {
  checked: boolean;
  /** Whether anything in the grid is selected. */
  selecting: boolean;
  name: string;
  /** Takes the event: shift-click extends a span here as it does on the frame. */
  onToggle: (event: React.MouseEvent) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      {...stylex.props(styles.pick, selecting && styles.selecting, checked && styles.picked, focusRing.ring)}
      role="checkbox"
      aria-checked={checked}
      aria-label={PhotoGridStrings.pick(name)}
      onClick={onToggle}
    >
      <Check {...stylex.props(checked ? styles.ticked : styles.tick)} size={14} strokeWidth={3} aria-hidden="true" />
    </button>
  );
}
