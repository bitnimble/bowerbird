import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { RawEditStore } from './raw_edit_store';

/**
 * The graded frame in the detail stage's slot.
 *
 * One canvas, and no `<img>`, `<video>`, blob URL or track behind it: the tick draws
 * straight into an extended-range WebGPU canvas, which is what let the three sinks and
 * their per-engine routing go (`docs/raw-edit-gpu.md` §7).
 *
 * The element is handed to the presenter rather than configured here, because configuring
 * it *is* the picture - the format and the tone mapping decide whether anything above SDR
 * white reaches the panel - and that belongs with the code that knows the frame's size.
 */
export const RawEditStage = observer(function RawEditStage({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    presenter.attach(canvas.current);
    return () => presenter.attach(null);
  }, [presenter]);

  return (
    <div className="stage raw-edit-stage">
      <div className="stage__viewport">
        <canvas ref={canvas} className="stage__content is-ready raw-edit__stage" />
      </div>
      {!store.live && store.status !== 'failed' && (
        <div className="stage__busy">
          <div className="stage__spinner" />
        </div>
      )}
    </div>
  );
});
