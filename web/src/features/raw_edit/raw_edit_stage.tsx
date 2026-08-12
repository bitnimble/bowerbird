import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ZoomControl } from '../photos/zoom_control';
import { CropOverlay } from './crop_overlay';
import { KeystoneOverlay } from './keystone_overlay';
import { LoupeOverlay } from './loupe_overlay';
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
/**
 * How far a finger may travel and still have been a tap, in CSS pixels.
 *
 * A thumb resting on glass wanders a few pixels before it lifts, and every one of those would
 * otherwise be a drag that moved the loupe off the thing it was placed on.
 */
const TAP_SLOP = 8;

/** How far apart the two fingers of a pinch are. */
function spread(touches: Map<number, { x: number; y: number }>): number {
  const [first, second] = [...touches.values()];
  if (first == null || second == null) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

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
  /**
   * Whether the view has to be *fitted*, which only the geometry tools need.
   *
   * Both lay something out on the picture where a fitted view puts it, so a zoomed frame under
   * a crop rectangle or a keystone guide would have it naming somewhere else.
   */
  const fitted = store.cropping || store.keystoning;
  /**
   * Whether the stage's own zoom and pan take gestures.
   *
   * The loupe is here and not above: it needs the wheel for its magnification and the drag for
   * where the glass sits, so neither can also be the stage's - but it lays nothing out on the
   * picture, so **the reader's zoom is theirs to keep**. Magnifying part of an already-enlarged
   * frame is the ordinary way to use one.
   */
  const still = fitted || store.loupeOpen;
  const zoom = useZoomPan(viewport, stage, natural, undefined, !still);
  const { view, box, handlers, zoomed, reset } = zoom;

  // **Back to a fitted view whenever the picture's shape changes**, and whenever either geometry
  // tool opens. A turn or a straighten is a different picture, so a view held over from the last
  // one is a window somewhere outside it.
  //
  // Here rather than on the presenter, and this is the only place: the region follows the view
  // through the effect below, so a presenter that set the region itself would have this
  // overwrite it on the next render - a straighten drag wrote two regions per move, alternating.
  useEffect(() => {
    reset();
  }, [fitted, natural.width, natural.height, reset]);

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

  // Where the viewport starts on the page, read when the pointer arrives and not while it
  // moves. `box` carries the size but no origin, and a pointer move is as hot as a path here
  // gets - `getBoundingClientRect` in one is the reason that rule exists. Nothing scrolls the
  // stage under a loupe, since zoom and pan are off while it is open.
  const origin = useRef({ left: 0, top: 0 });

  // A native listener rather than React's `onWheel`, which is passive: the page would scroll
  // under the reader while the magnification changed.
  useEffect(() => {
    const element = viewport.current;
    if (element == null || !store.loupeOpen) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      presenter.zoomLoupe(Math.sign(event.deltaY), box);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [presenter, store.loupeOpen, box]);

  /**
   * The touches currently down, which is what makes a pinch tellable from a drag.
   *
   * A mouse never lands here: it moves the loupe by hovering, having nothing to hold down.
   */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ apart: number; magnification: number } | null>(null);
  /**
   * Where the drag began and where the glass was when it did.
   *
   * **A finger moves the loupe the way it moves a map, not the way a mouse does.** Dragging the
   * glass to the finger would put it under the finger, which is the one place its reader cannot
   * see; and jumping it there on touch-down would make every reposition a jolt. So a drag is a
   * displacement applied to where the glass already was, and the finger stays clear of it - a
   * tap, which is a drag that went nowhere, is what places it somewhere new.
   */
  const drag = useRef<{ from: { x: number; y: number }; loupe: { x: number; y: number } } | null>(
    null,
  );

  const measure = (event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    origin.current = { left: bounds.left, top: bounds.top };
  };
  const at = (event: React.PointerEvent<HTMLDivElement>) => ({
    x: event.clientX - origin.current.left,
    y: event.clientY - origin.current.top,
  });

  const loupeHandlers = store.loupeOpen
    ? {
        // A mouse arrives by hovering and reports where it is; a finger arrives by landing.
        onPointerEnter: measure,
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          measure(event);
          if (event.pointerType === 'mouse') return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const here = at(event);
          touches.current.set(event.pointerId, here);
          // A second finger stops being a place and starts being a distance.
          if (touches.current.size === 2) {
            pinch.current = {
              apart: spread(touches.current),
              magnification: store.loupeMagnification,
            };
            drag.current = null;
            return;
          }
          // Nothing moves yet. Where this ends up depends on whether the finger travels.
          drag.current = { from: here, loupe: store.loupeAt ?? here };
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === 'mouse') {
            presenter.moveLoupe(at(event), box);
            return;
          }
          if (!touches.current.has(event.pointerId)) return;
          const here = at(event);
          touches.current.set(event.pointerId, here);
          const pinching = pinch.current;
          if (pinching != null && touches.current.size === 2) {
            // The same ratio the fingers moved, so the magnification tracks the gesture rather
            // than counting notches it has no wheel to count.
            presenter.setLoupeMagnification(
              (pinching.magnification * spread(touches.current)) / Math.max(pinching.apart, 1),
              box,
            );
            return;
          }
          const dragging = drag.current;
          if (dragging == null) return;
          presenter.moveLoupe(
            {
              x: dragging.loupe.x + (here.x - dragging.from.x),
              y: dragging.loupe.y + (here.y - dragging.from.y),
            },
            box,
          );
        },
        onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
          const here = touches.current.get(event.pointerId);
          touches.current.delete(event.pointerId);
          if (touches.current.size < 2) pinch.current = null;
          const dragging = drag.current;
          drag.current = null;
          // A tap is a drag that went nowhere, and it is the gesture that *places* the glass.
          // Anything further than a thumb's own wobble was a drag, and has already moved it.
          if (dragging == null || here == null) return;
          const travelled = Math.hypot(here.x - dragging.from.x, here.y - dragging.from.y);
          if (travelled <= TAP_SLOP) presenter.moveLoupe(here, box);
        },
        onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
          touches.current.delete(event.pointerId);
          pinch.current = null;
          drag.current = null;
        },
        // Only a mouse. A finger that lifts leaves the glass where it put it, which is what
        // makes a tap a placement rather than a flash.
        onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === 'mouse') presenter.moveLoupe(null, box);
        },
      }
    : {};

  return (
    <div ref={stage} className={`stage raw-edit-stage${zoomed ? ' stage--zoomed' : ''}`}>
      {toolsInto == null ? <div className="stage__tools">{tools}</div> : createPortal(tools, toolsInto)}
      <div
        ref={viewport}
        className={`stage__viewport${store.loupeOpen ? ' stage__viewport--loupe' : ''}`}
        {...handlers}
        {...loupeHandlers}
      >
        <canvas ref={canvas} className="stage__content is-ready raw-edit__stage" />
        {/* Only while the slider is under a finger. A horizon is levelled against something
            straight, and the picture rarely offers one where it is needed - so the tool
            brings its own, and takes it away again rather than living over the photograph. */}
        {store.straightening && (
          <div
            className="straighten-grid"
            data-testid="straighten-grid"
            style={{ aspectRatio: `${natural.width} / ${natural.height}` }}
          />
        )}
        <CropOverlay store={store} presenter={presenter} viewport={box} />
        <KeystoneOverlay store={store} presenter={presenter} viewport={box} />
        <LoupeOverlay store={store} presenter={presenter} />
      </div>
      {!store.live && store.status !== 'failed' && (
        <div className="stage__busy">
          <div className="stage__spinner" />
        </div>
      )}
    </div>
  );
});
