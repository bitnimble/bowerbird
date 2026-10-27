import * as stylex from '@stylexjs/stylex';
import { Eye, Grid3x3, Info, Shapes, Sparkles, Sun } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useContext } from 'react';
import { CheckLabel } from '../../ui/check_label';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Panel } from '../../ui/panel';
import type { Option } from '../../ui/option';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import { CropPanel, GeometryControls } from './crop/crop_panel';
import { EditControl, SelectControl } from './edit_control';
import type { CropStore } from './crop/crop_store';
import type { EditStore } from './edit/edit_store';
import { EditSlider } from './edit_slider';
import { COLOUR, DETAIL, DUST, EFFECTS, TONE, reading, type SliderSpec } from './edit_sliders';
import type { RawEditPresenter } from './stage/raw_edit_presenter';
import { RawEditPanelStrings } from './raw_edit_panel.strings';
import { TEMPERATURE_KELVIN, TINT, type ColourProfile } from '../../../../src/schemas/photo_edits';
import { DENOISERS } from './denoisers';
import { KeystonePanel } from './keystone/keystone_panel';
import type { KeystoneStore } from './keystone/keystone_store';
import { styles } from './raw_edit_panel.stylex';
import type { StageStore } from './stage/stage_store';
import { RepairPanel } from './repair/repair_panel';
import type { RepairStore } from './repair/repair_store';
import { ReflectionPanel } from './reflection/reflection_panel';
import type { ReflectionStore } from './reflection/reflection_store';
import type { PrintStore } from './print/print_store';
import { proofPanels } from './print/print_controls';
import { EditToolsStrings } from './edit_tools.strings';
import { MobileEditPanels, type EditPanel } from './mobile_edit_panels';
import { EditTabs, GroupCollapse, type EditTab } from './edit_tabs';
import { SoftProofMenuStrings } from './proof/soft_proof_menu.strings';
import { ToneCurveEditor } from './tone_curve/tone_curve_editor';
import { ColourWheelEditor } from './colour_wheel/colour_wheel_editor';
import type { ColourWheelStore } from './colour_wheel/colour_wheel_store';

const COLOUR_PROFILES: Option<ColourProfile>[] = [
  { value: 'none', label: RawEditPanelStrings.colourProfileNone() },
  { value: 'matched', label: RawEditPanelStrings.colourProfileMatched() },
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

const TEMPERATURE_RANGE = { ...TEMPERATURE_KELVIN, step: 1 };
const TINT_RANGE = { ...TINT, step: 1 };

/** `busy` is the two mosaic groups' only: see `StageStore.repreparing`. */
const Group = observer(function Group({
  id,
  title,
  busy,
  children,
}: {
  id: string;
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const collapse = useContext(GroupCollapse);
  return (
    <Panel
      style={styles.group}
      titleStyle={styles.groupTitle}
      title={title}
      collapse={
        collapse == null
          ? undefined
          : {
              collapsed: collapse.store.collapsed.has(id),
              onToggle: () => collapse.presenter.toggleCollapsed(id),
            }
      }
      titleEnd={
        busy === true && (
          <span
            {...stylex.props(styles.spinner)}
            role="status"
            aria-label={RawEditPanelStrings.rebuildingThePhoto()}
          />
        )
      }
    >
      {children}
    </Panel>
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
      : (): void =>
          presenter.settle({ whiteBalanceMode: 'As Shot', temperature: null, tint: null });

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
            typing={
              disabled
                ? null
                : {
                    ...TEMPERATURE_RANGE,
                    set: (temperature) => presenter.settleBalance({ temperature }),
                  }
            }
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
            value={reading(balance.tint, TINT_RANGE)}
            reset={back}
            typing={
              disabled ? null : { ...TINT_RANGE, set: (tint) => presenter.settleBalance({ tint }) }
            }
          >
            <Slider
              style={styles.slider}
              value={balance.tint}
              onChange={(tint) => presenter.previewBalance({ tint })}
              onCommit={(tint) => presenter.settleBalance({ tint })}
              min={TINT_RANGE.min}
              max={TINT_RANGE.max}
              step={TINT_RANGE.step}
              snap={[neutral.tint]}
              tone="tint"
              label={RawEditPanelStrings.tint()}
              valueText={(at) => reading(at, TINT_RANGE)}
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
    <SelectControl
      label={RawEditPanelStrings.colourProfile()}
      options={COLOUR_PROFILES}
      value={edit.doc?.colourProfile ?? 'matched'}
      onChange={presenter.setColourProfile}
    />
  );
});

const DenoiserChoice = observer(function DenoiserChoice({
  edit,
  presenter,
}: {
  edit: EditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const options = DENOISERS.map((option) =>
    option.value === 'upscaler' && !edit.upscalable
      ? {
          ...option,
          disabled: true,
          tooltip: RawEditPanelStrings.denoiserUpscalerUnavailable(),
        }
      : option,
  );
  return (
    <SelectControl
      label={RawEditPanelStrings.denoiser()}
      options={options}
      value={edit.denoiser}
      onChange={presenter.setDenoiser}
    />
  );
});

function panelGroup(id: string, title: string, content: React.ReactNode, busy = false): EditPanel {
  return {
    id,
    title,
    content: (
      <Group id={id} title={title} busy={busy}>
        {content}
      </Group>
    ),
  };
}

export const RawEditPanel = observer(function RawEditPanel({
  edit,
  stage,
  crop,
  keystone,
  repair,
  reflection,
  colourWheel,
  print,
  presenter,
  info,
  mobile = false,
  style,
}: {
  edit: EditStore;
  stage: StageStore;
  crop: CropStore;
  keystone: KeystoneStore;
  repair: RepairStore;
  reflection: ReflectionStore;
  colourWheel: ColourWheelStore;
  print: PrintStore;
  presenter: RawEditPresenter;
  info?: React.ReactNode;
  mobile?: boolean;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  const notice = (edit.saveStatus === 'conflict' || edit.saveStatus === 'failed') && (
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
    </Panel>
  );
  let scope: string;
  let panels: EditPanel[];
  let tabs: EditTab[] | null = null;
  if (crop.cropping) {
    scope = 'crop';
    panels = [
      {
        id: 'aspect',
        title: RawEditPanelStrings.aspectRatio(),
        content: (
          <CropPanel
            edit={edit}
            stage={stage}
            store={crop}
            presenter={presenter}
            styles={styles}
            section="aspect"
          />
        ),
      },
      {
        id: 'crop',
        title: EditToolsStrings.crop(),
        content: (
          <CropPanel
            edit={edit}
            stage={stage}
            store={crop}
            presenter={presenter}
            styles={styles}
            section="geometry"
          />
        ),
      },
    ];
  } else if (keystone.keystoning) {
    scope = 'perspective';
    panels = [
      {
        id: 'perspective',
        title: EditToolsStrings.perspective(),
        content: (
          <KeystonePanel stage={stage} store={keystone} presenter={presenter} styles={styles} />
        ),
      },
    ];
  } else if (repair.repairing) {
    scope = 'repair';
    panels = [
      {
        id: 'repair',
        title: EditToolsStrings.repair(),
        content: (
          <RepairPanel
            edit={edit}
            stage={stage}
            store={repair}
            presenter={presenter}
            styles={styles}
          />
        ),
      },
    ];
  } else {
    scope = 'adjust';
    const sliders = (specs: readonly SliderSpec[]): React.ReactNode =>
      specs.map((spec) => (
        <EditSlider key={spec.key} edit={edit} stage={stage} presenter={presenter} spec={spec} />
      ));
    const proof = proofPanels(stage.softProof, print, presenter.print, !stage.editable);
    tabs = [
      {
        id: 'tone',
        title: RawEditPanelStrings.groupTone(),
        icon: <Sun size={ICON} />,
        panels: [
          panelGroup(
            'tone',
            RawEditPanelStrings.groupTone(),
            <>
              {sliders(TONE)}
              <ToneCurveEditor edit={edit} stage={stage} presenter={presenter} />
            </>,
          ),
          panelGroup(
            'white-balance',
            RawEditPanelStrings.groupWhiteBalance(),
            <WhiteBalance edit={edit} stage={stage} presenter={presenter} />,
          ),
          panelGroup(
            'colour',
            RawEditPanelStrings.groupColour(),
            <>
              <ColourProfileChoice edit={edit} presenter={presenter} />
              {sliders(COLOUR)}
              <ColourWheelEditor
                store={colourWheel}
                stage={stage}
                presenter={presenter.colourWheel}
              />
            </>,
          ),
        ],
      },
      {
        id: 'detail',
        title: RawEditPanelStrings.groupDetail(),
        icon: <Grid3x3 size={ICON} />,
        panels: [
          panelGroup(
            'detail',
            RawEditPanelStrings.groupDetail(),
            <>
              {stage.mosaic && stage.denoises && (
                <DenoiserChoice edit={edit} presenter={presenter} />
              )}
              {sliders(
                DETAIL.filter(
                  (spec) =>
                    (stage.mosaic && (stage.denoises || spec.key === 'highlightRecovery')) ||
                    spec.key === 'sharpening',
                ),
              )}
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
            </>,
            stage.repreparing,
          ),
          panelGroup('effects', RawEditPanelStrings.groupEffects(), sliders(EFFECTS)),
          ...(stage.mosaic
            ? [
                panelGroup(
                  'dust',
                  RawEditPanelStrings.groupDustRemoval(),
                  <Dust edit={edit} stage={stage} presenter={presenter} />,
                  stage.repreparing,
                ),
              ]
            : []),
        ],
      },
      {
        id: 'retouch',
        title: RawEditPanelStrings.groupRetouch(),
        icon: <Sparkles size={ICON} />,
        panels: [
          panelGroup(
            'reflection',
            RawEditPanelStrings.groupReflectionRemoval(),
            stage.mosaic ? (
              <ReflectionPanel edit={edit} stage={stage} store={reflection} presenter={presenter} />
            ) : (
              <Text variant="muted" as="p">
                {RawEditPanelStrings.noReflectionRemoval()}
              </Text>
            ),
            stage.repreparing,
          ),
        ],
      },
      {
        id: 'geometry',
        title: RawEditPanelStrings.groupGeometry(),
        icon: <Shapes size={ICON} />,
        panels: [
          panelGroup(
            'geometry',
            RawEditPanelStrings.groupGeometry(),
            <GeometryControls
              edit={edit}
              stage={stage}
              store={crop}
              presenter={presenter}
              styles={styles}
            />,
          ),
        ],
      },
      ...(info == null
        ? []
        : [
            {
              id: 'info',
              title: RawEditPanelStrings.groupInfo(),
              icon: <Info size={ICON} />,
              panels: [{ id: 'info', title: RawEditPanelStrings.groupInfo(), content: info }],
            },
          ]),
      ...(proof.length === 0
        ? []
        : // Keyed by the proof, so choosing another one selects its tab again.
          [
            {
              id: `proof-${stage.softProof}`,
              title: SoftProofMenuStrings.softProof(),
              icon: <Eye size={ICON} />,
              panels: proof,
            },
          ]),
    ];
    panels = tabs.flatMap((tab) => tab.panels);
  }
  if (mobile) return <MobileEditPanels panels={panels} scope={scope} notice={notice} />;
  return <EditTabs tabs={tabs} panels={panels} notice={notice} style={style} />;
});
