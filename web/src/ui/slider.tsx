import { Slider as BaseSlider } from '@base-ui-components/react/slider';

/**
 * How near the detent a drag has to come to land on it, as a share of the range.
 *
 * A pointer cannot hit an exact value on a 200-unit track, so a slider with a meaningful
 * rest position is one the reader can never get back to by hand. Only a drag: a keypress
 * asks for a specific value and must be given it, or the arrow keys cannot walk past zero.
 *
 * A share of the range, and so wrong for any control whose range is far wider than what is
 * ever asked of it - hence `snap`, which the straighten needs: 1.5% of ±45° swallows every
 * angle a horizon is ever out by.
 */
const SNAP = 0.015;

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  label,
  disabled,
  detent,
  snap,
  tone,
}: {
  value: number;
  onChange: (value: number) => void;
  /**
   * The drag finished, by pointer or by key.
   *
   * Only for controls whose two ends cost different amounts - an exposure drag previews
   * small and settles at full resolution. Where every value costs the same, `onChange`
   * alone is the whole story.
   */
  onCommit?: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled?: boolean;
  /**
   * The value this control rests at, where that is not simply its minimum.
   *
   * A contrast of -40 is a departure from the middle, so the fill runs from there rather
   * than from the left end, a tick marks it, and a drag snaps to it.
   */
  detent?: number;
  /** How near the detent a drag lands on it, in the control's own units. */
  snap?: number;
  /**
   * The track painted as what the control does, for a slider whose two ends are colours.
   *
   * The white balance pair only: which way is warmer and which way is greener is the one
   * thing about them a label cannot say faster than the track can. A toned track carries no
   * fill - there is nothing for a bar to add to a gradient that already reads as a scale.
   */
  tone?: 'temperature' | 'tint';
}): JSX.Element {
  const share = (at: number): number => Math.min(Math.max(((at - min) / (max - min)) * 100, 0), 100);
  const from = share(detent ?? min);
  const to = share(value);
  const within = snap ?? (max - min) * SNAP;
  const held = (next: number, reason: string): number =>
    detent != null && reason === 'drag' && Math.abs(next - detent) < within ? detent : next;

  return (
    <BaseSlider.Root
      className="ui-slider"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next, details) => {
        if (typeof next === 'number') onChange(held(next, details.reason));
      }}
      onValueCommitted={(next, details) => {
        if (typeof next === 'number') onCommit?.(held(next, details.reason));
      }}
    >
      <BaseSlider.Control className="ui-slider__control" aria-label={label}>
        <BaseSlider.Track className={`ui-slider__track${tone == null ? '' : ` ui-slider__track--${tone}`}`}>
          {detent != null && <span className="ui-slider__detent" style={{ left: `${from}%` }} />}
          {/* Ours rather than `BaseSlider.Indicator`, which only ever fills from the minimum. */}
          {tone == null && (
            <span
              className="ui-slider__fill"
              style={{ left: `${Math.min(from, to)}%`, width: `${Math.abs(to - from)}%` }}
            />
          )}
          <BaseSlider.Thumb className="ui-slider__thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
