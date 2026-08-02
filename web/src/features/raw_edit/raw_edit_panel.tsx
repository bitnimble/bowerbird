import { observer } from 'mobx-react-lite';
import { Button } from '../../ui/button';
import { Slider } from '../../ui/slider';
import { Text } from '../../ui/text';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { RawEditStore } from './raw_edit_store';

const EV_RANGE = 5;

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
    >
      <Text variant="label" as="div" className="panel__title">
        Edit
      </Text>

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
          disabled={!store.live}
        />
      </div>

      {store.status !== 'live' && (
        <Text as="p" variant={store.status === 'failed' ? 'muted' : 'mono'} className="raw-edit-panel__status">
          {status}
        </Text>
      )}

      {/* Threads are not user-facing; e2e asserts the worker actually started multithreaded. */}
      <span hidden data-testid="raw-edit-threads">
        {store.threads}
      </span>

      <Button onClick={onDone}>Done</Button>
    </div>
  );
});
