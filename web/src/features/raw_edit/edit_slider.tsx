import { observer } from 'mobx-react-lite';
import { Slider } from '../../ui/slider';
import { EditControl } from './edit_control';
import type { EditStore } from './edit/edit_store';
import { reading, sliderValue, snapped, type SliderSpec } from './edit_sliders';
import { RawEditPanelStrings } from './raw_edit_panel.strings';
import { styles } from './raw_edit_panel.stylex';
import type { RawEditPresenter } from './stage/raw_edit_presenter';
import type { StageStore } from './stage/stage_store';

export const EditSlider = observer(function EditSlider({
  edit,
  stage,
  presenter,
  spec,
  disabled,
}: {
  edit: EditStore;
  stage: StageStore;
  presenter: RawEditPresenter;
  spec: SliderSpec;
  /** For a slider whose group has a switch above it, and means nothing while that is off. */
  disabled?: boolean;
}): JSX.Element {
  const stored = edit.doc?.[spec.key];
  const follows = spec.follows != null;
  // Where something else answers for the slider, "untouched" is the document holding nothing
  // rather than the document holding a particular number - so the reset arrow goes back to null
  // and the row goes on following it.
  const followed =
    spec.follows === 'photo'
      ? stage.measured?.[spec.key]
      : spec.follows === 'denoiser'
        ? edit.denoiserDefaults[spec.key]
        : undefined;
  const neutral = followed == null ? (spec.neutral ?? 0) : snapped(followed, spec);
  const value = Number(stored ?? neutral);
  const untouched = follows ? stored == null : value === neutral;
  // Blank until the header lands: the measurement comes off it, and a number in its place would
  // state a value the module has not resolved - which is exactly what this row is here to stop.
  const unknown = follows && stored == null && followed == null;
  const shut = disabled === true || !stage.editable;
  const format = (at: number): string =>
    RawEditPanelStrings.valueWithUnit(reading(at, spec), spec.unit ?? '');

  return (
    <EditControl
      label={spec.label}
      value={unknown ? '' : format(value)}
      reset={
        shut || untouched ? null : () => presenter.settle({ [spec.key]: follows ? null : neutral })
      }
      typing={shut ? null : { ...spec, set: (typed) => presenter.settle({ [spec.key]: typed }) }}
    >
      <Slider
        style={styles.slider}
        value={value}
        onChange={(next) => presenter.preview({ [spec.key]: sliderValue(next, spec, neutral) })}
        onCommit={(next) => presenter.settle({ [spec.key]: sliderValue(next, spec, neutral) })}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        snap={[neutral]}
        label={spec.label}
        valueText={format}
        disabled={shut}
      />
    </EditControl>
  );
});
