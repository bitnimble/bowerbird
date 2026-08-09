import { observer } from 'mobx-react-lite';
import type { EditDoc } from '../../api/client';
import { Button } from '../../ui/button';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { RawEditStore } from './raw_edit_store';

const EV_RANGE = 5;

/**
 * The sliders, in Camera Raw's order and at Camera Raw's ranges.
 *
 * The order is not decorative: a reader who has used Lightroom reaches for
 * exposure and contrast at the top of a tone group and finds them there, and the
 * ranges match what `EditDoc` stores so nothing on this side scales anything.
 *
 * `step` is 1 for the integer sliders and 0.01 for the two reals, which is the
 * schema's own distinction rather than a display choice: `crs:Exposure2012` and
 * `crs:Dehaze` are reals and their neighbours are not.
 */
const GROUPS: ReadonlyArray<{
  title: string;
  sliders: ReadonlyArray<{ key: keyof EditDoc & string; label: string; min: number; max: number; step: number }>;
}> = [
  {
    title: 'Tone',
    sliders: [
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
      { key: 'whites', label: 'Whites', min: -100, max: 100, step: 1 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1 },
    ],
  },
  {
    title: 'Presence',
    sliders: [
      { key: 'texture', label: 'Texture', min: -100, max: 100, step: 1 },
      { key: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1 },
      { key: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 0.01 },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
    ],
  },
];

// What reaches the shader, in the editor *and* in a rendition, which is the same WGSL
// either way. Everything in the two groups above does, so nothing here is labelled - the set
// stays because white balance still does not, and the next slider to be added will not
// either until it is wired up.
const RENDERED = new Set<string>([
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'texture',
  'clarity',
  'dehaze',
  'vibrance',
  'saturation',
]);

const EditSlider = observer(function EditSlider({
  store,
  presenter,
  slider,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
  slider: { key: keyof EditDoc & string; label: string; min: number; max: number; step: number };
}): JSX.Element {
  const value = Number(store.doc?.[slider.key] ?? 0);
  const rendered = RENDERED.has(slider.key);

  return (
    <div className="raw-edit-panel__slider" data-testid={`raw-edit-${slider.key}`}>
      <Text variant="label" as="span">
        {slider.label} {value > 0 ? '+' : ''}
        {slider.step < 1 ? value.toFixed(2) : value}
        {rendered ? '' : ' (saved, not yet rendered)'}
      </Text>
      <Slider
        value={value}
        onChange={(next) => presenter.preview({ [slider.key]: next })}
        onCommit={(next) => presenter.settle({ [slider.key]: next })}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        label={slider.label}
        disabled={store.doc == null}
      />
    </div>
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
 * Closed only where the file recorded no usable multipliers, which leaves nothing to be
 * relative to. The mode - "As Shot", "Daylight", a name from a sidecar - is shown beside them
 * because it is what the document still says until something moves.
 *
 * The range is Camera Raw's own and so is unbounded by the frame: a 2000K photo can be dragged
 * to 50000 and back, and the picture at rest is the one the camera made.
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

  return (
    <div className="raw-edit-panel__group" data-testid="raw-edit-white-balance">
      <Text variant="label" as="div">
        White balance
      </Text>
      <Text variant="muted" as="div">
        {doc == null
          ? '-'
          : balance == null
            ? 'this file records no camera neutral, so there is nothing to balance against'
            : doc.whiteBalanceMode}
      </Text>
      {balance != null && (
        <>
          <div className="raw-edit-panel__slider" data-testid="raw-edit-temperature">
            <Text variant="label" as="span">
              Temperature {balance.temperature} K
            </Text>
            <Slider
              value={balance.temperature}
              onChange={(temperature) => presenter.previewBalance({ temperature })}
              onCommit={(temperature) => presenter.settleBalance({ temperature })}
              min={2000}
              max={50000}
              step={50}
              label="Temperature"
              disabled={doc == null}
            />
          </div>
          <div className="raw-edit-panel__slider" data-testid="raw-edit-tint">
            <Text variant="label" as="span">
              Tint {balance.tint > 0 ? '+' : ''}
              {balance.tint}
            </Text>
            <Slider
              value={balance.tint}
              onChange={(tint) => presenter.previewBalance({ tint })}
              onCommit={(tint) => presenter.settleBalance({ tint })}
              min={-150}
              max={150}
              step={1}
              label="Tint"
              disabled={doc == null}
            />
          </div>
        </>
      )}
    </div>
  );
});

export const RawEditPanel = observer(function RawEditPanel({
  store,
  presenter,
  onDone,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
  onDone: () => void;
}): JSX.Element {
  const status = store.message !== '' ? `${store.status} - ${store.message}` : store.status;

  return (
    <div
      className="panel raw-edit-panel"
      data-testid="raw-edit-panel"
      data-status={store.status}
      data-matched={store.matched ? 'true' : 'false'}
      data-save={store.saveStatus}
    >
      <Text variant="label" as="div" className="panel__title">
        Edit
      </Text>

      <div className="raw-edit-panel__history">
        <Button onClick={presenter.undo} disabled={!store.canUndo} data-testid="raw-edit-undo">
          Undo
        </Button>
        <Button onClick={presenter.redo} disabled={!store.canRedo} data-testid="raw-edit-redo">
          Redo
        </Button>
        {store.saveStatus === 'conflict' && (
          <Text variant="muted" as="span">
            These edits changed elsewhere. Reopen to pick them up.
          </Text>
        )}
        {store.saveStatus === 'failed' && (
          <Text variant="muted" as="span">
            Could not save.
          </Text>
        )}
      </div>

      <div className="raw-edit-panel__exposure">
        <Text variant="label" as="span">
          Exposure {store.exposureEv > 0 ? '+' : ''}
          {store.exposureEv.toFixed(2)} EV
        </Text>
        <Slider
          value={store.exposureEv}
          onChange={presenter.previewExposure}
          onCommit={presenter.settleExposure}
          min={-EV_RANGE}
          max={EV_RANGE}
          step={0.01}
          label="Exposure"
          // Both conditions, not just `live`. The frame and the settings arrive
          // separately, so a read that failed leaves a live pipeline with no
          // document to write into - and `preview` returns early on that, which
          // is a slider that moves and does nothing.
          disabled={!store.live || store.doc == null}
        />
      </div>

      <WhiteBalance store={store} presenter={presenter} />

      {GROUPS.map((group) => (
        <div key={group.title} className="raw-edit-panel__group">
          <Text variant="label" as="div">
            {group.title}
          </Text>
          {group.sliders.map((slider) => (
            <EditSlider key={slider.key} store={store} presenter={presenter} slider={slider} />
          ))}
        </div>
      ))}

      {store.status !== 'live' && (
        <Text as="p" variant={store.status === 'failed' ? 'muted' : 'mono'} className="raw-edit-panel__status">
          {status}
        </Text>
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

      <Button onClick={onDone}>Done</Button>
    </div>
  );
});
