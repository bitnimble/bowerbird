import { Slider as BaseSlider } from '@base-ui-components/react/slider';

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
}): JSX.Element {
  return (
    <BaseSlider.Root
      className="ui-slider"
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => typeof next === 'number' && onChange(next)}
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
