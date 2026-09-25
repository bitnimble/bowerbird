import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { CheckLabel } from '../../../ui/check_label';
import { focusRing } from '../../../ui/focus_ring';
import type { Option } from '../../../ui/option';
import { Panel } from '../../../ui/panel';
import { Select } from '../../../ui/select';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { EditControl } from '../edit_control';
import { EditToolsStrings } from '../edit_tools.strings';
import { reading } from '../edit_sliders';
import type { EditStore } from '../edit/edit_store';
import type { RawEditPanelStyles } from '../raw_edit_panel.stylex';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import { ASPECT_RATIOS, type AspectKey } from './crop_aspect';
import type { CropStore } from './crop_store';

const ASPECTS: Option<AspectKey>[] = [
  { value: 'custom', label: RawEditPanelStrings.aspectCustom() },
  { value: 'original', label: RawEditPanelStrings.aspectOriginal() },
  ...ASPECT_RATIOS.map((each) => ({ value: each.key, label: each.key })),
];

const STRAIGHTEN = { min: -45, max: 45, step: 0.05 };

function StraightenControl({
  edit,
  stage,
  presenter,
  styles,
}: {
  edit: EditStore;
  stage: StageStore;
  presenter: RawEditPresenter;
  styles: RawEditPanelStyles;
}): JSX.Element {
  const angle = edit.doc?.cropAngle ?? 0;
  const reset = !stage.editable || angle === 0 ? null : () => presenter.settleStraighten(0);
  const label = RawEditPanelStrings.straighten();
  return (
    <EditControl
      label={label}
      value={RawEditPanelStrings.degrees(reading(angle, STRAIGHTEN))}
      reset={reset}
      typing={stage.editable ? { ...STRAIGHTEN, set: presenter.settleStraighten } : null}
    >
      <Slider
        style={styles.slider}
        value={angle}
        onChange={presenter.previewStraighten}
        onCommit={presenter.settleStraighten}
        min={STRAIGHTEN.min}
        max={STRAIGHTEN.max}
        step={STRAIGHTEN.step}
        snap={[0]}
        label={label}
        valueText={(at) => RawEditPanelStrings.degrees(reading(at, STRAIGHTEN))}
        disabled={!stage.editable}
      />
    </EditControl>
  );
}

/**
 * The straighten, and whether a change of geometry takes the crop with it.
 *
 * **The tools themselves are the header's**, not this: a crop and a perspective correction are
 * modes the pointer is in, so they belong beside the cursor they replace rather than as buttons
 * in a column of sliders. What is left here is the parameter and the habit.
 *
 * Crop to fit is a state and not an act, which is why it is a checkbox: a reader who wants the
 * wedges trimmed wants them trimmed on every move of the straighten, not once after the fact.
 */
export const GeometryControls = observer(function GeometryControls({
  edit,
  stage,
  store,
  presenter,
  styles,
}: {
  edit: EditStore;
  stage: StageStore;
  store: CropStore;
  presenter: RawEditPresenter;
  styles: RawEditPanelStyles;
}): JSX.Element {
  return (
    <>
      <StraightenControl edit={edit} stage={stage} presenter={presenter} styles={styles} />
      <CheckLabel style={styles.check}>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.cropToFit}
          disabled={!stage.editable}
          onChange={(event) => presenter.setCropToFit(event.currentTarget.checked)}
        />
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.cropToFit()}
        </Text>
      </CheckLabel>
    </>
  );
});

/**
 * The crop's shape, as a ratio to pick rather than a rectangle to drag into one. Whatever it
 * reads, a drag keeps; "Custom" is the one that leaves a drag free.
 */
export const CropPanel = observer(function CropPanel({
  edit,
  stage,
  store,
  presenter,
  styles,
  section,
}: {
  edit: EditStore;
  stage: StageStore;
  store: CropStore;
  presenter: RawEditPresenter;
  styles: RawEditPanelStyles;
  section?: 'aspect' | 'geometry';
}): JSX.Element {
  return (
    <>
      {(section == null || section === 'aspect') && <Panel style={styles.group} titleStyle={styles.groupTitle} title={RawEditPanelStrings.aspectRatio()}>
        <Select
          style={styles.selectTrigger}
          label={RawEditPanelStrings.aspectRatio()}
          options={ASPECTS}
          value={store.cropAspect}
          onChange={presenter.setCropAspect}
        />
      </Panel>}
      {(section == null || section === 'geometry') && <Panel style={styles.group} titleStyle={styles.groupTitle} title={EditToolsStrings.crop()}>
        <GeometryControls edit={edit} stage={stage} store={store} presenter={presenter} styles={styles} />
      </Panel>}
    </>
  );
});
