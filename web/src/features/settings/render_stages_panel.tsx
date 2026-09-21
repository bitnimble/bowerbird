import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { type Library } from '../../../../src/schemas/libraries';
import {
  isOptional,
  RENDER_STAGES,
  RENDERED_RENDITIONS,
  stageMs,
  type RenderStage,
  type RenderedRendition,
} from '../../../../src/schemas/render_stages';
import { useAppSettingsStore, usePresenters } from '../../app/stores_context';
import { renditionLabel } from '../photos/renditions';
import { RawEditPanelStrings } from '../raw_edit/raw_edit_panel.strings';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { SettingRow } from './settings_controls';
import { SettingsStrings } from './settings_page.strings';

const styles = stylex.create({
  tabs: {
    marginBottom: '8px',
  },
  measure: {
    marginTop: '10px',
  },
  // Where a stage that cannot be turned off would have had its checkbox, so the costs read as one
  // column rather than stepping right on every row that has no control after them.
  noBox: {
    width: '20px',
  },
});

// Each stage under the name the control that already governs it goes by, so a reader meets one
// word per concept: the camera match and the fringe removal are settings on this page, and the
// dust removal and the sharpening are the edit panel's own sections.
const STAGE_LABELS: Record<RenderStage, () => string> = {
  read: SettingsStrings.stageRead,
  dust: RawEditPanelStrings.groupDustRemoval,
  denoise: SettingsStrings.stageDenoise,
  demosaic: SettingsStrings.stageDemosaic,
  lens: SettingsStrings.stageLens,
  colour: SettingsStrings.stageColour,
  defringe: SettingsStrings.rawDefringe,
  sharpen: RawEditPanelStrings.sharpening,
  encode: SettingsStrings.stageEncode,
};

const RENDITION_TABS: Option<RenderedRendition>[] = RENDERED_RENDITIONS.map((rendition) => ({
  value: rendition,
  label: renditionLabel(rendition),
}));

/**
 * What this library's renders run, stage by stage, and what each one costs here.
 *
 * Per rendition because the two are looked at differently: `full` is what the viewer opens and
 * `max` is what gets pixel-peeped, so a library may keep the camera match on one and trade it away
 * on the other. A stage with no checkbox is one a render cannot do without.
 *
 * What the stages run is this library's; what they cost is the machine's, measured once against a
 * full-frame sensor rather than once per catalogue.
 */
export const RenderStagesPanel = observer(function RenderStagesPanel({ library }: { library: Library }): JSX.Element {
  const [rendition, setRendition] = useState<RenderedRendition>('full');
  const settings = useAppSettingsStore();
  const { appSettings, libraries } = usePresenters();
  useEffect(() => void appSettings.loadRenderTimings(), [appSettings]);
  const measured = settings.renderTimings[rendition];
  const ms = stageMs(rendition, measured);
  const skipped = rendition === 'full' ? library.render_skip_full : library.render_skip_max;
  const busy = settings.isBenchmarking(rendition);
  const cameraMatching = settings.settings?.match_embedded_jpeg !== false;

  return (
    <Panel title={SettingsStrings.renderStages()}>
      <SegmentedControl
        as="radio"
        stretch
        style={styles.tabs}
        label={SettingsStrings.renderStagesFor()}
        options={RENDITION_TABS}
        value={rendition}
        onChange={setRendition}
      />

      {RENDER_STAGES.map((stage) => (
        <StageRow
          key={stage}
          stage={stage}
          ms={ms[stage]}
          disabledReason={
            (stage === 'lens' || stage === 'colour') && !cameraMatching ? SettingsStrings.cameraMatchingOff()
            : stage === 'colour' && skipped.includes('lens') ? SettingsStrings.colourNeedsLens()
            : undefined
          }
          runs={(!['lens', 'colour'].includes(stage) || cameraMatching) && (!isOptional(stage) || !skipped.includes(stage))}
          onChange={
            isOptional(stage) ?
              (runs) => void libraries.setRenderStage(library.id, rendition, stage, runs)
            : undefined
          }
        />
      ))}

      <Row style={styles.measure}>
        <Text variant="muted">
          {measured == null ?
            SettingsStrings.stagesEstimated()
          : SettingsStrings.stagesMeasured(relativeTime(measured.measured_at))}
        </Text>
        <Spacer />
        <Button
          disabled={busy}
          aria-busy={busy}
          title={busy ? SettingsStrings.measureStagesBusy() : undefined}
          onClick={() => void appSettings.benchmarkRender(rendition)}
        >
          <Timer size={ICON} />
          {busy ? SettingsStrings.measuringStages() : SettingsStrings.measureStages()}
        </Button>
      </Row>
    </Panel>
  );
});

// A stage with no `onChange` is one every render runs, so it shows what it costs and nothing to
// press: a checkbox that cannot be unticked is worse than no checkbox.
function StageRow({
  stage,
  ms,
  runs,
  disabledReason,
  onChange,
}: {
  stage: RenderStage;
  ms: number;
  runs: boolean;
  disabledReason?: string;
  onChange?: (runs: boolean) => void;
}): JSX.Element {
  const label = STAGE_LABELS[stage]();
  return (
    <SettingRow label={label} disabledReason={disabledReason}>
      <Text variant="muted">{SettingsStrings.stageCost(ms)}</Text>
      {onChange == null ?
        <span {...stylex.props(styles.noBox)} />
      : <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          aria-label={label}
          checked={runs}
          disabled={disabledReason != null}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      }
    </SettingRow>
  );
}
