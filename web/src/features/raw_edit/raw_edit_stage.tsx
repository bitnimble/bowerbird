import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ZoomControl } from '../photos/zoom_control';
import { CropOverlay } from './crop_overlay';
import { KeystoneOverlay } from './keystone_overlay';
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
  toolsInto,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
  /**
   * Where to draw the zoom control, which is the viewer's own and goes where the viewer's
   * goes. A portal for the reason the viewer uses one: the readout changes on every frame of
   * a wheel zoom, and handing it upwards would redraw the page around the stage at that rate.
   */
  toolsInto?: HTMLElement | null;
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

  // The *picture*, not the frame: a cropped photo is a different shape, and fitting the stage
  // to the frame would letterbox the crop inside it.
  const natural = store.width === 0 ? NO_SIZE : store.output;
  // Zoom and pan are off under both geometry tools: each lays something out on the picture where
  // a fitted view puts it, and a pan would slide the photograph out from under it.
  const still = store.cropping || store.keystoning;
  const zoom = useZoomPan(viewport, stage, natural, undefined, !still);
  const { view, box, handlers, zoomed, reset } = zoom;

  // **Back to a fitted view whenever the picture's shape changes**, and whenever either geometry
  // tool opens. A turn or a straighten is a different picture, so a view held over from the last
  // one is a window somewhere outside it; and both overlays lay themselves out on the *contained*
  // canvas, which is only where the canvas is when the view is fitted - a rectangle or a guide
  // drawn over a zoomed frame would name something other than what the reader is looking at.
  //
  // Here rather than on the presenter, and this is the only place: the region follows the view
  // through the effect below, so a presenter that set the region itself would have this
  // overwrite it on the next render - a straighten drag wrote two regions per move, alternating.
  useEffect(() => {
    reset();
  }, [still, natural.width, natural.height, reset]);

  // The gesture is state in React and the region is state in the store, so one has to follow
  // the other. An effect rather than a call inside the handler, because the view settles
  // after React has re-rendered and the presenter wants the value it settled on.
  useEffect(() => {
    if (natural.width === 0 || box.width === 0) return;
    presenter.showRegion(regionOf(view, box, natural));
  }, [presenter, view, box, natural.width, natural.height]);

  // **Zoom and pan are off while a geometry tool is open**, control and gestures both - the flag
  // above turns the hook off, including the wheel, which is a native listener the handlers never
  // covered. On a touch screen the pan is the same one-finger drag the rectangle and the guides
  // themselves want. Nothing here needs zoom: both tools open fitted, which is the view a crop
  // and a perspective are judged from.
  const tools = still ? null : <ZoomControl zoom={zoom} variant={toolsInto == null ? 'ghost' : 'default'} />;

  return (
    <div ref={stage} className={`stage raw-edit-stage${zoomed ? ' stage--zoomed' : ''}`}>
      {toolsInto == null ? <div className="stage__tools">{tools}</div> : createPortal(tools, toolsInto)}
      <div ref={viewport} className="stage__viewport" {...handlers}>
        <canvas ref={canvas} className="stage__content is-ready raw-edit__stage" />
        <CropOverlay store={store} presenter={presenter} viewport={box} />
        <KeystoneOverlay store={store} presenter={presenter} viewport={box} />
      </div>
      {!store.live && store.status !== 'failed' && (
        <div className="stage__busy">
          <div className="stage__spinner" />
        </div>
      )}
    </div>
  );
});
