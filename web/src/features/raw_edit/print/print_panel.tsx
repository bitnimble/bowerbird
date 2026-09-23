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
import { EditControl } from '../edit_control';
import { styles as rows } from '../raw_edit_panel.stylex';
import { PrintPanelStrings as strings } from './print_panel.strings';
import { LAMP_REACH, restingValue, type Paper, type PrintControl, type Tonemap } from './print_scene';
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

const TONEMAPS: Option<Tonemap>[] = [
  { value: 'neutral', label: strings.neutral() },
  { value: 'filmic', label: strings.filmic() },
  { value: 'channel', label: strings.channel() },
];

type Control = {
  key: PrintControl;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  /** Slide in decades instead of degrees, so a lamp and a softbox both get a usable stretch of track. */
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

export const PrintPanel = observer(function PrintPanel({ store, presenter, disabled, section }: {
  store: PrintStore;
  presenter: PrintPresenter;
  disabled: boolean;
  section?: 'paper' | 'lighting' | 'orientation';
}): JSX.Element {
  const controls = (specs: Control[]): JSX.Element[] => specs.map((spec) => {
    const value = store.scene[spec.key];
    const resting = restingValue(store.scene.paper, spec.key);
    return (
      <EditControl
        key={spec.key}
        label={strings[spec.key]()}
        value={spec.format(value)}
        reset={disabled || value === resting ? null : () => presenter.resetControl(spec.key)}
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
          disabled={disabled}
          style={rows.slider}
        />
      </EditControl>
    );
  });

  return <>
    {(section == null || section === 'paper') && <Panel title={strings.paper()} style={styles.group}>
      <Select label={strings.paper()} options={PAPERS} value={store.scene.paper} onChange={presenter.setPaper} />
      <div {...stylex.props(rows.control)}>
        <div {...stylex.props(rows.head, rows.headAboveSelect)}>
          <Text as="span" style={rows.name}>{strings.tonemap()}</Text>
        </div>
        <Select label={strings.tonemap()} options={TONEMAPS} value={store.scene.tonemap} onChange={presenter.setTonemap} />
      </div>
      <Text as="p" variant="muted">{strings.simulation()}</Text>
      <CheckLabel>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={store.scene.framed}
          disabled={disabled}
          onChange={(event) => presenter.setFramed(event.currentTarget.checked)}
        />
        <Text as="span">{strings.addFrame()}</Text>
      </CheckLabel>
      {controls(PAPER)}
    </Panel>}
    {(section == null || section === 'lighting') && <Panel title={strings.lighting()} style={styles.group}>{controls(LIGHT)}</Panel>}
    {(section == null || section === 'orientation') && (store.surface ? <Panel title={strings.deviceTilt()} style={styles.group}>
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
    </Panel> : <Panel title={strings.rotation()} style={styles.group}>
      <Text as="p" variant="muted">{strings.dragHint()}</Text>
      {controls(ROTATION)}
      <Button onClick={presenter.resetView} disabled={disabled}>{strings.resetView()}</Button>
    </Panel>)}
  </>;
});
