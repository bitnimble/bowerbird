import { MoveHorizontal, MoveVertical, RotateCcw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { EditDoc } from '../../api/client';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { GuideKind, RawEditStore } from './raw_edit_store';

const GUIDE_KINDS: Option<GuideKind>[] = [
  { value: 'vertical', label: 'Vertical', icon: <MoveVertical size={ICON} />, testId: 'raw-edit-guide-vertical' },
  {
    value: 'horizontal',
    label: 'Horizontal',
    icon: <MoveHorizontal size={ICON} />,
    testId: 'raw-edit-guide-horizontal',
  },
];

const EV_RANGE = 5;

/**
 * The hottest the temperature slider goes, where the document's own range runs to 50000K.
 *
 * The document keeps Camera Raw's range because a sidecar can carry any of it (`photo_edits.ts`),
 * but nothing above deep shade is a balance anyone reaches for - and at 50000 the whole usable
 * span, candlelight to overcast, was the first sixth of the track. A photograph that arrives
 * hotter than this still shows where it stands: the slider takes its own value as the end.
 */
const MAX_KELVIN = 15000;

interface SliderSpec {
  key: keyof EditDoc & string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** What the number reads in, where it is not a bare slider position. */
  unit?: string;
  /**
   * Where the reset arrow and the detent go, and what counts as untouched.
   *
   * Zero for every slider that runs either side of nothing. The Detail pair is what makes
   * this a field: their document default is 33, so resetting them to 0 would hand back a
   * picture with its noise in it and call that neutral.
   */
  neutral?: number;
}

/**
 * The sliders, grouped as a reader thinks of them and at the ranges `EditDoc` stores.
 *
 * The exposure is the only one that steps by a hundredth, EV being a unit a reader means a
 * fraction of. `dehaze` is a real in the document because `crs:Dehaze` is one and an import
 * has to round-trip it, but a control that reads `+40.00` beside four neighbours reading
 * `+40` is stating a precision nobody asked for - so it is stepped like them.
 *
 * The tone four run lightest to darkest - highlights, whites, shadows, blacks - so the column
 * reads as the histogram it acts on rather than as Camera Raw's field order.
 */
const LIGHT: readonly SliderSpec[] = [
  { key: 'exposure', label: 'Exposure', min: -EV_RANGE, max: EV_RANGE, step: 0.01, unit: ' EV' },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
  { key: 'whites', label: 'Whites', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1 },
];

const COLOUR: readonly SliderSpec[] = [
  { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
];

const EFFECTS: readonly SliderSpec[] = [
  { key: 'texture', label: 'Texture', min: -100, max: 100, step: 1 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1 },
  { key: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 1 },
];

/**
 * The denoise, as Camera Raw's Detail panel names its two halves.
 *
 * **0 to 100 rather than -100 to 100**, unlike every slider above: there is no such thing as
 * negative noise reduction, and a detent in the middle of a track whose left half does not
 * exist would invite one. Their default is 40 and not 0, so the reset arrow on these two
 * returns to a denoised picture rather than to a raw one.
 */
const DETAIL: readonly SliderSpec[] = [
  { key: 'luminanceNoise', label: 'Luminance', min: 0, max: 100, step: 1, neutral: 40 },
  { key: 'colourNoise', label: 'Colour', min: 0, max: 100, step: 1, neutral: 40 },
];

/// Signed only where the track has a negative half; `+33` on a 0-to-100 slider states a
/// direction it has no opposite of.
function reading(value: number, spec: SliderSpec): string {
  const sign = spec.min < 0 && value > 0 ? '+' : '';
  return `${sign}${spec.step < 1 ? value.toFixed(2) : value}`;
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        {title}
      </Text>
      {children}
    </div>
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
  dirty,
  onReset,
  testId,
  className,
  children,
}: {
  label: string;
  value: string;
  dirty: boolean;
  onReset: () => void;
  testId: string;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={`raw-edit-panel__control${className == null ? '' : ` ${className}`}`}
      data-testid={testId}
      onDoubleClick={dirty ? onReset : undefined}
    >
      <div className="raw-edit-panel__head">
        {/* Body rather than `label`: the group's own title wears that, and a row named in the
            same 10px uppercase mono left the panel with no hierarchy at all. */}
        <Text as="span" className="raw-edit-panel__name">
          {label}
        </Text>
        <Text variant="mono" as="span" className="raw-edit-panel__value">
          {value}
        </Text>
        {/* Held in the row rather than removed from it, so crossing the detent does not
            shuffle the label and the number sideways under the pointer. */}
        <button
          type="button"
          className={`raw-edit-panel__reset${dirty ? '' : ' is-clean'}`}
          title={`Reset ${label}`}
          aria-label={`Reset ${label}`}
          onClick={onReset}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

const EditSlider = observer(function EditSlider({
  store,
  presenter,
  spec,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
  spec: SliderSpec;
}): JSX.Element {
  const neutral = spec.neutral ?? 0;
  const value = Number(store.doc?.[spec.key] ?? neutral);

  return (
    <EditControl
      label={spec.label}
      value={`${reading(value, spec)}${spec.unit ?? ''}`}
      dirty={value !== neutral}
      onReset={() => presenter.settle({ [spec.key]: neutral })}
      testId={`raw-edit-${spec.key}`}
      // The exposure is what an e2e drags to prove a value reaches the server, and it needs a
      // handle on the row rather than on the panel.
      className={spec.key === 'exposure' ? 'raw-edit-panel__exposure' : undefined}
    >
      <Slider
        value={value}
        onChange={(next) => presenter.preview({ [spec.key]: next })}
        onCommit={(next) => presenter.settle({ [spec.key]: next })}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        detent={neutral}
        label={spec.label}
        // Both conditions, not just `live`. The frame and the settings arrive separately, so a
        // read that failed leaves a live pipeline with no document to write into - and `preview`
        // returns early on that, which is a slider that moves and does nothing.
        disabled={!store.live || store.doc == null}
      />
    </EditControl>
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
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const doc = store.doc;
  const balance = store.balance;
  const neutral = store.asShotBalance;
  const moved = doc != null && (doc.temperature != null || doc.tint != null);
  const disabled = !store.live || doc == null;
  const asShot = (): void => presenter.settle({ whiteBalanceMode: 'As Shot', temperature: null, tint: null });

  return (
    <div data-testid="raw-edit-white-balance">
      {/* What the document still says, until something moves. No reset beside it: both sliders
          below already put the pair back, and they move as a pair. */}
      <div className="raw-edit-panel__head raw-edit-panel__head--bare">
        <Text variant="mono" as="span" className="raw-edit-panel__value">
          {doc?.whiteBalanceMode ?? '-'}
        </Text>
      </div>

      {balance == null || neutral == null ? (
        <Text variant="muted" as="p">
          {doc == null ? '' : 'this file records no camera neutral, so there is nothing to balance against'}
        </Text>
      ) : (
        <>
          <EditControl
            label="Temperature"
            value={`${balance.temperature} K`}
            dirty={moved}
            onReset={asShot}
            testId="raw-edit-temperature"
          >
            <Slider
              value={balance.temperature}
              onChange={(temperature) => presenter.previewBalance({ temperature })}
              onCommit={(temperature) => presenter.settleBalance({ temperature })}
              min={2000}
              max={Math.max(MAX_KELVIN, balance.temperature, neutral.temperature)}
              step={50}
              detent={neutral.temperature}
              tone="temperature"
              label="Temperature"
              disabled={disabled}
            />
          </EditControl>
          <EditControl
            label="Tint"
            value={reading(balance.tint, 1)}
            dirty={moved}
            onReset={asShot}
            testId="raw-edit-tint"
          >
            <Slider
              value={balance.tint}
              onChange={(tint) => presenter.previewBalance({ tint })}
              onCommit={(tint) => presenter.settleBalance({ tint })}
              min={-150}
              max={150}
              step={1}
              detent={neutral.tint}
              tone="tint"
              label="Tint"
              disabled={disabled}
            />
          </EditControl>
        </>
      )}
    </div>
  );
});

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
const Geometry = observer(function Geometry({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const doc = store.doc;
  const angle = doc?.cropAngle ?? 0;

  return (
    <>
      <EditControl
        label="Straighten"
        value={`${reading(angle, 0.05)}°`}
        dirty={angle !== 0}
        onReset={() => presenter.settleStraighten(0)}
        testId="raw-edit-straighten"
      >
        <Slider
          value={angle}
          onChange={presenter.previewStraighten}
          onCommit={presenter.settleStraighten}
          min={-45}
          max={45}
          step={0.05}
          detent={0}
          // A horizon is a fraction of a degree out, and the range is ±45: the default share of
          // that would put every angle anyone actually straightens by inside the snap.
          snap={0.2}
          label="Straighten"
          disabled={!store.live || doc == null}
        />
      </EditControl>

      <label className="check raw-edit-panel__check">
        <input
          type="checkbox"
          checked={store.cropToFit}
          disabled={doc == null}
          onChange={(event) => presenter.setCropToFit(event.currentTarget.checked)}
          data-testid="raw-edit-crop-to-fit"
        />
        <Text as="span" className="raw-edit-panel__name">
          Crop to fit
        </Text>
      </label>
    </>
  );
});

/**
 * The perspective tool's own controls: which pair is being drawn, and the lines already down.
 *
 * **The two pairs are independent and the panel says so.** A pair of lines down edges that are
 * upright in life fixes the vertical; a pair across edges that are level fixes the horizontal;
 * neither needs the other and either may be drawn first. That was invisible when the tool was
 * four anonymous lines and a sentence about "the first two", and a reader who drew two
 * horizontals first was told they had done it wrong.
 *
 * The pair a line belongs to is the line's own direction (`isUpright`), so this picker chooses
 * what is about to be drawn rather than labelling anything - and a line that comes out the
 * other way joins the other pair, which the list below shows immediately.
 */
const Perspective = observer(function Perspective({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const doc = store.doc;
  const pairs = store.guidePairs;
  const kind = store.guideKind;

  return (
    <>
      <SegmentedControl
        label="Guides to draw"
        options={GUIDE_KINDS}
        value={kind}
        onChange={presenter.setGuideKind}
        stretch
      />

      <Text variant="muted" as="p">
        {pairs[kind].length === 0
          ? `Drag a line along an edge that is ${kind === 'vertical' ? 'upright' : 'level'} in life.`
          : pairs[kind].length === 1
            ? 'One more along a second edge parallel to it, and the pair is what gets corrected.'
            : 'That pair is corrected. Draw the other to fix the second axis too.'}
      </Text>

      {(['vertical', 'horizontal'] as const).map((each) =>
        pairs[each].map(({ index }, at) => (
          <div key={index} className="raw-edit-panel__guide" data-testid={`raw-edit-guide-${index}`}>
            <span className={`raw-edit-panel__swatch raw-edit-panel__swatch--${each}`} />
            <Text as="span" className="raw-edit-panel__name">
              {each === 'vertical' ? 'Vertical' : 'Horizontal'} {at + 1}
            </Text>
            <button
              type="button"
              className="raw-edit-panel__reset"
              aria-label={`Remove ${each} guide ${at + 1}`}
              title="Remove this guide"
              onClick={() => presenter.removeGuide(index)}
            >
              <X size={12} />
            </button>
          </div>
        )),
      )}

      <div className="raw-edit-panel__actions">
        <Button
          onClick={presenter.clearKeystone}
          disabled={doc == null || (!store.keystoned && store.guides.length === 0)}
          data-testid="raw-edit-keystone-clear"
        >
          Clear guides
        </Button>
      </div>
    </>
  );
});

export const RawEditPanel = observer(function RawEditPanel({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const status = store.message !== '' ? `${store.status} - ${store.message}` : store.status;

  return (
    <div
      className="raw-edit-panel"
      data-testid="raw-edit-panel"
      data-status={store.status}
      data-matched={store.matched ? 'true' : 'false'}
      data-save={store.saveStatus}
    >
      {(store.saveStatus === 'conflict' || store.saveStatus === 'failed' || store.status !== 'live') && (
        <div className="panel">
          {store.saveStatus === 'conflict' && (
            <Text variant="muted" as="p">
              These edits changed elsewhere. Reopen to pick them up.
            </Text>
          )}
          {store.saveStatus === 'failed' && (
            <Text variant="muted" as="p">
              Could not save.
            </Text>
          )}
          {store.status !== 'live' && (
            <Text
              as="p"
              variant={store.status === 'failed' ? 'muted' : 'mono'}
              className="raw-edit-panel__status"
              // Read by the e2e open: a failed status alone says a GPU refused the tick and
              // not which of forty passes it refused, which is the only useful part.
              data-testid="raw-edit-status"
            >
              {status}
            </Text>
          )}
        </div>
      )}

      {store.cropping ? (
        <Group title="Crop">
          <Geometry store={store} presenter={presenter} />
        </Group>
      ) : store.keystoning ? (
        <Group title="Perspective">
          <Perspective store={store} presenter={presenter} />
        </Group>
      ) : (
        <>
          <Group title="Light">
            {LIGHT.map((spec) => (
              <EditSlider key={spec.key} store={store} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title="White balance">
            <WhiteBalance store={store} presenter={presenter} />
          </Group>
          <Group title="Colour">
            {COLOUR.map((spec) => (
              <EditSlider key={spec.key} store={store} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title="Effects">
            {EFFECTS.map((spec) => (
              <EditSlider key={spec.key} store={store} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title="Detail">
            {DETAIL.map((spec) => (
              <EditSlider key={spec.key} store={store} presenter={presenter} spec={spec} />
            ))}
          </Group>
          <Group title="Geometry">
            <Geometry store={store} presenter={presenter} />
          </Group>
        </>
      )}

      {/* Not user-facing; e2e asserts the tick really ran on a GPU rather than falling back
          to a picture nobody graded. */}
      <span hidden data-testid="raw-edit-adapter">
        {store.adapter}
      </span>
      <span hidden data-testid="raw-edit-size">
        {store.width}x{store.height}
      </span>
      {/* The part of the frame on screen. Zoom and pan move this and nothing else, so it is
          the one value that says whether the gesture reached the tick. */}
      <span hidden data-testid="raw-edit-region">
        {store.region == null
          ? ''
          : `${Math.round(store.region.x)},${Math.round(store.region.y)} ${Math.round(store.region.width)}x${Math.round(store.region.height)}`}
      </span>
      {/* What a save would send, so an e2e can assert persistence without a GPU. */}
      <span hidden data-testid="raw-edit-rev">
        {store.rev}
      </span>
    </div>
  );
});
