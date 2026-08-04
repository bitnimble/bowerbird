import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { NO_SIZE, regionOf, useZoomPan } from '../photos/zoom_pan';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { RawEditStore } from './raw_edit_store';

/**
 * The graded frame in the detail stage's slot.
 *
 * One canvas, and no `<img>`, `<video>`, blob URL or track behind it: the tick draws
 * straight into an extended-range WebGPU canvas (`docs/raw-edit-gpu.md` §7).
 *
 * The element is handed to the presenter rather than configured here, because configuring
 * it *is* the picture - the format and the tone mapping decide whether anything above SDR
 * white reaches the panel - and that belongs with the code that knows the frame's size.
 *
 * Zoom and pan are the viewer's, from `zoom_pan.ts`, so the gesture is the same one in both
 * places. What differs is only what a view *means*: the viewer transforms an element, and a
 * canvas has nothing to transform - the tick draws whatever rectangle it is given, so the
 * view becomes a region and the frame is redrawn at it. Which is the better end of the deal,
 * since the redraw is at the stage's own resolution rather than a magnified raster.
 */
export const RawEditStage = observer(function RawEditStage({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  // The wheel listens on the stage and the box is measured from the viewport, exactly as the
  // viewer does it: the stage is what a pointer is over, the viewport is what the frame is
  // fitted into.
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    presenter.attach(canvas.current);
    return () => presenter.attach(null);
  }, [presenter]);

  const natural =
    store.width === 0 ? NO_SIZE : { width: store.width, height: store.height };
  const { view, box, handlers, zoomed } = useZoomPan(viewport, stage, natural);

  // The gesture is state in React and the region is state in the store, so one has to follow
  // the other. An effect rather than a call inside the handler, because the view settles
  // after React has re-rendered and the presenter wants the value it settled on.
  useEffect(() => {
    if (natural.width === 0 || box.width === 0) return;
    presenter.showRegion(regionOf(view, box, natural));
  }, [presenter, view, box, natural.width, natural.height]);

  return (
    <div ref={stage} className={`stage raw-edit-stage${zoomed ? ' stage--zoomed' : ''}`}>
      <div ref={viewport} className="stage__viewport" {...handlers}>
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
