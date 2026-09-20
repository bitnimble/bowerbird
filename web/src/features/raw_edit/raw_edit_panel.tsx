import * as stylex from '@stylexjs/stylex';
import { RotateCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { CheckLabel } from '../../ui/check_label';
import { focusRing } from '../../ui/focus_ring';
import { Panel } from '../../ui/panel';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import { CropPanel, GeometryControls } from './crop/crop_panel';
import type { CropStore } from './crop/crop_store';
import type { EditStore } from './edit/edit_store';
import { COLOUR, DETAIL, DUST, EFFECTS, LIGHT, reading, type SliderSpec } from './edit_sliders';
import type { RawEditPresenter } from './stage/raw_edit_presenter';
import { RawEditPanelStrings } from './raw_edit_panel.strings';
import type { ColourProfile } from '../../../../src/schemas/photo_edits';
import type { SoftProof } from './edits';
import { KeystonePanel } from './keystone/keystone_panel';
import type { KeystoneStore } from './keystone/keystone_store';
import { styles } from './raw_edit_panel.stylex';
import type { StageStore } from './stage/stage_store';
import { RepairPanel } from './repair/repair_panel';
import type { RepairStore } from './repair/repair_store';


const COLOUR_PROFILES: Option<ColourProfile>[] = [
  { value: 'none', label: RawEditPanelStrings.colourProfileNone() },
  { value: 'matched', label: RawEditPanelStrings.colourProfileMatched() },
];

const SOFT_PROOFS: Option<SoftProof>[] = [
  { value: 'hdr', label: RawEditPanelStrings.softProofHdr() },
  { value: 'srgb', label: RawEditPanelStrings.softProofSrgb() },
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

/**
 * One parameter: what it is, where it stands, and the two ways back to where it started.
 *
 * Both ways, because neither alone covers it. The button is the one a reader finds without
 * being told; the double click is the one their hands already know from every other editor,
 * and it works on the track they are already holding.
 */
function EditControl({
  label,
  value,
  reset,
  children,
}: {
  label: string;
  value: string;
  /**
   * How to put this parameter back, or null where there is nothing to put back *or* nothing
   * that could act on it yet.
   *
   * Both ways back read off this one value: a reset settles, which writes to the server, so a
   * row whose slider is shut must not still take a double click.
   */
  reset: (() => void) | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.control)} onDoubleClick={reset ?? undefined}>
      <div {...stylex.props(styles.head)}>
        {/* Body rather than `label`: the group's own title wears that, and a row named in the
            same 10px uppercase mono left the panel with no hierarchy at all. */}
        <Text as="span" style={styles.name}>
          {label}
        </Text>
        <Text variant="mono" as="span" style={styles.value}>
          {value}
        </Text>
        {/* Held in the row rather than removed from it, so crossing the rest position does
            not shuffle the label and the number sideways under the pointer. */}
        <button
          type="button"
          {...stylex.props(styles.reset, focusRing.ring, reset == null && styles.resetClean)}
          title={RawEditPanelStrings.resetControl(label)}
          aria-label={RawEditPanelStrings.resetControl(label)}
          disabled={reset == null}
          onClick={reset ?? undefined}
        >
          <RotateCcw size={12} {...stylex.props(styles.resetIcon)} />
        </button>
      </div>
      {children}
    </div>
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

  return (
    <EditControl
      label={spec.label}
      value={unknown ? '' : RawEditPanelStrings.valueWithUnit(reading(value, spec), spec.unit ?? '')}
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
              disabled={disabled}
            />
          </EditControl>
        </>
      )}
    </>
  );
});

/**
 * Which rendition the stage is standing in for.
 *
 * **The default is the library's own**, which serves HDR unless someone turned it off - so what
 * this offers is the narrower target a reader wants to check against, and the picture comes back
 * with its highlights rolled into diffuse white and its colours clipped to what sRGB holds.
 */
const SoftProofChoice = observer(function SoftProofChoice({
  stage,
  presenter,
}: {
  stage: StageStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  return (
    <div>
      <div {...stylex.props(styles.head, styles.headAboveSelect)}>
        <Text as="span" style={styles.name}>
          {RawEditPanelStrings.softProof()}
        </Text>
      </div>
      <Select
        style={styles.selectTrigger}
        label={RawEditPanelStrings.softProof()}
        options={SOFT_PROOFS}
        value={stage.softProof}
        onChange={presenter.setSoftProof}
      />
    </div>
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

export const RawEditPanel = observer(function RawEditPanel({
  edit,
  stage,
  crop,
  keystone,
  repair,
  presenter,
}: {
  edit: EditStore;
  stage: StageStore;
  crop: CropStore;
  keystone: KeystoneStore;
  repair: RepairStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const statusLabel = RawEditPanelStrings.status(stage.status);
  const status = stage.message !== '' ? RawEditPanelStrings.statusWithMessage(statusLabel, stage.message) : statusLabel;

  return (
    <div {...stylex.props(styles.panel)}>
      {(edit.saveStatus === 'conflict' || edit.saveStatus === 'failed' || stage.status !== 'live') && (
        <Panel style={styles.group}>
          {edit.saveStatus === 'conflict' && (
            <Text variant="muted" as="p">
              {RawEditPanelStrings.editedElsewhere()}
            </Text>
          )}
          {edit.saveStatus === 'failed' && (
            <Text variant="muted" as="p">
              {RawEditPanelStrings.couldNotSave()}
            </Text>
          )}
          {stage.status !== 'live' && (
            <Text as="p" variant={stage.status === 'failed' ? 'muted' : 'mono'} style={styles.status}>
              {status}
            </Text>
          )}
        </Panel>
      )}

      {crop.cropping ? (
        <CropPanel edit={edit} stage={stage} store={crop} presenter={presenter} styles={styles} />
      ) : keystone.keystoning ? (
        <KeystonePanel stage={stage} store={keystone} presenter={presenter} styles={styles} />
      ) : repair.repairing ? (
        <RepairPanel edit={edit} stage={stage} store={repair} presenter={presenter} styles={styles} />
      ) : (
        <>
          <Group title={RawEditPanelStrings.groupLight()}>
            {LIGHT.map((spec) => (
              <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title={RawEditPanelStrings.groupWhiteBalance()}>
            <WhiteBalance edit={edit} stage={stage} presenter={presenter} />
          </Group>
          <Group title={RawEditPanelStrings.groupColour()}>
            <ColourProfileChoice edit={edit} presenter={presenter} />
            {COLOUR.map((spec) => (
              <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title={RawEditPanelStrings.groupEffects()}>
            {EFFECTS.map((spec) => (
              <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />
            ))}
          </Group>
          {/* The denoise and the dust removal are the mosaic's, and a finished picture has none
              (`PreparedHeader.mosaic`). The sharpen is not: it inverts the capture's own blur on
              the warped frame, which every photograph has, so it stays.

              The same two go for a sensor whose pattern leaves the denoise no colour to separate:
              nothing was measured off that mosaic, so the sliders would move and the picture would
              not (`StageStore.denoises`). */}
          <Group title={RawEditPanelStrings.groupDetail()} busy={stage.repreparing}>
            {DETAIL.filter(
              (spec) => (stage.mosaic && stage.denoises) || spec.key === 'sharpening',
            ).map((spec) => (
              <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />
            ))}
            {!stage.mosaic && (
              <Text variant="muted" as="p">
                {RawEditPanelStrings.noMosaic()}
              </Text>
            )}
            {stage.mosaic && !stage.denoises && (
              <Text variant="muted" as="p">
                {RawEditPanelStrings.noDenoise()}
              </Text>
            )}
          </Group>
          {stage.mosaic && (
            <Group title={RawEditPanelStrings.groupDustRemoval()} busy={stage.repreparing}>
              <Dust edit={edit} stage={stage} presenter={presenter} />
            </Group>
          )}
          <Group title={RawEditPanelStrings.groupGeometry()}>
            <GeometryControls edit={edit} stage={stage} store={crop} presenter={presenter} styles={styles} />
          </Group>
          <Group title={RawEditPanelStrings.groupRendering()}>
            <SoftProofChoice stage={stage} presenter={presenter} />
          </Group>
        </>
      )}
    </div>
  );
});
