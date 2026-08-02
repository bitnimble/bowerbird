import { Slider as BaseSlider } from '@base-ui-components/react/slider';

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  label,
  disabled,
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
}): JSX.Element {
  return (
    <BaseSlider.Root
      className="ui-slider"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => typeof next === 'number' && onChange(next)}
      onValueCommitted={(next) => typeof next === 'number' && onCommit?.(next)}
    >
      <BaseSlider.Control className="ui-slider__control" aria-label={label}>
        <BaseSlider.Track className="ui-slider__track">
          <BaseSlider.Indicator className="ui-slider__fill" />
          <BaseSlider.Thumb className="ui-slider__thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
