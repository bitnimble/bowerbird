import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import { CheckLabel } from '../../ui/check_label';
import { focusRing } from '../../ui/focus_ring';
import { Panel } from '../../ui/panel';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import { CropPanel, GeometryControls } from './crop/crop_panel';
import { EditControl } from './edit_control';
import type { CropStore } from './crop/crop_store';
import type { EditStore } from './edit/edit_store';
import { COLOUR, DETAIL, DUST, EFFECTS, LIGHT, reading, type SliderSpec } from './edit_sliders';
import type { RawEditPresenter } from './stage/raw_edit_presenter';
import { RawEditPanelStrings } from './raw_edit_panel.strings';
import type { ColourProfile, Denoiser } from '../../../../src/schemas/photo_edits';
import { KeystonePanel } from './keystone/keystone_panel';
import type { KeystoneStore } from './keystone/keystone_store';
import { styles } from './raw_edit_panel.stylex';
import type { StageStore } from './stage/stage_store';
import { RepairPanel } from './repair/repair_panel';
import type { RepairStore } from './repair/repair_store';
import type { PrintStore } from './print/print_store';
import { proofPanels } from './print/print_controls';
import { EditToolsStrings } from './edit_tools.strings';
import { MobileEditPanels, type MobileEditPanel } from './mobile_edit_panels';


const COLOUR_PROFILES: Option<ColourProfile>[] = [
  { value: 'none', label: RawEditPanelStrings.colourProfileNone() },
  { value: 'matched', label: RawEditPanelStrings.colourProfileMatched() },
];

const DENOISERS: Option<Denoiser>[] = [
  { value: 'galosh', label: RawEditPanelStrings.denoiserGalosh() },
  { value: 'pmrid', label: RawEditPanelStrings.denoiserPmrid() },
];

/**
 * The three Kelvins the temperature track is pinned to: its two ends, and the daylight that sits
 * at the halfway mark.
 *
 * `daylight` is the gradient's contract as much as the slider's - the track paints its grey at
 * `TEMPERATURE_GREY_AT`, so a photograph balanced here is one whose thumb stands over neutral
 * paint. Moving this without moving that stop leaves the track claiming a shift the picture has
 * not got.
 */
const ANCHOR = { warm: 2300, daylight: 5500, cool: 50000 };

const BEND = (ANCHOR.cool - ANCHOR.daylight) / (ANCHOR.daylight - ANCHOR.warm);

/**
 * Where a Kelvin stands on the track, as a fraction of it.
 *
 * The Möbius map through the three anchors, which is the one function that seats all of them: the
 * eye reads colour temperature reciprocally, and a scale linear in mireds - 10⁶/K, the plain
 * reciprocal this reads as a fumbled version of - cannot hold 5500K at the centre of these ends.
 */
export const trackAt = (kelvin: number): number => {
  const above = BEND * (kelvin - ANCHOR.warm);
  return above / (ANCHOR.cool - kelvin + above);
};

/** The inverse, which is Möbius too. */
export const kelvinAt = (at: number): number =>
  (BEND * ANCHOR.warm * (at - 1) - at * ANCHOR.cool) / (BEND * (at - 1) - at);

/** An arrow key moves 1.3 mireds at the warm end and 0.5 at the cool one, either well under a JND. */
const TRACK_STEP = 1 / 500;

/** `busy` is the two mosaic groups' only: see `StageStore.repreparing`. */
function Group({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Panel
      style={styles.group}
      titleStyle={styles.groupTitle}
      title={
        <>
          {title}
          {busy === true && (
            <span
              {...stylex.props(styles.spinner)}
              role="status"
              aria-label={RawEditPanelStrings.rebuildingThePhoto()}
            />
          )}
        </>
      }
    >
      {children}
    </Panel>
  );
}

const EditSlider = observer(function EditSlider({
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
  // Where the photograph answers for itself, "untouched" is the document holding nothing rather
  // than the document holding a particular number - so the reset arrow goes back to null and the
  // row goes on following the frame.
  const measured = spec.measured == null ? null : (stage.detail?.[spec.measured] ?? null);
  const neutral = measured ?? spec.neutral ?? 0;
  const value = Number(stored ?? neutral);
  const untouched = spec.measured == null ? value === neutral : stored == null;
  // Blank until the header lands: the measurement comes off it, and a number in its place would
  // state a denoise the module has not resolved - which is exactly what this row is here to stop.
  const unknown = spec.measured != null && stored == null && measured == null;
  const shut = disabled === true || !stage.editable;
  const format = (at: number): string => RawEditPanelStrings.valueWithUnit(reading(at, spec), spec.unit ?? '');

  return (
    <EditControl
      label={spec.label}
      value={unknown ? '' : format(value)}
      reset={
        shut || untouched
          ? null
          : () => presenter.settle({ [spec.key]: spec.measured == null ? neutral : null })
      }
    >
      <Slider
        style={styles.slider}
        value={value}
        onChange={(next) => presenter.preview({ [spec.key]: next })}
        onCommit={(next) => presenter.settle({ [spec.key]: next })}
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

/**
 * Taking the sensor's dust off: a switch, and two sliders that mean nothing without it.
 *
 * **The switch is not a convenience.** Finding the particles costs a whole-frame read of the mosaic,
 * so a photograph nobody has asked to declutter never pays for it - which is why this is a control
 * rather than something the open just does, and why the sliders are shut while it is off.
 */
const Dust = observer(function Dust({
  edit,
  stage,
  presenter,
}: {
  edit: EditStore;
  stage: StageStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const doc = edit.doc;
  const on = doc?.dustRemoval ?? true;
  return (
    <>
      <CheckLabel style={styles.check}>
        <input
          type="checkbox"
          {...stylex.props(focusRing.ring)}
          checked={on}
          disabled={!stage.editable}
          onChange={(event) => presenter.settle({ dustRemoval: event.currentTarget.checked })}
        />
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.removeSensorDust()}
        </Text>
      </CheckLabel>
      {DUST.map((spec) => (
        <EditSlider
          key={spec.key}
          edit={edit}
          stage={stage}
          presenter={presenter}
          spec={spec}
          disabled={!on}
        />
      ))}
    </>
  );
});

/**
 * White balance, as the pair of sliders it is - seeded from what the camera metered.
 *
 * **The slider position and the stored value are deliberately different things.** The document
 * holds null for "as shot" and has to: the same settings pasted onto a photo taken under
 * tungsten must mean *that* photo's neutral, where a stored 5500 would mean a rebalance nobody
 * asked for. A slider cannot show null, so it shows the frame's own illuminant until the
 * reader moves it, and the first move is what turns the pair into numbers (`store.balance`).
 *
 * Which is also what both sliders rest at, rather than the middle of their ranges: the picture
 * at rest is the one the camera made, so that is where a snap and a reset go.
 *
 * Closed only where the file recorded no usable multipliers, which leaves nothing to be
 * relative to. The mode - "As Shot", "Daylight", a name from a sidecar - is shown beside them
 * because it is what the document still says until something moves.
 */
const WhiteBalance = observer(function WhiteBalance({
  edit,
  stage,
  presenter,
}: {
  edit: EditStore;
  stage: StageStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const doc = edit.doc;
  const balance = edit.balance;
  const neutral = edit.asShotBalance;
  const moved = doc != null && (doc.temperature != null || doc.tint != null);
  const disabled = !stage.editable;
  const back =
    disabled || !moved
      ? null
      : (): void => presenter.settle({ whiteBalanceMode: 'As Shot', temperature: null, tint: null });

  return (
    <>
      {/* What the document still says, until something moves. No reset beside it: both sliders
          below already put the pair back, and they move as a pair. */}
      <div {...stylex.props(styles.head, styles.headBare)}>
        <Text variant="mono" as="span" style={styles.value}>
          {doc?.whiteBalanceMode ?? RawEditPanelStrings.noWhiteBalanceMode()}
        </Text>
      </div>

      {balance == null || neutral == null ? (
        <Text variant="muted" as="p">
          {/* Only once the frame is open: the illuminant comes off the prepared header, so
              before that there is nothing missing, only nothing yet. */}
          {stage.live ? RawEditPanelStrings.noCameraNeutral() : ''}
        </Text>
      ) : (
        <>
          <EditControl
            label={RawEditPanelStrings.temperature()}
            value={RawEditPanelStrings.kelvin(balance.temperature)}
            reset={back}
          >
            <Slider
              style={styles.slider}
              value={trackAt(balance.temperature)}
              onChange={(at) => presenter.previewBalance({ temperature: kelvinAt(at) })}
              onCommit={(at) => presenter.settleBalance({ temperature: kelvinAt(at) })}
              min={Math.min(0, trackAt(balance.temperature), trackAt(neutral.temperature))}
              max={Math.max(1, trackAt(balance.temperature), trackAt(neutral.temperature))}
              step={TRACK_STEP}
              snap={[trackAt(neutral.temperature)]}
              valueText={(at) => RawEditPanelStrings.kelvin(Math.round(kelvinAt(at)))}
              tone="temperature"
              label={RawEditPanelStrings.temperature()}
              disabled={disabled}
            />
          </EditControl>
          <EditControl
            label={RawEditPanelStrings.tint()}
            value={reading(balance.tint, { min: -150, step: 1 })}
            reset={back}
          >
            <Slider
              style={styles.slider}
              value={balance.tint}
              onChange={(tint) => presenter.previewBalance({ tint })}
              onCommit={(tint) => presenter.settleBalance({ tint })}
              min={-150}
              max={150}
              step={1}
              snap={[neutral.tint]}
              tone="tint"
              label={RawEditPanelStrings.tint()}
              valueText={(at) => reading(at, { min: -150, step: 1 })}
              disabled={disabled}
            />
          </EditControl>
        </>
      )}
    </>
  );
});

const ColourProfileChoice = observer(function ColourProfileChoice({
  edit,
  presenter,
}: {
  edit: EditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  return (
    <div>
      <div {...stylex.props(styles.head, styles.headAboveSelect)}>
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.colourProfile()}
        </Text>
      </div>
      <Select
        style={styles.selectTrigger}
        label={RawEditPanelStrings.colourProfile()}
        options={COLOUR_PROFILES}
        value={edit.doc?.colourProfile ?? 'matched'}
        onChange={presenter.setColourProfile}
      />
    </div>
  );
});

const DenoiserChoice = observer(function DenoiserChoice({
  edit,
  presenter,
}: {
  edit: EditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  return (
    <div>
      <div {...stylex.props(styles.head, styles.headAboveSelect)}>
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.denoiser()}
        </Text>
      </div>
      <Select
        style={styles.selectTrigger}
        label={RawEditPanelStrings.denoiser()}
        options={DENOISERS}
        value={edit.doc?.denoiser ?? 'galosh'}
        onChange={presenter.setDenoiser}
      />
    </div>
  );
});

function panelGroup(id: string, title: string, content: React.ReactNode, busy = false): MobileEditPanel {
  return { id, title, content: <Group title={title} busy={busy}>{content}</Group> };
}

export const RawEditPanel = observer(function RawEditPanel({ edit, stage, crop, keystone, repair, print, presenter, mobile = false }: {
  edit: EditStore;
  stage: StageStore;
  crop: CropStore;
  keystone: KeystoneStore;
  repair: RepairStore;
  print: PrintStore;
  presenter: RawEditPresenter;
  mobile?: boolean;
}): JSX.Element {
  const statusLabel = RawEditPanelStrings.status(stage.status);
  const status = stage.message !== '' ? RawEditPanelStrings.statusWithMessage(statusLabel, stage.message) : statusLabel;
  const notice = (edit.saveStatus === 'conflict' || edit.saveStatus === 'failed' || stage.status !== 'live') && (
    <Panel style={styles.group}>
      {edit.saveStatus === 'conflict' && <Text variant="muted" as="p">{RawEditPanelStrings.editedElsewhere()}</Text>}
      {edit.saveStatus === 'failed' && <Text variant="muted" as="p">{RawEditPanelStrings.couldNotSave()}</Text>}
      {stage.status !== 'live' && <Text as="p" variant={stage.status === 'failed' ? 'muted' : 'mono'} style={styles.status}>{status}</Text>}
    </Panel>
  );
  let scope: string;
  let panels: MobileEditPanel[];
  if (crop.cropping) {
    scope = 'crop';
    panels = [
      { id: 'aspect', title: RawEditPanelStrings.aspectRatio(), content:
        <CropPanel edit={edit} stage={stage} store={crop} presenter={presenter} styles={styles} section="aspect" /> },
      { id: 'crop', title: EditToolsStrings.crop(), content:
        <CropPanel edit={edit} stage={stage} store={crop} presenter={presenter} styles={styles} section="geometry" /> },
    ];
  } else if (keystone.keystoning) {
    scope = 'perspective';
    panels = [{ id: 'perspective', title: EditToolsStrings.perspective(), content:
      <KeystonePanel stage={stage} store={keystone} presenter={presenter} styles={styles} /> }];
  } else if (repair.repairing) {
    scope = 'repair';
    panels = [{ id: 'repair', title: EditToolsStrings.repair(), content:
      <RepairPanel edit={edit} stage={stage} store={repair} presenter={presenter} styles={styles} /> }];
  } else {
    scope = 'adjust';
    const sliders = (specs: readonly SliderSpec[]): React.ReactNode => specs.map((spec) =>
      <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />);
    panels = [
      panelGroup('light', RawEditPanelStrings.groupLight(), sliders(LIGHT)),
      panelGroup('white-balance', RawEditPanelStrings.groupWhiteBalance(), <WhiteBalance edit={edit} stage={stage} presenter={presenter} />),
      panelGroup('colour', RawEditPanelStrings.groupColour(), <>
        <ColourProfileChoice edit={edit} presenter={presenter} />{sliders(COLOUR)}
      </>),
      panelGroup('effects', RawEditPanelStrings.groupEffects(), sliders(EFFECTS)),
      panelGroup('detail', RawEditPanelStrings.groupDetail(), <>
        {stage.mosaic && stage.denoises && <DenoiserChoice edit={edit} presenter={presenter} />}
        {sliders(DETAIL.filter((spec) => (stage.mosaic && stage.denoises) || spec.key === 'sharpening'))}
        {!stage.mosaic && <Text variant="muted" as="p">{RawEditPanelStrings.noMosaic()}</Text>}
        {stage.mosaic && !stage.denoises && <Text variant="muted" as="p">{RawEditPanelStrings.noDenoise()}</Text>}
      </>, stage.repreparing),
      ...(stage.mosaic ? [panelGroup('dust', RawEditPanelStrings.groupDustRemoval(),
        <Dust edit={edit} stage={stage} presenter={presenter} />, stage.repreparing)] : []),
      panelGroup('geometry', RawEditPanelStrings.groupGeometry(), <GeometryControls edit={edit} stage={stage} store={crop} presenter={presenter} styles={styles} />),
      ...proofPanels(stage.softProof, print, presenter.print, !stage.editable),
    ];
  }
  if (mobile) return <MobileEditPanels panels={panels} scope={scope} notice={notice} />;
  return <div {...stylex.props(styles.panel)}>
    {notice}
    {panels.map(({ id, content }) => <Fragment key={id}>{content}</Fragment>)}
  </div>;
});
