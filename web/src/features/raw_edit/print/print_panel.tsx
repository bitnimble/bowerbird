import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Button } from '../../../ui/button';
import { CheckLabel } from '../../../ui/check_label';
import { focusRing } from '../../../ui/focus_ring';
import { Panel } from '../../../ui/panel';
import { Select } from '../../../ui/select';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import type { Option } from '../../../ui/option';
import { FileRenderingIntentSchema, fileIntentOf, RenderingIntentSchema } from '../../../../../src/schemas/rendering_intent';
import { EditControl } from '../edit_control';
import { IntentChoice } from '../proof/intent_choice';
import { SoftProofMenuStrings } from '../proof/soft_proof_menu.strings';
import { styles as rows } from '../raw_edit_panel.stylex';
import { PrintPanelStrings as strings } from './print_panel.strings';
import { LAMP_REACH, restingValue, type Ink, type Paper, type PrintControl } from './print_scene';
import type { PrintStore } from './print_store';
import type { PrintPresenter } from './print_presenter';

const styles = stylex.create({
  group: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '12px' },
});

const PAPERS: Option<Paper>[] = [
  { value: 'gloss', label: strings.gloss() },
  { value: 'satin', label: strings.satin() },
  { value: 'matte', label: strings.matte() },
];

const INK_OPTIONS: Option<Ink>[] = [
  { value: 'dye', label: strings.dye() },
  { value: 'pigment', label: strings.pigment() },
];

/** Not a name the profile listing can hold: every profile it lists ends in `.icc` or `.icm`. */
const GENERIC_PAPER = 'generic';

type Control = {
  key: PrintControl;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  /** Slide in decades instead of degrees, so a pinpoint lamp and a broad one both get a usable stretch of track. */
  log?: true;
};

const decades = (spec: Control, value: number): number => spec.log === true ? Math.log10(value) : value;
const degrees = (spec: Control, position: number): number =>
  spec.log === true ? Math.min(spec.max, Math.max(spec.min, 10 ** position)) : position;

const PAPER: Control[] = [
  { key: 'paperLongEdgeMm', min: 50, max: 1000, step: 10, format: strings.millimetres },
  { key: 'roughness', min: 0.03, max: 1, step: 0.01, format: strings.roughnessValue },
  { key: 'surfaceTexture', min: 0, max: 1, step: 0.01, format: strings.percent },
  { key: 'refractiveIndex', min: 1, max: 2, step: 0.01, format: strings.roughnessValue },
  { key: 'whiteReflectance', min: 0.5, max: 0.99, step: 0.01, format: strings.percent },
  { key: 'blackReflectance', min: 0.001, max: 0.2, step: 0.001, format: strings.percent },
];
const PRINTER: Control[] = [
  { key: 'printResolutionPpi', min: 72, max: 1200, step: 1, format: strings.ppi },
  { key: 'inkSpreadMicrons', min: 0, max: 200, step: 1, format: strings.micrometres },
];
const LIGHT: Control[] = [
  { key: 'keyLux', min: 0, max: 10000, step: 10, format: strings.lux },
  { key: 'fillLux', min: 0, max: 10000, step: 10, format: strings.lux },
  { key: 'lightTemperatureKelvin', min: 2000, max: 10000, step: 100, format: strings.kelvin },
  { key: 'lightAcross', min: -LAMP_REACH, max: LAMP_REACH, step: 0.05, format: strings.printLengths },
  { key: 'lightHeight', min: -LAMP_REACH, max: LAMP_REACH, step: 0.05, format: strings.printLengths },
  { key: 'lightForward', min: -LAMP_REACH, max: LAMP_REACH, step: 0.05, format: strings.printLengths },
  { key: 'lightAngularDegrees', min: 0.1, max: 90, step: 0.01, format: strings.lightSize, log: true },
];
const ROTATION: Control[] = [
  { key: 'yawDegrees', min: -180, max: 180, step: 1, format: strings.degrees },
  { key: 'pitchDegrees', min: -85, max: 85, step: 1, format: strings.degrees },
];
/** What a flat print is still made of, with no light to catch a surface. */
const FLAT_PAPER = new Set<PrintControl>(['whiteReflectance', 'blackReflectance']);

export type PrintSection = 'paper' | 'printer' | 'lighting' | 'orientation' | 'srgb';

export const PrintPanel = observer(function PrintPanel({ store, presenter, disabled, section }: {
  store: PrintStore;
  presenter: PrintPresenter;
  disabled: boolean;
  section: PrintSection;
}): JSX.Element {
  const profiled = store.printerProfile != null;
  const controls = (specs: Control[]): JSX.Element[] => specs.map((spec) => {
    const value = store.scene[spec.key];
    const resting = restingValue(store.scene, spec.key);
    const locked = disabled || (profiled && FLAT_PAPER.has(spec.key));
    return (
      <EditControl
        key={spec.key}
        label={strings[spec.key]()}
        value={spec.format(value)}
        reset={locked || value === resting ? null : () => presenter.resetControl(spec.key)}
      >
        <Slider
          label={strings[spec.key]()}
          value={decades(spec, value)}
          valueText={(position) => spec.format(degrees(spec, position))}
          min={decades(spec, spec.min)}
          max={decades(spec, spec.max)}
          step={spec.step}
          snap={[decades(spec, resting)]}
          onChange={(next) => presenter.setControl(spec.key, degrees(spec, next))}
          disabled={locked}
          style={rows.slider}
        />
      </EditControl>
    );
  });

  if (section === 'srgb') {
    return <Panel title={SoftProofMenuStrings.srgb()} style={styles.group}>
      <IntentChoice
        value={fileIntentOf(store.scene.renderingIntent)}
        onChange={presenter.setRenderingIntent}
        intents={FileRenderingIntentSchema.options}
      />
    </Panel>;
  }
  if (section === 'lighting') return <Panel title={strings.lighting()} style={styles.group}>{controls(LIGHT)}</Panel>;
  if (section === 'printer') {
    const profiles: Option<string>[] = [
      { value: GENERIC_PAPER, label: strings.genericPaper() },
      ...store.printerProfiles.map((name) => ({ value: name, label: name })),
    ];
    return <Panel title={strings.printer()} style={styles.group}>
      <Select
        label={strings.printerProfile()}
        options={profiles}
        value={store.printerProfile?.name ?? GENERIC_PAPER}
        onChange={(name) => void presenter.setPrinterProfile(name === GENERIC_PAPER ? null : name)}
      />
      <IntentChoice
        value={store.scene.renderingIntent}
        onChange={presenter.setRenderingIntent}
        intents={RenderingIntentSchema.options}
      />
      {store.scene.renderingIntent === 'relativeColorimetric' && <CheckLabel>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.scene.blackPointCompensation}
          disabled={disabled}
          onChange={(event) => presenter.setBlackPointCompensation(event.currentTarget.checked)}
        />
        <Text as="span">{strings.blackPointCompensation()}</Text>
      </CheckLabel>}
      <Select label={strings.ink()} options={INK_OPTIONS} value={store.scene.ink} onChange={presenter.setInk} />
      {controls(PRINTER)}
    </Panel>;
  }
  if (section === 'paper') {
    return <Panel title={strings.paper()} style={styles.group}>
      <Select label={strings.paper()} options={PAPERS} value={store.scene.paper} onChange={presenter.setPaper} />
      <Text as="p" variant="muted">{profiled ? strings.profileSetsPaper() : strings.simulation()}</Text>
      {!store.flat && <CheckLabel>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.scene.framed}
          disabled={disabled}
          onChange={(event) => presenter.setFramed(event.currentTarget.checked)}
        />
        <Text as="span">{strings.addFrame()}</Text>
      </CheckLabel>}
      {controls(store.flat ? PAPER.filter((spec) => FLAT_PAPER.has(spec.key)) : PAPER)}
    </Panel>;
  }
  if (store.surface) {
    return <Panel title={strings.deviceTilt()} style={styles.group}>
      <Text as="p" variant="muted">{{
        permission: strings.tiltPermission,
        waiting: strings.tiltWaiting,
        active: strings.tiltActive,
        denied: strings.tiltDenied,
        unavailable: strings.tiltUnavailable,
      }[store.tiltStatus]()}</Text>
      {(store.tiltStatus === 'permission' || store.tiltStatus === 'denied') &&
        <Button onClick={() => void presenter.enableTilt()} disabled={disabled}>{strings.enableTilt()}</Button>}
      {store.tiltStatus === 'active' &&
        <Button onClick={presenter.resetTilt} disabled={disabled}>{strings.resetTilt()}</Button>}
    </Panel>;
  }
  return <Panel title={strings.rotation()} style={styles.group}>
    <Text as="p" variant="muted">{strings.dragHint()}</Text>
    {controls(ROTATION)}
    <Button onClick={presenter.resetView} disabled={disabled}>{strings.resetView()}</Button>
  </Panel>;
});
