import * as stylex from '@stylexjs/stylex';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { type Triage } from '../../../../src/schemas/photos';
import { focusRing } from '../../ui/focus_ring';
import { color, size } from '../../ui/tokens.stylex';
import { MarksStrings } from './marks.strings';
import { PhotoDetailStrings } from './viewer/photo_detail_page.strings';
import { TriageControlStrings } from './stack_triage/triage_control.strings';

const COARSE = '@media (pointer: coarse)';

const styles = stylex.create({
  verdict: {
    display: 'flex',
    gap: '2px',
  },
  verdictLarge: {
    marginBlock: 0,
    marginInline: '2px',
  },
  verdictButton: {
    display: 'grid',
    placeItems: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    borderWidth: 0,
    borderRadius: '3px',
    backgroundColor: 'rgba(10, 12, 16, 0.7)',
    color: { default: '#7d8492', ':hover': color.bone },
    cursor: 'pointer',
    lineHeight: 0,
  },
  verdictButtonLarge: {
    width: '26px',
    height: '26px',
    borderRadius: size.radius,
  },
  picked: {
    backgroundColor: color.moss,
    color: '#04180b',
  },
  rejected: {
    backgroundColor: color.rose,
    color: '#200807',
  },
  // The glyph is the target, so the row grows with it on a finger.
  rating: {
    display: 'flex',
    gap: { default: '4px', [COARSE]: '10px' },
    fontSize: { default: '16px', [COARSE]: '26px' },
  },
  // Under a photograph: small enough not to compete with it, and not grown on a phone.
  ratingSmall: {
    gap: '2px',
    fontSize: '11px',
  },
  star: {
    padding: { default: 0, [COARSE]: '4px' },
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontSize: 'inherit',
    lineHeight: 1,
    color: '#464c58',
    cursor: 'pointer',
  },
  starSmall: {
    padding: 0,
  },
  starOn: {
    color: color.glass,
  },
  starPreview: {
    color: '#6d7788',
  },
});

// The two decisions a cull is mostly made of, as controls a tile's foot and the
// bulk bar both draw. Presentational, so one takes a photograph's own marks and
// the other the selection's, and `null` is "not one answer" - a mixed selection,
// which reads as nothing set and is what pressing either would settle.

export function Verdict({
  triage,
  onSet,
  large = false,
}: {
  triage: Triage | null;
  onSet: (triage: Triage) => void;
  /** At the size of the controls beside it, where the verdict is what the hand is going for. */
  large?: boolean;
}): JSX.Element {
  const rejected = triage === 'rejected';
  const picked = triage === 'picked';
  const icon = large ? 16 : 12;
  const button = (on: boolean, onStyle: stylex.StyleXStyles): ReturnType<typeof stylex.props> =>
    stylex.props(styles.verdictButton, large && styles.verdictButtonLarge, on && onStyle, focusRing.ring);
  return (
    <span {...stylex.props(styles.verdict, large && styles.verdictLarge)}>
      <button
        type="button"
        {...button(rejected, styles.rejected)}
        aria-label={rejected ? MarksStrings.clearReject() : TriageControlStrings.reject()}
        aria-pressed={rejected}
        // Pressing the verdict already carried clears it, so one control covers
        // all three states.
        onClick={() => onSet(rejected ? 'untriaged' : 'rejected')}
      >
        <ThumbsDown size={icon} />
      </button>
      <button
        type="button"
        {...button(picked, styles.picked)}
        aria-label={picked ? MarksStrings.clearPick() : TriageControlStrings.pick()}
        aria-pressed={picked}
        onClick={() => onSet(picked ? 'untriaged' : 'picked')}
      >
        <ThumbsUp size={icon} />
      </button>
    </span>
  );
}

export function Rating({
  rating,
  onSet,
  focusable = true,
  small = false,
  style,
}: {
  rating: number | null;
  onSet: (rating: number) => void;
  /**
   * Off inside a menu popup, where the first tabbable element takes the focus the
   * menu's own items need: a star there leaves every action in the popup
   * unreachable by keyboard, and no arrow key ever gets past it.
   */
  focusable?: boolean;
  /** For a tile's foot, where the stars sit under a photograph rather than beside a label. */
  small?: boolean;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  // What the rating would become, so the whole run up to the pointer lights rather
  // than the one star under it - dimmer than a rating that has actually been set.
  const [hovered, setHovered] = useState<number | null>(null);
  const lit = (n: number): stylex.StyleXStyles => {
    if (hovered != null) return n <= hovered && styles.starPreview;
    return rating != null && n <= rating && styles.starOn;
  };

  return (
    <span
      {...stylex.props(styles.rating, small && styles.ratingSmall, style)}
      role="group"
      aria-label={PhotoDetailStrings.rating()}
      onPointerLeave={() => setHovered(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          tabIndex={focusable ? undefined : -1}
          {...stylex.props(styles.star, small && styles.starSmall, lit(n), focusRing.ring)}
          onPointerEnter={() => setHovered(n)}
          aria-label={PhotoDetailStrings.setRatingTo(n)}
          aria-pressed={rating != null && n <= rating}
          // Clicking the star already sat on clears the rating, so one control
          // both sets and unsets without a separate "no rating" target.
          onClick={() => onSet(n === rating ? 0 : n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}
