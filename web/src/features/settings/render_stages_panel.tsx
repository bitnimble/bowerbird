import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { Timer } from 'lucide-react';
import {
  isOptional,
  OPTIONAL_STAGES,
  RENDER_STAGES,
  stageMs,
  type OptionalStage,
  type RenderStage,
} from '../../../../src/schemas/render_stages';
import { useAppSettingsStore, useLibrariesStore, usePresenters } from '../../app/stores_context';
import { DENOISERS } from '../raw_edit/denoisers';
import { RawEditPanelStrings } from '../raw_edit/raw_edit_panel.strings';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { SettingRow } from './settings_controls';
import { SettingsStrings } from './settings_page.strings';

const styles = stylex.create({
  measure: {
    marginTop: '10px',
  },
  // Where a checkbox would be, so the costs on rows without one stay in the same column.
  noBox: {
    width: '20px',
  },
});

const STAGE_LABELS: Record<OptionalStage, () => string> = {
  dust: RawEditPanelStrings.groupDustRemoval,
  denoise: SettingsStrings.stageDenoise,
  lens: RawEditPanelStrings.lensCorrection,
  colour: SettingsStrings.stageColour,
  defringe: RawEditPanelStrings.colourFringeRemoval,
  sharpen: RawEditPanelStrings.sharpening,
};

const RENDITION = 'full';

/**
 * The edits import gives each new photo, stage by stage (`importedEdits`), and what each stage
 * costs a `full` render here.
 *
 * What the stages cost is the machine's, measured once against a full-frame sensor rather than once
 * per catalogue.
 */
export const RenderStagesPanel = observer(function RenderStagesPanel(): JSX.Element | null {
  const settings = useAppSettingsStore();
  const store = useLibrariesStore();
  const { appSettings, libraries } = usePresenters();
  useEffect(() => void appSettings.loadRenderTimings(), [appSettings]);
  const current = store.rendering;
  if (current == null) return null;

  const noLibraries = store.libraries.length === 0;
  const measured = settings.timingOf(RENDITION, current.denoiser);
  const ms = stageMs(RENDITION, current.denoiser, measured);
  const skipped = current.render_skip_full;
  const busy = settings.isBenchmarking(RENDITION, current.denoiser);
  const runs = (stage: RenderStage): boolean => !isOptional(stage) || !skipped.includes(stage);
  const total = RENDER_STAGES.filter(runs).reduce((sum, stage) => sum + ms[stage], 0);
  const misc = RENDER_STAGES.filter((stage) => !isOptional(stage)).reduce(
    (sum, stage) => sum + ms[stage],
    0,
  );

  return (
    <Panel>
      {OPTIONAL_STAGES.map((stage) => (
        <StageRow
          key={stage}
          label={STAGE_LABELS[stage]()}
          ms={ms[stage]}
          disabledReason={
            noLibraries
              ? SettingsStrings.renderStagesNeedLibrary()
              : stage === 'colour' && skipped.includes('lens')
                ? RawEditPanelStrings.colourNeedsLens()
                : undefined
          }
          runs={runs(stage)}
          onChange={(next) => void libraries.setRenderStage(RENDITION, stage, next)}
          control={
            stage === 'denoise' ? (
              <Select
                label={RawEditPanelStrings.denoiser()}
                options={DENOISERS}
                value={current.denoiser}
                disabled={noLibraries}
                onChange={(next) => void libraries.setDenoiser(next)}
              />
            ) : undefined
          }
        />
      ))}

      <SettingRow label={SettingsStrings.stagesMisc()}>
        <Text variant="muted">{SettingsStrings.stageCost(misc)}</Text>
        <span {...stylex.props(styles.noBox)} />
      </SettingRow>

      <SettingRow label={SettingsStrings.stagesTotal()}>
        <Text variant="muted">{SettingsStrings.totalCost(total)}</Text>
        <span {...stylex.props(styles.noBox)} />
      </SettingRow>

      <Row style={styles.measure}>
        <Text variant="muted">
          {measured == null
            ? SettingsStrings.stagesEstimated()
            : SettingsStrings.stagesMeasured(relativeTime(measured.measured_at))}
        </Text>
        <Spacer />
        <Button
          disabled={busy}
          aria-busy={busy}
          tooltip={busy ? SettingsStrings.measureStagesBusy() : undefined}
          onClick={() => void appSettings.benchmarkRender(RENDITION, current.denoiser)}
        >
          <Timer size={ICON} />
          {busy ? SettingsStrings.measuringStages() : SettingsStrings.measureStages()}
        </Button>
      </Row>
    </Panel>
  );
});

function StageRow({
  label,
  ms,
  runs,
  disabledReason,
  onChange,
  control,
}: {
  label: string;
  ms: number;
  runs: boolean;
  disabledReason?: string;
  onChange: (runs: boolean) => void;
  control?: ReactNode;
}): JSX.Element {
  return (
    <SettingRow label={label} disabledReason={disabledReason} inactive={!runs}>
      {control}
      <Text variant="muted">{SettingsStrings.stageCost(ms)}</Text>
      <input
        {...stylex.props(focusRing.ring)}
        type="checkbox"
        aria-label={label}
        checked={runs}
        disabled={disabledReason != null}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </SettingRow>
  );
}
