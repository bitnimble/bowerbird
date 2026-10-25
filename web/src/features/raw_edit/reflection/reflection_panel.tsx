import * as stylex from '@stylexjs/stylex';
import { Brush } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { REFLECTION_MODEL } from '../../../../../src/schemas/models';
import { MOST_REFLECTION_STROKES } from '../../../../../src/schemas/stored_grid';
import { usePresenters, useUpdatesStore } from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { CheckLabel } from '../../../ui/check_label';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import type { Option } from '../../../ui/option';
import { SegmentedControl } from '../../../ui/segmented_control';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { UpdatesStrings } from '../../updates/updates.strings';
import { EditControl } from '../edit_control';
import type { EditStore } from '../edit/edit_store';
import { EditSlider } from '../edit_slider';
import { REFLECTION, reading } from '../edit_sliders';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import { styles } from '../raw_edit_panel.stylex';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import { ReflectionPanelStrings } from './reflection_panel.strings';
import {
  DEFAULT_BRUSH_SIZE,
  LEAST_BRUSH_SIZE,
  MOST_BRUSH_SIZE,
  type BrushMode,
  type ReflectionStore,
} from './reflection_store';

const MODES: Option<BrushMode>[] = [
  { value: 'remove', label: ReflectionPanelStrings.remove() },
  { value: 'keep', label: ReflectionPanelStrings.keep() },
];

const SIZE_PERCENT = { min: LEAST_BRUSH_SIZE * 100, max: MOST_BRUSH_SIZE * 100, step: 1 };

export const ReflectionPanel = observer(function ReflectionPanel({
  edit,
  stage,
  store,
  presenter,
}: {
  edit: EditStore;
  stage: StageStore;
  store: ReflectionStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const reflection = presenter.reflection;
  const updates = useUpdatesStore();
  const { updates: models } = usePresenters();
  // The brush is this panel's: shown elsewhere, a drag on the stage pans again.
  useEffect(() => () => reflection.setBrushing(false), [reflection]);
  // Unknown until the updates check answers, which is no reason to shut the panel meanwhile.
  const missing =
    updates.models != null && !updates.models.current.files.includes(`${REFLECTION_MODEL}.bin`);
  const on = store.enabled;
  const shut = !on || !stage.editable;
  const percent = Math.round(store.size * 100);
  const format = (at: number): string => RawEditPanelStrings.percent(reading(at, SIZE_PERCENT));
  return (
    <>
      {missing && (
        <>
          <Text variant="muted" as="p">
            {updates.modelsAvailable != null
              ? ReflectionPanelStrings.needsModels()
              : updates.modelsFailure != null
                ? ReflectionPanelStrings.couldNotCheck()
                : ReflectionPanelStrings.noModels()}
          </Text>
          {updates.modelsAvailable != null && (
            <div {...stylex.props(styles.actions)}>
              <Button
                disabled={updates.modelsDownloading}
                onClick={() => void models.downloadModels()}
              >
                {UpdatesStrings.modelsUpdateAvailable()}
              </Button>
            </div>
          )}
        </>
      )}
      <CheckLabel style={styles.check}>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={on}
          disabled={!stage.editable || (missing && !on)}
          onChange={(event) => reflection.setEnabled(event.currentTarget.checked)}
        />
        <Text as="span" style={styles.name}>
          {ReflectionPanelStrings.removeReflections()}
        </Text>
      </CheckLabel>
      <EditSlider
        edit={edit}
        stage={stage}
        presenter={presenter}
        spec={REFLECTION}
        disabled={!on}
      />
      <div {...stylex.props(styles.actions)}>
        <Button
          aria-pressed={store.painting}
          disabled={shut || store.full}
          onClick={() => reflection.setBrushing(!store.painting)}
        >
          <Brush size={ICON} />
          {ReflectionPanelStrings.brush()}
        </Button>
        <SegmentedControl
          as="radio"
          label={ReflectionPanelStrings.brushMode()}
          options={MODES}
          value={store.mode}
          onChange={reflection.setMode}
        />
      </div>
      <EditControl
        label={ReflectionPanelStrings.size()}
        value={format(percent)}
        reset={
          shut || store.size === DEFAULT_BRUSH_SIZE
            ? null
            : () => reflection.setSize(DEFAULT_BRUSH_SIZE)
        }
        typing={shut ? null : { ...SIZE_PERCENT, set: (typed) => reflection.setSize(typed / 100) }}
      >
        <Slider
          style={styles.slider}
          value={percent}
          onChange={(next) => reflection.setSize(next / 100)}
          onCommit={(next) => reflection.setSize(next / 100)}
          {...SIZE_PERCENT}
          label={ReflectionPanelStrings.size()}
          valueText={format}
          disabled={shut}
        />
      </EditControl>
      {store.full && (
        <Text variant="muted" as="p">
          {ReflectionPanelStrings.strokeLimit(MOST_REFLECTION_STROKES)}
        </Text>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button disabled={shut || store.strokeCount === 0} onClick={reflection.clear}>
          {ReflectionPanelStrings.clearStrokes()}
        </Button>
      </div>
    </>
  );
});
