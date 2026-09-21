import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Button } from '../../../ui/button';
import { Panel } from '../../../ui/panel';
import { Select } from '../../../ui/select';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import type { Option } from '../../../ui/option';
import { PrintPanelStrings as strings } from './print_panel.strings';
import type { Paper, PrintControl } from './print_scene';
import type { PrintStore } from './print_store';
import type { PrintPresenter } from './print_presenter';

const styles = stylex.create({
  group: { gap: '12px' },
  control: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
});

const PAPERS: Option<Paper>[] = [
  { value: 'gloss', label: strings.gloss() },
  { value: 'satin', label: strings.satin() },
  { value: 'matte', label: strings.matte() },
];

type Control = {
  key: PrintControl;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
};

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
  { key: 'lightAzimuthDegrees', min: -180, max: 180, step: 1, format: strings.degrees },
  { key: 'lightElevationDegrees', min: -85, max: 85, step: 1, format: strings.degrees },
  { key: 'lightAngularDegrees', min: 1, max: 90, step: 1, format: strings.degrees },
  { key: 'lightDistance', min: 1, max: 20, step: 0.1, format: strings.printLengths },
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
  const controls = (specs: Control[]): JSX.Element[] => specs.map((spec) => (
    <div key={spec.key} {...stylex.props(styles.control)}>
      <div {...stylex.props(styles.head)}>
        <Text as="span">{strings[spec.key]()}</Text>
        <Text as="span" variant="mono">{spec.format(store.scene[spec.key])}</Text>
      </div>
      <Slider
        label={strings[spec.key]()}
        value={store.scene[spec.key]}
        valueText={spec.format}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        onChange={(value) => presenter.setControl(spec.key, value)}
        disabled={disabled}
      />
    </div>
  ));

  return <>
    {(section == null || section === 'paper') && <Panel title={strings.paper()} style={styles.group}>
      <Select label={strings.paper()} options={PAPERS} value={store.scene.paper} onChange={presenter.setPaper} />
      <Text as="p" variant="muted">{strings.simulation()}</Text>
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
      <Button onClick={presenter.resetRotation} disabled={disabled}>{strings.resetRotation()}</Button>
    </Panel>)}
  </>;
});
