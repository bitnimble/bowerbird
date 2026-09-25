import * as stylex from '@stylexjs/stylex';
import { Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { MOST_FEATHER } from '../../../../../src/schemas/assembly';
import { STORED_LONG } from '../../../../../src/schemas/stored_grid';
import { Button } from '../../../ui/button';
import { CheckLabel } from '../../../ui/check_label';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { Panel } from '../../../ui/panel';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { Tooltip } from '../../../ui/tooltip';
import { MergePageStrings } from '../../photos/merge/merge_page.strings';
import { EditControl } from '../edit_control';
import { EditToolsStrings } from '../edit_tools.strings';
import { reading } from '../edit_sliders';
import type { EditStore } from '../edit/edit_store';
import type { RawEditPanelStyles } from '../raw_edit_panel.stylex';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import type { RepairStore, RepairThumbnail } from './repair_store';

function SeamedThumbnail({
  thumbnail,
  styles,
}: {
  thumbnail: RepairThumbnail;
  styles: RawEditPanelStyles;
}): JSX.Element {
  return (
    <>
      <img src={thumbnail.url} alt="" {...stylex.props(styles.thumbnailLayer)} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" {...stylex.props(styles.thumbnailLayer)}>
        <polygon points={thumbnail.seam.map(({ x, y }) => `${x},${y}`).join(' ')} {...stylex.props(styles.seam)} />
      </svg>
    </>
  );
}

/**
 * The repair tool's half of the panel: what to do next, the fills on offer for the loop just
 * drawn, and the photograph's repairs so far.
 */
export const RepairPanel = observer(function RepairPanel({
  edit,
  stage,
  store,
  presenter,
  styles,
}: {
  edit: EditStore;
  stage: StageStore;
  store: RepairStore;
  presenter: RawEditPresenter;
  styles: RawEditPanelStyles;
}): JSX.Element {
  const options = store.repairOptions;
  const prompt =
    store.repairSolving ? RawEditPanelStrings.findingFills()
    : store.repairRefusal ?? (options == null ? RawEditPanelStrings.drawAroundToRemove() : null);
  const repairs = edit.doc?.repairs ?? [];
  const blend = ((options?.[store.repairChoice]?.feather ?? 0) / STORED_LONG) * 100;

  return (
    <Panel
      style={styles.group}
      titleStyle={styles.groupTitle}
      title={
        <>
          {EditToolsStrings.repair()}
          {(store.repairSolving || stage.repreparing) && (
            <span
              {...stylex.props(styles.spinner)}
              role="status"
              aria-label={RawEditPanelStrings.rebuildingThePhoto()}
            />
          )}
        </>
      }
    >
      {options != null && (
        <EditControl
          label={MergePageStrings.blend()}
          value={RawEditPanelStrings.percent(reading(blend, { min: 0, step: 0.05 }))}
          reset={null}
          typing={store.repairSolving ? null : {
            min: 0,
            max: MOST_FEATHER * 100,
            step: 0.05,
            set: (percent) => presenter.repair.settleFeather(percent / 100),
          }}
        >
          <Slider
            style={styles.slider}
            value={blend}
            onChange={(percent) => presenter.repair.previewFeather(percent / 100)}
            onCommit={(percent) => presenter.repair.settleFeather(percent / 100)}
            min={0}
            max={MOST_FEATHER * 100}
            step={0.05}
            label={MergePageStrings.blend()}
            valueText={MergePageStrings.blendPercent}
            disabled={store.repairSolving}
          />
        </EditControl>
      )}
      {prompt != null && (
        <Text variant="muted" as="p">
          {prompt}
        </Text>
      )}
      <CheckLabel style={styles.check}>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.repairOutlinesShown}
          onChange={(event) => presenter.repair.setOutlinesShown(event.currentTarget.checked)}
        />
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.showOutlines()}
        </Text>
      </CheckLabel>
      <CheckLabel style={styles.check}>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.repairGrows}
          disabled={store.repairSolving}
          onChange={(event) => presenter.repair.setGrows(event.currentTarget.checked)}
        />
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.expandToHideSeam()}
        </Text>
      </CheckLabel>
      {options != null && (
        <>
          <hr {...stylex.props(styles.divider)} />
          <div {...stylex.props(styles.fills)} role="radiogroup" aria-label={RawEditPanelStrings.fills()}>
            {options.map((_, at) => {
              const thumbnail = store.repairOptionThumbnails.get(at);
              return (
                <Tooltip key={at} label={RawEditPanelStrings.fillOption(at + 1)}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={at === store.repairChoice}
                    {...stylex.props(
                      styles.thumbnail,
                      styles.fill,
                      focusRing.ring,
                      at === store.repairChoice && styles.chosen,
                    )}
                    aria-label={RawEditPanelStrings.fillOption(at + 1)}
                    disabled={store.repairSolving}
                    onClick={() => presenter.repair.choose(at)}
                  >
                    {thumbnail == null ? at + 1 : <SeamedThumbnail thumbnail={thumbnail} styles={styles} />}
                  </button>
                </Tooltip>
              );
            })}
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button onClick={presenter.repair.apply} disabled={store.repairSolving}>
              {RawEditPanelStrings.applyFill()}
            </Button>
            <Button onClick={presenter.repair.cancel}>
              {RawEditPanelStrings.cancelFill()}
            </Button>
          </div>
        </>
      )}
      {/* Not while fills are on offer: the one on show is in this list already, and redoing or
          removing its neighbours would move the place it is about to be kept at. */}
      {options == null && repairs.length > 0 && (
        <div {...stylex.props(styles.repairs)}>
          {repairs.map((_, index) => {
            const thumbnail = store.repairThumbnails.get(store.repairKeys[index] ?? '');
            const busy = !stage.editable || store.repairSolving;
            return (
              <div key={index} {...stylex.props(styles.repair)}>
                <Tooltip label={RawEditPanelStrings.editRepair(index + 1)}>
                  <button
                    type="button"
                    {...stylex.props(styles.thumbnail, focusRing.ring)}
                    aria-label={RawEditPanelStrings.editRepair(index + 1)}
                    disabled={busy}
                    onClick={() => void presenter.repair.open(index)}
                  >
                    {thumbnail != null && <SeamedThumbnail thumbnail={thumbnail} styles={styles} />}
                  </button>
                </Tooltip>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={RawEditPanelStrings.deleteRepair(index + 1)}
                  disabled={busy}
                  onClick={() => presenter.repair.remove(index)}
                >
                  <Trash2 size={ICON} />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
});
