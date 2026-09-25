import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { color } from '../../../ui/tokens.stylex';
import { toggleFullscreenOf } from '../../photos/viewer/fullscreen';
import { stageStyles } from '../../photos/viewer/photo_stage.stylex';
import { Spinner } from '../../../ui/spinner';
import { Text } from '../../../ui/text';
import { PhotoStageStrings } from '../../photos/viewer/photo_stage.strings';
import { ZoomControl, ZoomSlider } from '../../photos/viewer/zoom_control';
import { CropOverlay } from '../crop/crop_overlay';
import type { CropStore } from '../crop/crop_store';
import { KeystoneOverlay } from '../keystone/keystone_overlay';
import type { KeystoneStore } from '../keystone/keystone_store';
import { RepairOverlay, TAP_SLOP } from '../repair/repair_overlay';
import type { RepairStore } from '../repair/repair_store';
import { LoupeOverlay } from '../loupe/loupe_overlay';
import type { LoupeStore } from '../loupe/loupe_store';
import { NO_SIZE, regionOf, useZoomPan } from '../../photos/viewer/zoom_pan';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { StageStore } from './stage_store';
import { RawEditStageStrings } from './raw_edit_stage.strings';
import type { PrintStore } from '../print/print_store';
import { PrintPanelStrings } from '../print/print_panel.strings';
import { focusRing } from '../../../ui/focus_ring';
import { useIsTouch } from '../../../app/device';

const styles = stylex.create({
  // The page's own surround rather than black: at black the letterbox read as two bars framing the
  // photograph. Nothing on this subtree or above it may carry a filter, opacity, transform or blend
  // mode - any of them rasterises into an SDR intermediate and the PQ tagging is silently lost.
  stage: {
    height: '100%',
    backgroundColor: color.ink,
  },
  loupe: {
    cursor: 'none',
  },
  reason: {
    maxWidth: '48ch',
    textAlign: 'center',
  },
  print: { cursor: 'grab' },
  draggingPrint: { cursor: 'grabbing' },
  // Levelling wants a line near whatever is meant to be straight, so tenths rather than thirds.
  straightenGrid: {
    position: 'absolute',
    inset: 0,
    margin: 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
    pointerEvents: 'none',
    backgroundImage:
      'repeating-linear-gradient(to right, rgb(255 255 255 / 22%) 0 1px, transparent 1px 10%), repeating-linear-gradient(to bottom, rgb(255 255 255 / 22%) 0 1px, transparent 1px 10%)',
  },
});

/**
 * The graded frame in the detail stage's slot.
 *
 * One canvas, and no `<img>`, `<video>`, blob URL or track behind it: the tick draws
 * straight into an extended-range WebGPU canvas (`docs/raw-edit-gpu.md` §7).
 *
 * The element is handed to the presenter rather than configured here, and from there to the
 * worker for good: the frame is on the module's device, and a canvas is the only thing that can
 * cross to it. So this mounts it and never touches it again - the backing stageStore included.
 *
 * Zoom and pan are the viewer's, from `zoom_pan.ts`, so the gesture is the same one in both
 * places. What differs is only what a view *means*: the viewer transforms an element, and a
 * canvas has nothing to transform - the tick draws whatever rectangle it is given, so the
 * view becomes a region and the frame is redrawn at it. Which is the better end of the deal,
 * since the redraw is at the stage's own resolution rather than a magnified raster.
 */
/** How far apart the two fingers of a pinch are. */
const MIDDLE_BUTTON = 1;

function spread(touches: Map<number, { x: number; y: number }>): number {
  const [first, second] = [...touches.values()];
  if (first == null || second == null) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export const RawEditStage = observer(function RawEditStage({
  stageStore,
  crop,
  keystone,
  repair,
  loupe,
  print,
  presenter,
  toolsInto,
  zoomInto,
  fullscreenRef,
}: {
  stageStore: StageStore;
  crop: CropStore;
  keystone: KeystoneStore;
  repair: RepairStore;
  loupe: LoupeStore;
  print: PrintStore;
  presenter: RawEditPresenter;
  /**
   * Where to draw the zoom control, which is the viewer's own and goes where the viewer's
   * goes. A portal for the reason the viewer uses one: the readout changes on every frame of
   * a wheel zoom, and handing it upwards would redraw the page around the stage at that rate.
   */
  toolsInto?: HTMLElement | null;
  /** Where the zoom slider goes, which is a bar's menu and so is null whenever that menu is shut. */
  zoomInto?: HTMLElement | null;
  /** The element to put fullscreen, handed up as it mounts. */
  fullscreenRef?: (element: HTMLDivElement | null) => void;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const touch = useIsTouch();
  const scenePrint = print.hanging;
  useEffect(() => {
    presenter.print.setTouch(touch);
  }, [presenter, touch]);
  // The wheel listens on the stage and the box is measured from the viewport, exactly as the
  // viewer does it: the stage is what a pointer is over, the viewport is what the frame is
  // fitted into.
  const stage = useRef<HTMLDivElement | null>(null);
  const captureStage = useCallback(
    (element: HTMLDivElement | null): void => {
      stage.current = element;
      fullscreenRef?.(element);
    },
    [fullscreenRef],
  );

  useEffect(() => {
    presenter.attach(canvas.current);
    return () => presenter.attach(null);
  }, [presenter]);

  const natural = stageStore.width === 0 ? NO_SIZE : presenter.displaySize;
  /**
   * Whether the view has to be *fitted*, which only the geometry tools need.
   *
   * Both lay something out on the picture where a fitted view puts it, so a zoomed frame under
   * a crop rectangle or a keystone guide would have it naming somewhere else.
   */
  const fitted = crop.cropping || keystone.keystoning || scenePrint;
  /**
   * Whether the stage's own zoom and pan take gestures.
   *
   * The loupe is here and not above: it needs the wheel for its magnification and the drag for
   * where the glass sits, so neither can also be the stage's - but it lays nothing out on the
   * picture, so **the reader's zoom is theirs to keep**. Magnifying part of an already-enlarged
   * frame is the ordinary way to use one.
   */
  const still = fitted || loupe.loupeOpen;
  // The repair tool draws its loop with the one pointer a pan would take - but not while a loop's
  // fills are on offer, when the overlay takes a press only on the fill or where it is read from.
  const zoom = useZoomPan(
    viewport,
    stage,
    natural,
    undefined,
    !still,
    !repair.repairing || repair.repairOptions != null,
  );
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

  // The gesture is state in React and the region is state in the stageStore, so one has to follow
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
  const tools = still ? null : (
    <ZoomControl zoom={zoom} variant={toolsInto == null ? 'ghost' : 'default'} stepper={toolsInto == null} />
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') void toggleFullscreenOf(stage.current);
      else if (still) return;
      // The keyboard's way to the scales the slider covers: it sits in a menu popup, where
      // nothing may take the focus the menu's own items need.
      else if (e.key === '+' || e.key === '=') zoom.zoomTo(zoom.stopAfter, null);
      else if (e.key === '-') reset();
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [still, zoom, reset]);

  // Where the viewport starts on the page, read when the pointer arrives and not while it
  // moves. `box` carries the size but no origin, and a pointer move is as hot as a path here
  // gets - `getBoundingClientRect` in one is the reason that rule exists. Nothing scrolls the
  // stage under a loupe, since zoom and pan are off while it is open.
  const origin = useRef({ left: 0, top: 0 });

  // A native listener rather than React's `onWheel`, which is passive: the page would scroll
  // under the reader while the magnification changed.
  useEffect(() => {
    const element = viewport.current;
    if (element == null || !loupe.loupeOpen) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      presenter.zoomLoupe(Math.sign(event.deltaY), box);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [presenter, loupe.loupeOpen, box]);

  useEffect(() => {
    const element = viewport.current;
    if (element == null || !scenePrint) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const span = Math.min(box.width, box.height);
      if (span === 0) return;
      presenter.print.zoomAt(-Math.sign(event.deltaY), {
        x: (event.clientX - origin.current.left - box.width / 2) / span,
        y: (event.clientY - origin.current.top - box.height / 2) / span,
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [presenter, scenePrint, box]);

  /** Where the middle button last was, which is what a pan is a run of differences from. */
  const panning = useRef<{ pointerId: number; x: number; y: number } | null>(null);

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

  const loupeHandlers = loupe.loupeOpen
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
              magnification: loupe.loupeMagnification,
            };
            drag.current = null;
            return;
          }
          // Nothing moves yet. Where this ends up depends on whether the finger travels.
          drag.current = { from: here, loupe: loupe.loupeAt ?? here };
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

  const printHandlers = scenePrint ? {
    onPointerEnter: measure,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>): void => {
      measure(event);
      // `live`, not `editable`: the mockup holds no document, and turning a print writes none.
      if (!event.isPrimary || !stageStore.live) return;
      if (event.button === MIDDLE_BUTTON) {
        event.currentTarget.setPointerCapture(event.pointerId);
        panning.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.preventDefault();
        return;
      }
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      presenter.print.beginDrag(event.pointerId, event.clientX, event.clientY, Math.min(box.width, box.height));
      event.preventDefault();
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>): void => {
      const pan = panning.current;
      if (pan != null && pan.pointerId === event.pointerId) {
        const span = Math.min(box.width, box.height);
        presenter.print.panBy((event.clientX - pan.x) / span, (event.clientY - pan.y) / span);
        panning.current = { ...pan, x: event.clientX, y: event.clientY };
        return;
      }
      presenter.print.moveDrag(event.pointerId, event.clientX, event.clientY);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>): void => {
      if (panning.current?.pointerId === event.pointerId) panning.current = null;
      presenter.print.endDrag(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>): void => {
      if (panning.current?.pointerId === event.pointerId) panning.current = null;
      presenter.print.endDrag(event.pointerId);
    },
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>): void => {
      if (panning.current?.pointerId === event.pointerId) panning.current = null;
      presenter.print.endDrag(event.pointerId);
    },
    // Middle-click pastes on X11 and scrolls on Windows; neither belongs over a print.
    onAuxClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button === MIDDLE_BUTTON) event.preventDefault();
    },
    onDoubleClick: (): void => presenter.print.resetView(),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!stageStore.live || event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? 15 : 5;
      switch (event.key) {
        case 'ArrowLeft': presenter.print.rotateBy(-step, 0); break;
        case 'ArrowRight': presenter.print.rotateBy(step, 0); break;
        case 'ArrowUp': presenter.print.rotateBy(0, -step); break;
        case 'ArrowDown': presenter.print.rotateBy(0, step); break;
        case 'Home': presenter.print.resetView(); break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
  } : {};

  return (
    <div ref={captureStage} {...stylex.props(stageStyles.stage, styles.stage)}>
      {toolsInto == null ? <div {...stylex.props(stageStyles.tools)}>{tools}</div> : createPortal(tools, toolsInto)}
      {zoomInto != null && !still && createPortal(<ZoomSlider zoom={zoom} />, zoomInto)}
      <div
        ref={viewport}
        {...stylex.props(stageStyles.viewport, loupe.loupeOpen && styles.loupe, scenePrint && focusRing.ring, stylex.defaultMarker())}
        role="region"
        aria-label={scenePrint ? PrintPanelStrings.rotatePrint() : PhotoStageStrings.stage()}
        tabIndex={scenePrint ? 0 : undefined}
        aria-busy={!stageStore.live && stageStore.status !== 'failed'}
        {...handlers}
        {...loupeHandlers}
        {...printHandlers}
      >
        <canvas
          ref={canvas}
          {...stylex.props(
            stageStyles.content,
            stageStyles.ready,
            zoomed && stageStyles.zoomed,
            loupe.loupeOpen && styles.loupe,
            scenePrint && styles.print,
            print.dragging && styles.draggingPrint,
          )}
          role="img"
          aria-label={RawEditStageStrings.picture()}
        />
        {/* Only while the slider is under a finger. A horizon is levelled against something
            straight, and the picture rarely offers one where it is needed - so the tool
            brings its own, and takes it away again rather than living over the photograph. */}
        {crop.straightening && (
          <div
            {...stylex.props(styles.straightenGrid)}
            style={{ aspectRatio: `${natural.width} / ${natural.height}` }}
          />
        )}
        <CropOverlay crop={crop} keystone={keystone} presenter={presenter} viewport={box} />
        <KeystoneOverlay store={keystone} presenter={presenter} viewport={box} />
        <RepairOverlay store={repair} presenter={presenter.repair} view={view} box={box} natural={natural} />
        <LoupeOverlay store={loupe} presenter={presenter} />
      </div>
      {/* Read by e2e: none of these has a visible readout, and the canvas is the worker's once
          handed over so cannot report its own backing size. */}
      <span
        hidden
        data-testid="raw-edit-diagnostics"
        data-adapter={stageStore.adapter}
        data-size={`${stageStore.width}x${stageStore.height}`}
        data-stage={stageStore.stage == null ? undefined : `${stageStore.stage.width}x${stageStore.stage.height}`}
        data-matched={stageStore.matched}
        data-rendered-mode={stageStore.renderedMode ?? undefined}
      />
      <OpenStatus stage={stageStore} />
    </div>
  );
});

export const OpenStatus = observer(function OpenStatus({ stage }: { stage: StageStore }): JSX.Element | null {
  if (stage.status === 'failed') {
    return (
      <div {...stylex.props(stageStyles.busy, stageStyles.failed)} role="alert">
        <Text>{RawEditStageStrings.couldNotShow()}</Text>
        <Text variant="mono" tone="error" style={styles.reason}>{stage.message}</Text>
      </div>
    );
  }
  // Until a frame lands, not until the open does: the first draw can wait seconds on a shader compile.
  if (stage.live && stage.renderedMode != null) return null;
  return (
    <div {...stylex.props(stageStyles.busy)} role="status">
      <Spinner />
      <Text variant="mono">{RawEditStageStrings.step(stage.step)}</Text>
    </div>
  );
});
