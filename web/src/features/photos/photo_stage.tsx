import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, ICON, Text } from '../../ui/ui';

const MIN_SCALE = 1; // 1 = fitted to the stage
const MAX_SCALE = 8;
const WHEEL_SENSITIVITY = 0.0015;

// Full-size renders are built by the background queue, so opening a photo just
// after a sync can 404. The grid recovers on its next list refetch; the detail
// view has no such loop, so it retries on its own before giving up.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

interface Props {
  src: string;
  alt: string;
  filename: string;
  onImageLoad: (width: number, height: number) => void;
  // Render a <video> rather than an <img>: the HDR rendition Firefox needs.
  video?: boolean;
  // The frame to warm the cache with once this one is up. Undefined when there is
  // no next photo, or when what it will open at is not knowable from here.
  preloadSrc?: string;
  // The preview does not exist yet. Called once per src, before the retries
  // start, so the caller can build the thing the retries are waiting for.
  onImageMissing?: () => void;
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
export function PhotoStage({ src, alt, filename, video, preloadSrc, onImageLoad, onImageMissing }: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Held back until this src has decoded. Without it the previous photo stays on
  // screen for a beat after navigating, which reads as a flash of the wrong frame.
  const [ready, setReady] = useState(false);
  // Drives the stage's aspect-ratio, so the bordered box is the photo rather
  // than a letterboxed container with black margins inside it.
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });

  const zoomed = view.scale > MIN_SCALE;

  const reset = useCallback(() => setView(FITTED), []);

  // A new photo starts fitted; carrying a pan offset across frames would show
  // the next one scrolled to a corner.
  useEffect(() => {
    reset();
    setFailed(false);
    setReady(false);
    setAttempt(0);
  }, [src, reset]);

  useEffect(() => {
    // A blob URL is decoded from bytes already in hand; it will not start
    // working later.
    if (!failed || src.startsWith('blob:')) return;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay == null) return;
    const timer = setTimeout(() => {
      setFailed(false);
      setAttempt((a) => a + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [failed, attempt, src]);

  // Only once this photo has decoded: started any earlier the two frames compete
  // for the connection, and the one being waited on is this one. Decoded as well
  // as fetched: a 2566x3840 AVIF thumbnail costs ~50ms to decode on a fast
  // desktop, which is paid at paint time otherwise.
  useEffect(() => {
    if (!ready || preloadSrc == null) return;
    const next = new Image();
    next.src = preloadSrc;
    void next.decode().catch(() => {});
  }, [ready, preloadSrc]);

  // The browser caches the 404, so a retry needs a URL it has not seen.
  const shownSrc = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`;

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
    if (!zoomed) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.x, offsetY: view.y };
    // Capture keeps the drag alive if the pointer leaves the stage, but it throws
    // for a pointer id the browser doesn't consider active. Panning must not
    // depend on it, so a failure here is ignored rather than aborting the drag.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pan still works from the move handler */
    }
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

  function onPointerUp(e: React.PointerEvent): void {
    if (!dragging) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
  }

  // A drag ends in a click event too, so only treat it as a zoom toggle when the
  // pointer barely moved.
  function onClick(e: React.MouseEvent): void {
    const moved = Math.abs(e.clientX - dragStart.current.x) + Math.abs(e.clientY - dragStart.current.y);
    if (dragging || (zoomed && moved > 4)) return;
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
        onPointerCancel={onPointerUp}
        onClick={onClick}
      >
        {failed ? (
          <span className="tile__pending">no thumbnail yet</span>
        ) : video ? (
          // A one-frame video, the only way an HDR photo reaches a Firefox
          // display (§10.7). Muted and inline so autoplay is allowed at all, and
          // it carries the same transform as the <img> so zoom and pan are
          // unchanged.
          <video
            src={shownSrc}
            autoPlay
            loop
            muted
            playsInline
            className={ready ? 'is-ready stage__content' : 'stage__content'}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onError={() => {
              setFailed(true);
              if (attempt === 0) onImageMissing?.();
            }}
            onLoadedMetadata={(e) => {
              setNatural({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight });
              setReady(true);
              onImageLoad(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
            }}
          />
        ) : (
          <img
            src={shownSrc}
            alt={alt}
            draggable={false}
            className={ready ? 'is-ready stage__content' : 'stage__content'}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onError={() => {
              setFailed(true);
              // Only the first failure, and never for a blob: a decoded image in
              // hand cannot be missing server-side.
              if (attempt === 0 && !src.startsWith('blob:')) onImageMissing?.();
            }}
            onLoad={(e) => {
              setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
              setReady(true);
              onImageLoad(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
            }}
          />
        )}
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
