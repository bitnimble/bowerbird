import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize, Minimize } from 'lucide-react';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { NO_SIZE, type Size, useZoomPan } from './zoom_pan';
import { ZoomControl } from './zoom_control';

// Fit, zoom and pan live in `zoom_pan.ts`, because the editor's canvas needs the same
// gesture and cannot be transformed the way an `<img>` can.

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
//
// The same fact is why a mounted-but-hidden member of a `sources` pair gets its
// own compositor layer (`.stage__content--layer`): it is revealed by an opacity
// change with no repaint, so it has to keep the raster it would otherwise throw
// away. Without that, stack triage's flip stalls on every press.
const RETIRED_FRAMES = 3;

// Kept in step with the enter/exit animations in styles.css: the frame being
// stepped away from has to outlive its own exit, and only this side knows when
// to unmount it.
const STEP_MS = 130;

// Which way the last step went, so the two frames slide the way the reader
// moved. Null for anything that is not a step - a rendition swap, a flip between
// a round's two frames, or the first frame after opening a photo - which then
// just appears.
type Step = 'next' | 'prev' | null;

// How far a finger has to travel across the frame to count as a step rather
// than a tap, and how much straighter than it is tall: a swipe that is mostly
// vertical is the reader scrolling the page, not asking for the next photo.
const SWIPE_MIN_PX = 48;
const SWIPE_STRAIGHTNESS = 1.5;

interface Props {
  /**
   * The frames this photo can show, in slot order. Usually one.
   *
   * Two is stack triage's flip mode (DESIGN §20.4): both are mounted and decoded
   * under a single `photoKey`, so alternating between them keeps the zoom and pan
   * the photographer set up, and costs no decode.
   */
  sources: string[];
  /** Which of `sources` is on screen. */
  showing?: number;
  alt: string;
  filename: string;
  /** The decoded size of a frame, reported once per source. */
  onImageLoad: (source: string, width: number, height: number) => void;
  // Render a <video> rather than an <img>: the HDR rendition Firefox needs.
  video?: boolean;
  // Frames to warm the cache with once this one is up: the neighbours either way,
  // minus any whose rendition is not knowable from here.
  preloadSrcs?: string[];
  // A source does not exist yet. Called once per source, before the retries
  // start, so the caller can build the thing the retries are waiting for.
  onImageMissing?: (source: string) => void;
  /** Clears the stage when it changes. The photo, not the source: a rendition swap must hold the frame. */
  photoKey: string;
  /** Which way the reader arrived at this photo. Null for anything that is not a step. */
  step?: Step;
  /** A touch dragged across the frame, which is how a phone steps between photos. Ignored while zoomed, where the same gesture pans. */
  onSwipe?: (step: 'next' | 'prev') => void;
  /** Ask again for a frame that failed. Changes when the server has proven it is back. */
  retryEpoch?: number;
  /**
   * Keep preparing the frame but do not show it yet. For the moment before the
   * photo's own data arrives, when the panels around the stage have not settled:
   * a warmed neighbour decodes the instant it is asked for, so it would paint
   * and then jump as the layout resolved under it.
   */
  hold?: boolean;
  /**
   * Bind this stage's window-level keys. Off for the second of two mounted
   * stages, which would otherwise both act on one `f`.
   */
  keyboard?: boolean;
  /**
   * Draw the zoom and fullscreen controls into this element rather than over the
   * frame. A portal rather than a callback: the scale readout changes on every
   * frame of a wheel zoom, and handing it upwards would redraw the page around
   * the stage at that rate.
   */
  toolsInto?: HTMLElement | null;
  /** A rendition for this photo is being built: covered until it is on screen. */
  busy?: boolean;
}

// The direction rides on the frame rather than on the stage, so the one leaving
// and the one arriving keep animating the way the step that produced them went
// even if the next step comes in before they are done.
function contentClass(state: 'is-ready' | 'is-retiring' | 'is-layer' | null, step: Step): string {
  const base = state === 'is-layer' ? 'stage__content stage__content--layer' : `${state == null ? '' : `${state} `}stage__content`;
  return step == null ? base : `${base} is-stepping-${step}`;
}

function noop(): void {
  /* a frame on its way off the stage reports to nobody */
}

// One mounted frame, owning its own decode.
//
// A component per source rather than one effect over a list, because a decode is
// per element and hooks cannot be: this is what lets the stage hold two frames of
// one round, each arriving when it arrives. Keyed by source by the caller, so
// promotion keeps the element and what it decoded is what gets painted.
function StageFrame({
  source,
  photoKey,
  hold,
  video,
  alt,
  className,
  transform,
  onDecoded,
  onMissing,
}: {
  source: string;
  /** Reported against, so a frame carried into a new round reports again. */
  photoKey: string;
  hold: boolean;
  video: boolean;
  alt: string;
  className: string;
  transform: string;
  onDecoded: (source: string, width: number, height: number) => void;
  onMissing: (source: string) => void;
}): JSX.Element {
  const elementRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  // Through refs: callers pass inline callbacks, and a new identity per render
  // would restart the decode below while one is in flight.
  const decoded = useRef(onDecoded);
  decoded.current = onDecoded;
  const missing = useRef(onMissing);
  missing.current = onMissing;

  useEffect(() => {
    const element = elementRef.current;
    if (element == null || hold) return;
    let live = true;

    const report = (): void => {
      if (!live) return;
      const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
      const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
      decoded.current(source, width, height);
    };

    // An image when it has decoded, a video when it has a frame to show
    // (`loadeddata`; `decode()` is an image method, and `loadedmetadata` knows
    // the size and nothing else).
    if (element instanceof HTMLVideoElement) {
      if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) report();
      else element.addEventListener('loadeddata', report);
      return () => {
        live = false;
        element.removeEventListener('loadeddata', report);
      };
    }

    void element.decode().then(report, () => {
      if (!live) return;
      missing.current(source);
    });
    return () => {
      live = false;
    };
    // `photoKey` and `hold`, not just `source`: an element is kept while its URL
    // holds, so a frame carried into the next round - which every decisive verdict
    // does, the winner keeping its slot - would otherwise never report again, and
    // the round would show one photo whichever slot was asked for. `decode()` on an
    // image already decoded resolves on the next microtask, so re-running costs a
    // promise and no network.
  }, [source, photoKey, hold]);

  const capture = useCallback((element: HTMLImageElement | HTMLVideoElement | null): void => {
    elementRef.current = element;
  }, []);

  if (video) {
    return (
      <video
        ref={capture}
        src={source}
        autoPlay
        loop
        muted
        playsInline
        className={className}
        style={{ transform }}
        onError={() => missing.current(source)}
      />
    );
  }
  return <img ref={capture} src={source} alt={alt} draggable={false} className={className} style={{ transform }} />;
}

// The image viewport: fit/zoom, wheel zoom, drag-to-pan and fullscreen. All of
// this is ephemeral view state, so it stays local rather than going through a
// store; nothing outside this component needs to know the pan offset.
export function PhotoStage({
  sources,
  showing = 0,
  alt,
  filename,
  video = false,
  photoKey,
  step: arrivedBy = null,
  onSwipe,
  hold,
  retryEpoch,
  preloadSrcs,
  keyboard = true,
  onImageLoad,
  onImageMissing,
  toolsInto,
  busy = false,
}: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  // The sources actually on screen, with the photo they belong to: for a moment
  // after a step that is the previous photo's, and everything driven by "this
  // photo is up" has to tell the two apart.
  //
  // Swapping one element's src means a frame with nothing decoded to show and
  // the stage background coming through - a flash on every rendition change,
  // including between two that were already cached, where there is no wait to
  // justify it. So a source is mounted invisibly and only becomes a painted one
  // once it has decoded; the element is then kept rather than replaced, so what
  // it decoded is what gets painted. Decoding off-screen in a detached
  // `new Image()` is not enough: the browser decodes for the size an element is
  // drawn at, so the visible element decoded a 3840px AVIF a second time at paint
  // and flashed anyway.
  const [painted, setPainted] = useState<{ sources: readonly string[]; photoKey: string; step: Step } | null>(null);
  // The decoded size of each painted source. Per source, because a `sources` pair
  // holds two frames that may differ in shape, and `clampPan` is computed from
  // whichever of them is on screen.
  const [naturals, setNaturals] = useState<ReadonlyMap<string, Size>>(new Map());
  // The frames `painted` just replaced, kept mounted and opaque underneath for
  // RETIRED_FRAMES. Their rasters are the ones the browser already has, so they
  // are what shows through while the replacements' are being built.
  const [retiring, setRetiring] = useState<{ sources: readonly string[]; step: Step }>({ sources: [], step: null });
  // The photo last promoted, which is what tells a step from a rendition swap or
  // a flip between a round's two frames. Not `painted`: that is dropped once it
  // goes stale, and a photo whose rendition had to be built is still a step from
  // the one before it.
  const stepped = useRef<string | null>(null);

  // Everything with a raster, whichever photo it belongs to. The previous
  // photo's frames stay in here until the stale cap drops them, which is what
  // keeps a step from blinking the stage background.
  const paintedSources = painted?.sources ?? [];
  const isThisPhoto = painted?.photoKey === photoKey;
  // What is up: this photo's frames in slot order, then any it has painted that
  // are no longer asked for, then - for the beat after a step - the previous
  // photo's. The middle group is a rendition being swapped: the frame on screen
  // stays on screen until its replacement decodes, which is the whole point of
  // holding a decoded frame. Dropping it there blanked the stage for the length of
  // the decode, and for the length of the *build* when the new rendition had to be
  // made first.
  const up = isThisPhoto
    ? [...sources.filter((source) => paintedSources.includes(source)), ...paintedSources.filter((source) => !sources.includes(source))]
    : paintedSources;
  // The chosen slot once it has decoded, else whatever else is up: a pair whose
  // second frame is still decoding shows the first rather than nothing.
  const chosen = isThisPhoto ? sources[showing] : undefined;
  const visible = chosen != null && up.includes(chosen) ? chosen : up[0];
  const ready = visible != null && isThisPhoto;
  const natural = (visible == null ? undefined : naturals.get(visible)) ?? NO_SIZE;

  // Unzoomed there is nothing to pan, so a drag across the frame is a step. Any pointer: a
  // mouse dragged that far across a photo means the same thing a finger does, and nothing
  // else on an unzoomed stage answers to a drag.
  const onGestureEnd = useCallback(
    ({ dx, dy, zoomed: wasZoomed }: { dx: number; dy: number; zoomed: boolean }) => {
      if (wasZoomed) return;
      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_STRAIGHTNESS) {
        onSwipe?.(dx < 0 ? 'next' : 'prev');
      }
    },
    [onSwipe],
  );
  const zoom = useZoomPan(viewportRef, stageRef, natural, onGestureEnd);
  const { view, reset, zoomed, handlers } = zoom;

  // A new photo starts fitted; carrying a pan offset across frames would show
  // the next one scrolled to a corner. Keyed on the photo rather than the source,
  // so switching rendition - or flipping between a round's two frames - holds the
  // view it is already at.
  useEffect(reset, [photoKey, reset]);

  // The previous photo's frames are left up for a beat rather than cleared on the
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
  // The frames being held, or null when what is painted belongs to this photo.
  // The value rather than a boolean, because the timer has to be able to say
  // *which* frames it was scheduled against.
  const held = painted != null && painted.photoKey !== photoKey ? painted : null;
  useEffect(() => {
    if (held == null) return;
    const timer = setTimeout(() => {
      // Only if the held frames are still the ones on screen. A promotion that
      // commits after this timer was scheduled but before it fires would
      // otherwise have its frame wiped - and nothing asks again, because the
      // element is still mounted under the same key and its decode has already
      // resolved, so the stage stays blank for good. It needs a decode landing
      // within a few milliseconds of the cap, which is a warmed frame on a busy
      // machine: rare on an idle one, common while raws are being processed.
      setPainted((previous) => (previous === held ? null : previous));
      // Or the frames it was covering, which are older still, would be left as
      // the only thing on the stage - the wrong picture, which is what the cap
      // above exists to prevent.
      setRetiring((previous) => (previous.sources.length === 0 ? previous : { sources: [], step: null }));
    }, STALE_FRAME_MS);
    return () => clearTimeout(timer);
  }, [held]);

  useEffect(() => {
    if (retiring.sources.length === 0) return;
    const done = (): void => setRetiring({ sources: [], step: null });
    // A stepped-away frame is animating out, so it is timed rather than counted:
    // unmounted after a few frames it would vanish part-way through its exit.
    if (retiring.step != null) {
      const timer = setTimeout(done, STEP_MS);
      return () => clearTimeout(timer);
    }
    let left = RETIRED_FRAMES;
    let frame = requestAnimationFrame(function tick(): void {
      if (left-- > 0) frame = requestAnimationFrame(tick);
      else done();
    });
    return () => cancelAnimationFrame(frame);
  }, [retiring]);

  const key = sources.join(' ');
  // Clearing this remounts the frames' elements, which is what makes them ask
  // again: a source that never moves is otherwise requested exactly once.
  useEffect(() => setFailed((previous) => (previous.size === 0 ? previous : new Set())), [key, retryEpoch]);

  // Sizes belong to the photo that decoded them, and nothing reads them once it
  // is gone. Left to accumulate, a viewer session that steps through a few hundred
  // photographs keeps every one of their sizes for the life of the page.
  useEffect(() => setNaturals((previous) => (previous.size === 0 ? previous : new Map())), [photoKey]);

  const onLoaded = useRef(onImageLoad);
  onLoaded.current = onImageLoad;
  const onMissing = useRef(onImageMissing);
  onMissing.current = onImageMissing;

  const wanted = sources.filter((source) => !failed.has(source));
  // Mounted for this photo but not yet painted. A frame painted for the photo
  // before this one does not count as up, however identical the URL: it is on its
  // way out, and this photo still has to decode its own.
  const incoming = wanted.filter((source) => !(isThisPhoto && paintedSources.includes(source)));

  // Read inside the promote below, which runs off a decode: the values captured in
  // that closure would be whatever was asked for when the decode started.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const arrival = useRef(arrivedBy);
  arrival.current = arrivedBy;
  const paintedRef = useRef(painted);
  paintedRef.current = painted;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // One rule for every promotion: a frame keeps its place if it is still being
  // asked for, and retires if it is not - whichever photo painted it. A photo step
  // retires everything, because none of those URLs is asked for any more; a
  // decisive verdict holding its winner over keeps that frame, and so does a
  // rendition swap, because both are still asked for and both already have a
  // raster.
  //
  // Read through refs and applied outside the updater: `setPainted`'s updater must
  // stay pure, and StrictMode double-invokes it.
  const promote = useCallback(
    (source: string, width: number, height: number) => {
      // A frame on its way off the stage reports too - every mounted frame
      // re-decodes when the photo changes, which is what carries a held-over
      // winner into the next round. Promoting one nobody is asking for would
      // re-paint the *previous* photo's frame under this photo's key, where the
      // stale cap can no longer see it, and it would sit on the stage for good.
      if (!sourcesRef.current.includes(source)) return;
      setNaturals((previous) => {
        const next = new Map(previous);
        next.set(source, { width, height });
        return next;
      });
      onLoaded.current(source, width, height);
      // Only a photo that replaced another one slides: the frames of one round are
      // the same photograph, so flipping between them - or swapping a rendition -
      // holds its place.
      const step: Step = stepped.current == null || stepped.current === photoKey ? null : arrival.current;
      stepped.current = photoKey;

      const asked = sourcesRef.current;
      // Held opaque under this one for a few frames: what nobody is asking for any
      // more, and - asked for or not - whatever this frame is about to be revealed
      // over. A frame that has just decoded has no raster yet, so dropping the
      // picture beneath it in the same commit shows the stage background for
      // exactly as long as building one takes. Which of these is actually on
      // screen is settled at render, so one that stays visible is simply not
      // covered.
      //
      // All of it a visual courtesy, which is why it may read the refs; what is
      // painted must not. Two frames of a round decode in the same batch whenever
      // both are warm, and a ref only refreshes on render - so both promotions
      // would read the same stale set and the second would overwrite the first,
      // leaving one slot of the round unreachable for as long as it lasts.
      const outgoing = visibleRef.current;
      const dropped = (paintedRef.current?.sources ?? []).filter((frame) => !asked.includes(frame));
      const covered = outgoing == null || dropped.includes(outgoing) ? dropped : [...dropped, outgoing];
      if (covered.length > 0) setRetiring({ sources: covered, step });

      setPainted((previous) => {
        const kept = (previous?.sources ?? []).filter((frame) => asked.includes(frame));
        return { sources: kept.includes(source) ? kept : [...kept, source], photoKey, step };
      });
    },
    [photoKey],
  );

  const reportMissing = useCallback((source: string) => {
    setFailed((previous) => {
      const next = new Set(previous);
      next.add(source);
      return next;
    });
    // A blob is a decoded image already in hand, so a failure is not the server
    // missing a file and there is nothing to build. The frame is still marked
    // failed, or the stage would keep waiting on it and never say so.
    if (source.startsWith('blob:')) return;
    onMissing.current?.(source);
  }, []);

  // This stage's own fullscreen, not the document's. Two stages are mounted side
  // by side in stack triage's split mode, and reading the global put the other one
  // into the fullscreen presentation as well - black background, 100vh viewport,
  // tools gone - over a stage that was not fullscreen at all.
  useEffect(() => {
    function onChange(): void {
      const active = document.fullscreenElement === stageRef.current;
      setFullscreen(active);
      if (!active) setToolbarVisible(false);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    // Only this stage's own: with two mounted, exiting on the global would leave
    // the button on stage B turning stage A's fullscreen off instead of turning
    // B's on.
    if (document.fullscreenElement === stageRef.current) {
      await document.exitFullscreen();
      return;
    }
    await stageRef.current?.requestFullscreen();
  }, []);

  // Ghost over the photograph, where the chip behind it is the frame; a plain
  // button in a page's own bar, beside the plain buttons already there.
  const toolVariant = toolsInto == null ? 'ghost' : 'default';
  const tools = (
    <>
      <ZoomControl zoom={zoom} variant={toolVariant} />
      <Button variant={toolVariant} iconOnly aria-label="Fullscreen" title="Fullscreen (F)" onClick={() => void toggleFullscreen()}>
        <Maximize size={ICON} />
      </Button>
    </>
  );

  useEffect(() => {
    if (!keyboard) return;
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
  }, [keyboard, toggleFullscreen]);


  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  // Still opaque under whatever replaced them. Not the frame on screen, which the
  // hold may name when a promotion left it where it was; and not one being asked
  // for again, since one source is one element and it has no raster to offer - the
  // hold is dropped rather than duplicated, which costs nothing, because the frames
  // it was covering are still what is on screen.
  const covering = retiring.sources.filter((source) => source !== visible && !incoming.includes(source));
  // Of those, the ones nothing else mounts: a frame held under its replacement is
  // usually still painted, and keeps the slot it already had.
  const retired = covering.filter((source) => !paintedSources.includes(source));
  // Bottom to top: the frames on their way out, the ones on screen, the ones being
  // prepared. Nothing here moves on promotion - a promoted source keeps the slot
  // it already had, and a promotion appends - so no element is reinserted into the
  // DOM mid-swap, and the frame being covered is always under the one covering it.
  const mounted = [...retired, ...paintedSources, ...incoming.filter((source) => !paintedSources.includes(source))];
  const allFailed = sources.length > 0 && wanted.length === 0;

  function classOf(source: string): string {
    // The step rides on the frame, so the one arriving and the one leaving each
    // keep sliding the way the step that produced them went even if the next step
    // lands before they are done.
    if (source === visible) return contentClass('is-ready', painted?.step ?? null);
    if (covering.includes(source)) return contentClass('is-retiring', retiring.step);
    // Painted but not showing: the other half of a pair. It keeps its raster on
    // its own layer so revealing it is an opacity change with no repaint - and it
    // does not slide, because a flip is not a step.
    if (isThisPhoto && paintedSources.includes(source)) return contentClass('is-layer', null);
    return contentClass(null, null);
  }

  return (
    <div
      ref={stageRef}
      className={`stage${fullscreen ? ' stage--fullscreen' : ''}${zoomed ? ' stage--zoomed' : ''}`}
      onMouseMove={() => fullscreen && setToolbarVisible(true)}
      onMouseLeave={() => setToolbarVisible(false)}
    >
      {!fullscreen && (toolsInto == null ? <div className="stage__tools">{tools}</div> : createPortal(tools, toolsInto))}

      <div
        ref={viewportRef}
        className="stage__viewport"
        {...handlers}
      >
        {/* A frame that failed replaces the incoming one, not the picture already
            on screen: switching to a rendition that 404s should leave the one
            being compared against up, not blank the stage. Nothing to hold means
            there is nothing to say but this. */}
        {allFailed && painted == null ? (
          <span className="tile__pending">no rendition yet</span>
        ) : (
          mounted.map((source) => (
            <StageFrame
              key={source}
              source={source}
              photoKey={photoKey}
              hold={hold === true}
              video={video}
              alt={alt}
              className={classOf(source)}
              transform={transform}
              onDecoded={promote}
              // Only a frame still being asked for. A retiring one is on its way
              // off the stage, and building a rendition nobody is looking at
              // because its element happened to error is work for no screen.
              onMissing={sources.includes(source) ? reportMissing : noop}
            />
          ))
        )}

        {/* The neighbouring photos, warmed only once this one is up: started any
            earlier they compete for the connection with the one being waited on.
            Mounted rather than fetched into a detached Image for the same reason
            the swap above is - a decode is for the size an element is drawn at,
            and these elements are the size those photos will be. */}
        {ready && preloadSrcs?.map((source) => <img key={source} src={source} alt="" aria-hidden className="stage__content" />)}
      </div>

      {busy && (
        <div className="stage__busy">
          <div className="stage__spinner" />
          <Text variant="mono">Rendering…</Text>
        </div>
      )}

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
