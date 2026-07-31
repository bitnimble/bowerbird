import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, ICON, Text } from '../../ui/ui';

const MIN_SCALE = 1; // 1 = fitted to the stage
const MAX_SCALE = 8;
const WHEEL_SENSITIVITY = 0.0015;

// How long the previous photo may stay on screen after stepping to the next one,
// while that one decodes. Long enough to cover a warmed frame's decode, short
// enough that a cold one reads as loading rather than as the wrong picture.
const STALE_FRAME_MS = 100;

// How many frames the frame being replaced is held under its replacement. An
// element hidden with opacity: 0 is never rasterised, so the incoming one has no
// raster at the moment it is revealed and the browser needs a frame or two to
// build one; dropping the outgoing one in the same commit left the stage
// background showing through for exactly that long, on every swap. Nothing in
// the page can observe a raster landing - `decode()` resolves well before it -
// so this is a count rather than a signal.
const RETIRED_FRAMES = 3;

// Kept in step with the enter/exit animations in styles.css: the frame being
// stepped away from has to outlive its own exit, and only this side knows when
// to unmount it.
const STEP_MS = 130;

// Which way the last step went, so the two frames slide the way the reader
// moved. Null for anything that is not a step - a rendition swap, or the first
// frame after opening a photo - which then just appears.
type Step = 'next' | 'prev' | null;

// How far a finger has to travel across the frame to count as a step rather
// than a tap, and how much straighter than it is tall: a swipe that is mostly
// vertical is the reader scrolling the page, not asking for the next photo.
const SWIPE_MIN_PX = 48;
const SWIPE_STRAIGHTNESS = 1.5;

interface Props {
  src: string;
  alt: string;
  filename: string;
  onImageLoad: (width: number, height: number) => void;
  // Render a <video> rather than an <img>: the HDR rendition Firefox needs.
  video?: boolean;
  // Frames to warm the cache with once this one is up: the neighbours either way,
  // minus any whose rendition is not knowable from here.
  preloadSrcs?: string[];
  // The rendition does not exist yet. Called once per src, before the retries
  // start, so the caller can build the thing the retries are waiting for.
  onImageMissing?: () => void;
  /** Clears the stage when it changes. The photo, not the src: a rendition swap must hold the frame. */
  photoKey: string;
  /** Position of this photo in the collection, which is what makes a step a direction. -1 when unknown. */
  index: number;
  /** Ask again for a frame that failed. Changes when the server has proven it is back. */
  retryEpoch?: number;
  /**
   * Keep preparing the frame but do not show it yet. For the moment before the
   * photo's own data arrives, when the panels around the stage have not settled:
   * a warmed neighbour decodes the instant it is asked for, so it would paint
   * and then jump as the layout resolved under it.
   */
  hold?: boolean;
  /** A touch dragged across the frame, which is how a phone steps between photos. Ignored while zoomed, where the same gesture pans. */
  onSwipe?: (step: 'next' | 'prev') => void;
}

// Scale and pan are one value, not two pieces of state. Zooming about a point
// has to read the current offset to compute the next one, and doing that by
// calling setOffset from inside a setScale updater made the maths run twice
// (React re-invokes updaters), landing the photo at roughly double the offset.
interface View {
  scale: number;
  x: number;
  y: number;
}

const FITTED: View = { scale: MIN_SCALE, x: 0, y: 0 };

// The direction rides on the frame rather than on the stage, so the one leaving
// and the one arriving keep animating the way the step that produced them went
// even if the next step comes in before they are done.
function contentClass(state: 'is-ready' | 'is-retiring', step: Step): string {
  return `${state} stage__content${step == null ? '' : ` is-stepping-${step}`}`;
}

// How much of the photo is off-screen on each axis at this scale, halved: past
// that the image would separate from the viewport edge and drag out of view.
function panLimit(viewport: number, content: number): number {
  return Math.max(0, (content - viewport) / 2);
}

// The photo is drawn with object-fit: contain, so its on-screen size is the
// viewport scaled down to fit, then scaled up by the zoom. `box` is passed in
// rather than measured here so the caller does the layout read, keeping this a
// pure function safe to run inside a state updater.
function clampPan(view: View, box: DOMRect | null, natural: { width: number; height: number }): View {
  if (box == null || natural.width === 0 || natural.height === 0) return view;
  const fit = Math.min(box.width / natural.width, box.height / natural.height);
  const maxX = panLimit(box.width, natural.width * fit * view.scale);
  const maxY = panLimit(box.height, natural.height * fit * view.scale);
  return {
    scale: view.scale,
    x: Math.max(-maxX, Math.min(maxX, view.x)),
    y: Math.max(-maxY, Math.min(maxY, view.y)),
  };
}

// Zooms so the content under (clientX, clientY) stays under it. transform-origin
// is the centre, so with d = pointer - centre the offset that pins the point is
// d - (next/current) * (d - offset); without it every zoom drifts to the middle.
function zoomAbout(view: View, next: number, box: DOMRect | null, point: { x: number; y: number } | null): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (scale === MIN_SCALE) return FITTED;
  if (box == null || point == null) return { ...view, scale };
  const dx = point.x - (box.left + box.width / 2);
  const dy = point.y - (box.top + box.height / 2);
  const ratio = scale / view.scale;
  return { scale, x: dx - ratio * (dx - view.x), y: dy - ratio * (dy - view.y) };
}

// The image viewport: fit/zoom, wheel zoom, drag-to-pan and fullscreen. All of
// this is ephemeral view state, so it stays local rather than going through a
// store; nothing outside this component needs to know the pan offset.
export function PhotoStage({
  src,
  alt,
  filename,
  video,
  photoKey,
  index,
  hold,
  retryEpoch,
  preloadSrcs,
  onImageLoad,
  onImageMissing,
  onSwipe,
}: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  // The src actually shown, which lags the one asked for until it has decoded,
  // with the photo it belongs to: for a moment after a step that is the previous
  // one, and everything driven by "this photo is up" has to tell the two apart.
  //
  // Swapping one element's src means a frame with nothing decoded to show and
  // the stage background coming through - a flash on every rendition change,
  // including between two that were already cached, where there is no wait to
  // justify it. So the next src is mounted as a second, invisible <img> over the
  // current one and only becomes the visible one once it has decoded; the
  // element is then kept rather than replaced, so what it decoded is what gets
  // painted. Decoding off-screen in a detached `new Image()` is not enough: the
  // browser decodes for the size an element is drawn at, so the visible element
  // decoded a 3840px AVIF a second time at paint and flashed anyway.
  const [painted, setPainted] = useState<{ src: string; photoKey: string; step: Step } | null>(null);
  const currentFrame = painted?.photoKey === photoKey ? painted.src : null;
  const ready = currentFrame != null;
  // The frame `painted` just replaced, kept mounted and opaque underneath it for
  // RETIRED_FRAMES. Its raster is the one the browser already has, so it is what
  // shows through while the replacement's is being built.
  const [retiring, setRetiring] = useState<{ src: string; step: Step } | null>(null);
  // The photo last promoted, which is what the next promotion is a step away
  // from. Not `painted`: that is dropped once it goes stale, and a photo whose
  // rendition had to be built is still a step from the one before it.
  const stepped = useRef<{ photoKey: string; index: number } | null>(null);
  // Read by the promote below, which runs off a decode promise: `painted` there
  // would be whatever was on screen when that decode started.
  const paintedSrc = useRef<string | null>(null);
  paintedSrc.current = painted?.src ?? null;
  // Drives the stage's aspect-ratio, so the bordered box is the photo rather
  // than a letterboxed container with black margins inside it.
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  // How far the pointer travelled in the gesture that just ended, which is what
  // separates the click that closes a tap from the one that closes a drag.
  const travelled = useRef(0);

  const zoomed = view.scale > MIN_SCALE;

  const reset = useCallback(() => setView(FITTED), []);

  // A new photo starts fitted; carrying a pan offset across frames would show
  // the next one scrolled to a corner. Keyed on the photo rather than the src, so
  // that switching rendition holds the frame it is already showing.
  useEffect(reset, [photoKey, reset]);

  // The previous photo's frame is left up for a beat rather than cleared on the
  // step: both neighbours are warmed, so the next one usually decodes within a
  // frame or two, and dropping the old one first turns every step into a blink of
  // stage background. Capped, because the picture and the panels beside it
  // disagree until it goes, and a photo whose rendition has to be built keeps
  // them disagreeing for as long as the build takes.
  //
  // Timed from when the frame went stale rather than from the last step, which
  // is what the lone `stale` dependency buys: stepping faster than the cap
  // leaves it running instead of restarting it, so holding the arrow key cannot
  // pin a frame from ten photos ago to the stage.
  const stale = painted != null && painted.photoKey !== photoKey;
  useEffect(() => {
    if (!stale) return;
    const timer = setTimeout(() => {
      setPainted(null);
      // Or the frame it was covering, which is older still, would be left as the
      // only thing on the stage - the wrong picture, which is what the cap above
      // exists to prevent.
      setRetiring(null);
    }, STALE_FRAME_MS);
    return () => clearTimeout(timer);
  }, [stale]);

  useEffect(() => {
    if (retiring == null) return;
    // A stepped-away frame is animating out, so it is timed rather than counted:
    // unmounted after a few frames it would vanish part-way through its exit.
    if (retiring.step != null) {
      const timer = setTimeout(() => setRetiring(null), STEP_MS);
      return () => clearTimeout(timer);
    }
    let left = RETIRED_FRAMES;
    let frame = requestAnimationFrame(function tick(): void {
      if (left-- > 0) frame = requestAnimationFrame(tick);
      else setRetiring(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [retiring]);

  // Clearing this remounts the frame's element, which is what makes it ask again:
  // a src that never moves is otherwise requested exactly once.
  useEffect(() => setFailed(false), [src, retryEpoch]);

  // Through refs: callers pass inline callbacks, and a new identity per render
  // would restart the decode below on every render while one is in flight.
  const onMissing = useRef(onImageMissing);
  onMissing.current = onImageMissing;
  const onLoaded = useRef(onImageLoad);
  onLoaded.current = onImageLoad;
  // Through a ref so a photo leaving the collection, which shuffles every index
  // after it, cannot restart a decode that is in flight.
  const currentIndex = useRef(index);
  currentIndex.current = index;

  // The src being prepared, mounted but invisible until it can be shown.
  const incoming = src === currentFrame ? null : src;
  // Switching back before the hold expires asks for the frame on its way out,
  // and one src is one element: the hold is dropped rather than duplicated, which
  // costs nothing here - the frame it was covering is still the one on screen.
  const retired = retiring?.src === incoming ? null : retiring;
  // A callback ref, not a RefObject: refs are invariant, so one object cannot be
  // handed to both an <img> and a <video>.
  const incomingRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const captureIncoming = useCallback((element: HTMLImageElement | HTMLVideoElement | null) => {
    incomingRef.current = element;
  }, []);

  // Promotion, for both media: an image when it has decoded, a video when it has
  // a frame to show (`loadeddata`; `decode()` is an image method, and
  // `loadedmetadata` knows the size and nothing else). `hold` is a dependency, so
  // a frame prepared while the layout was still settling goes up the moment it is.
  useEffect(() => {
    const element = incomingRef.current;
    if (hold === true || incoming == null || element == null) return;
    let live = true;

    const promote = (): void => {
      if (!live) return;
      const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
      const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
      setNatural({ width, height });
      onLoaded.current(width, height);
      const from = stepped.current;
      const to = currentIndex.current;
      const step: Step = from == null || from.photoKey === photoKey || from.index < 0 || to < 0 ? null : from.index < to ? 'next' : 'prev';
      stepped.current = { photoKey, index: to };
      if (paintedSrc.current != null && paintedSrc.current !== incoming) setRetiring({ src: paintedSrc.current, step });
      setPainted({ src: incoming, photoKey, step });
    };

    if (element instanceof HTMLVideoElement) {
      if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) promote();
      else element.addEventListener('loadeddata', promote);
      return () => {
        live = false;
        element.removeEventListener('loadeddata', promote);
      };
    }

    element.decode().then(promote, () => {
      if (!live) return;
      setFailed(true);
      // Never for a blob: a decoded image in hand cannot be missing server-side.
      if (!src.startsWith('blob:')) onMissing.current?.();
    });
    return () => {
      live = false;
    };
    // `failed` is a dependency because it decides whether the incoming element is
    // mounted at all, and this reads it through a ref. A frame that failed
    // unmounts, so when its rebuilt version arrives the effect runs against a
    // null element and returns; clearing `failed` then remounts it without
    // changing any of the other dependencies, and nothing would ask it to decode.
    // The bytes arrive and the stage sits on them for the life of the page.
  }, [incoming, src, hold, photoKey, failed]);

  // Measures here, outside the updater, so the updater itself stays pure.
  const zoomBy = useCallback(
    (nextScale: (current: number) => number, point: { x: number; y: number } | null) => {
      const box = viewportRef.current?.getBoundingClientRect() ?? null;
      setView((current) => clampPan(zoomAbout(current, nextScale(current.scale), box, point), box, natural));
    },
    [natural],
  );

  useEffect(() => {
    function onChange(): void {
      const active = document.fullscreenElement != null;
      setFullscreen(active);
      if (!active) setToolbarVisible(false);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement != null) {
      await document.exitFullscreen();
      return;
    }
    await stageRef.current?.requestFullscreen();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'f') {
        void toggleFullscreen();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Non-passive so preventDefault actually stops the page scrolling underneath.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;

    function onWheel(e: WheelEvent): void {
      e.preventDefault();
      zoomBy((current) => current * (1 - e.deltaY * WHEEL_SENSITIVITY), { x: e.clientX, y: e.clientY });
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  function onPointerDown(e: React.PointerEvent): void {
    // One gesture at a time: a second finger landing would otherwise restart the
    // one in flight from wherever it touched down, and lift into a step of its own.
    if (!e.isPrimary) return;
    // Before the zoom check: unzoomed, where nothing pans, this is still where a
    // swipe starts and what tells the tap that ends a swipe from a real tap.
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.x, offsetY: view.y };
    travelled.current = 0;
    // Capture keeps the gesture alive if the pointer leaves the stage, but it
    // throws for a pointer id the browser doesn't consider active. Neither pan
    // nor swipe may depend on it, so a failure here is ignored.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pan still works from the move handler, and the swipe from pointerup */
    }
    if (zoomed) setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent): void {
    if (!dragging) return;
    const box = viewportRef.current?.getBoundingClientRect() ?? null;
    setView((current) =>
      clampPan(
        {
          scale: current.scale,
          x: dragStart.current.offsetX + (e.clientX - dragStart.current.x),
          y: dragStart.current.offsetY + (e.clientY - dragStart.current.y),
        },
        box,
        natural,
      ),
    );
  }

  // Not a gesture the reader completed: the browser took the pointer, so end the
  // drag without reading a step out of where it stopped.
  function onPointerCancel(e: React.PointerEvent): void {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
    setDragging(false);
  }

  function onPointerUp(e: React.PointerEvent): void {
    onPointerCancel(e);
    if (!e.isPrimary) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    travelled.current = Math.abs(dx) + Math.abs(dy);
    // Unzoomed there is nothing to pan, so a drag across the frame is a step.
    // Any pointer: a mouse dragged that far across a photo means the same thing
    // a finger does, and nothing else on an unzoomed stage answers to a drag.
    if (!zoomed && Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_STRAIGHTNESS) {
      onSwipe?.(dx < 0 ? 'next' : 'prev');
    }
  }

  // A drag ends in a click event too, so only treat it as a zoom toggle when the
  // gesture it ends barely moved - a swipe that lands on the next photo must not
  // zoom it, and a pan must not un-zoom.
  function onClick(e: React.MouseEvent): void {
    if (dragging || travelled.current > 4) return;
    if (zoomed) reset();
    else zoomBy(() => 2, { x: e.clientX, y: e.clientY });
  }

  return (
    <div
      ref={stageRef}
      className={`stage${fullscreen ? ' stage--fullscreen' : ''}${zoomed ? ' stage--zoomed' : ''}`}
      onMouseMove={() => fullscreen && setToolbarVisible(true)}
      onMouseLeave={() => setToolbarVisible(false)}
    >
      {!fullscreen && (
        <div className="stage__tools">
          {zoomed && <Text variant="mono" className="stage__scale">{`${Math.round(view.scale * 100)}%`}</Text>}
          <Button
            variant="ghost"
            iconOnly
            aria-pressed={zoomed}
            aria-label={zoomed ? 'Zoom out to fit' : 'Zoom in'}
            title={zoomed ? 'Fit' : 'Zoom'}
            onClick={() => (zoomed ? reset() : zoomBy(() => 2, null))}
          >
            {zoomed ? <ZoomOut size={ICON} /> : <ZoomIn size={ICON} />}
          </Button>
          <Button variant="ghost" iconOnly aria-label="Fullscreen" title="Fullscreen (F)" onClick={() => void toggleFullscreen()}>
            <Maximize size={ICON} />
          </Button>
        </div>
      )}

      <div
        ref={viewportRef}
        className="stage__viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
      >
        {/* A frame that failed replaces the incoming one, not the picture already
            on screen: switching to a rendition that 404s should leave the one
            being compared against up, not blank the stage. Nothing to hold means
            there is nothing to say but this.
            A frame belonging to the *previous* photo is not a candidate - the cap
            above has already dropped it by the time any of this can matter. */}
        {failed && painted == null ? (
          <span className="tile__pending">no rendition yet</span>
        ) : (
          // One list, keyed by src, so promoting the incoming one keeps its
          // element: rendered as two slots React would unmount it and the
          // browser would decode the same file over again to paint it.
          //
          // Bottom to top: the frame on its way out, the one on screen, the one
          // being prepared. Nothing here is a move on promotion - the incoming
          // one keeps the slot it already had and the retiring one takes the slot
          // below it, so no element is reinserted into the DOM mid-swap.
          [
            retired == null ? null : { src: retired.src, className: contentClass('is-retiring', retired.step) },
            painted == null ? null : { src: painted.src, className: contentClass('is-ready', painted.step) },
            failed || incoming == null ? null : { src: incoming, className: 'stage__content' },
          ].map((frame) => {
            if (frame == null) return false;
            const { src: source, className } = frame;
            const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
            // A one-frame video, the only way an HDR photo reaches a Firefox
            // display (§10.7). Muted and inline so autoplay is allowed at all,
            // and it carries the same transform as the <img> so zoom and pan are
            // unchanged.
            if (video) {
              return (
                <video
                  key={source}
                  ref={source === incoming ? captureIncoming : null}
                  src={source}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className={className}
                  style={{ transform }}
                  onError={() => {
                    if (source !== incoming) return;
                    setFailed(true);
                    onMissing.current?.();
                  }}
                />
              );
            }
            return (
              <img
                key={source}
                ref={source === incoming ? captureIncoming : null}
                src={source}
                alt={alt}
                draggable={false}
                className={className}
                style={{ transform }}
              />
            );
          })
        )}

        {/* The neighbouring photos, warmed only once this one is up: started any
            earlier they compete for the connection with the one being waited on.
            Mounted rather than fetched into a detached Image for the same reason
            the swap above is - a decode is for the size an element is drawn at,
            and these elements are the size those photos will be. */}
        {ready && preloadSrcs?.map((source) => <img key={source} src={source} alt="" aria-hidden className="stage__content" />)}
      </div>

      {/* Fullscreen shows nothing but the photo; the bar surfaces on hover so the
          filename and the way out are always reachable without cluttering it. */}
      {fullscreen && (
        <div className={`stage__bar${toolbarVisible ? ' is-visible' : ''}`}>
          <Text variant="mono">{filename}</Text>
          <Button onClick={() => void toggleFullscreen()}>
            <Minimize size={ICON} />
            Exit fullscreen
          </Button>
        </div>
      )}
    </div>
  );
}
