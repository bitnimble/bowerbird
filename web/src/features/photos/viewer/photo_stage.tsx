import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize, Minimize } from 'lucide-react';
import { Button } from '../../../ui/button';
import { ICON } from '../../../ui/icon';
import { Text } from '../../../ui/text';
import { toggleFullscreenOf } from './fullscreen';
import { PhotoStageStrings } from './photo_stage.strings';
import { keepOnly, releaseHolder } from './stage_bitmaps';
import { NO_SIZE, type Size, letterboxOf, useZoomPan } from './zoom_pan';
import { ZoomControl, ZoomSlider } from './zoom_control';
import { stageStyles } from './photo_stage.stylex';
import { StageFrame, type FrameState } from './stage_frame';
import { Spinner } from '../../../ui/spinner';
import { styles } from './photo_stage_view.stylex';
import { StageDetail } from './stage_detail';

// Fit, zoom and pan live in `zoom_pan.ts`, because the editor's canvas needs the same
// gesture and cannot be transformed the way an `<img>` can.

// How long the previous photo may stay on screen after moving to one this stage was not
// holding - a jump from the grid, or a rendition that had to be built. Past it the stage
// goes to its own background, the panels beside it already describing the photo in the URL.
//
// Long enough to cover a *decode*, which is what it is usually waiting for: a neighbour
// mounted a moment ago, on a full-size camera JPEG, on a page that has just loaded. At a
// tenth of a second it expired mid-arrival on exactly those - the reader stepped, the
// picture they left vanished, and the stage showed nothing until the next one landed. Short
// enough that a wait with no end in sight - a build, a file still being fetched - still
// reads as loading rather than as the wrong picture.
const STALE_FRAME_MS = 500;

// How many frames the frame being replaced is held under its replacement. An
// element hidden with opacity: 0 is never rasterised, so the incoming one has no
// raster at the moment it is revealed and the browser needs a frame or two to
// build one; dropping the outgoing one in the same commit left the stage
// background showing through for exactly that long, on every swap. Nothing in
// the page can observe a raster landing - `decode()` resolves well before it -
// so this is a count rather than a signal.
//
// The same fact is why a mounted-but-hidden frame gets its own compositor layer
// (`styles.layer`): it is revealed by an opacity change with no
// repaint, so it has to keep the raster it would otherwise throw away. Without
// that, stack triage's flip stalls on every press.
const RETIRED_FRAMES = 3;

// How long the picture arriving takes to slide in, and so how long the frames of the one
// being left have to stay mounted underneath it. Enough movement to say which way the
// reader went and no more; a longer slide turns a cull into a wait.
const STEP_MS = 130;

// The longest the move will wait at its starting offset for the browser to put the
// photograph on screen. A cap rather than a timeout: it is lifted the moment the picture is
// presented, and is only reached where something has gone wrong enough that sliding a frame
// nobody can see is the least of it - at which point it plays out by itself.
const HELD_MS = 2000;

// A frame delivered no later than this is the browser keeping up - two 60Hz frames, so a
// display at any ordinary rate reads as steady, and the hundred milliseconds it spends
// uploading a sixty-megapixel photograph does not.
const SETTLED_FRAME_MS = 34;

// Names one stage's claim on the decoded frames, two of them being on screen at once in
// stack triage's split.
let holders = 0;

// Which way the last step went, so the two frames slide the way the reader
// moved. `fade` is the same exchange with no direction to express: stack triage
// replaces one photo of a pair while the other stays put, and a slide would
// claim a movement through a collection that is not what happened. Null for
// anything that is not a step - a rendition swap, a flip between a round's two
// frames, or the first frame after opening a photo - which then just appears.
type Step = 'next' | 'prev' | 'fade' | null;

// How far a finger has to travel across the frame to count as a step rather
// than a tap, and how much straighter than it is tall: a swipe that is mostly
// vertical is the reader scrolling the page, not asking for the next photo.
const SWIPE_MIN_PX = 48;
const SWIPE_STRAIGHTNESS = 1.5;

/**
 * One picture the stage can show, and the frames it may be drawn from.
 *
 * A photograph's renditions are one picture: the camera's JPEG and the renders
 * beside it are the same thing seen differently, so choosing between them moves
 * nothing on screen. Two pictures is stack triage's flip mode (DESIGN §20.4),
 * where the frames are two photographs and only one of them is up at a time.
 */
export interface StagePicture {
  /** What its frames are of, so a rendition arriving beside them is not a new picture. */
  key: string;
  /** Interchangeable views of it, in the order they arrived. */
  sources: readonly string[];
  /** Which of `sources` to draw. The last of them by default. */
  frame?: string;
  /**
   * What this picture is of. Per picture and not per stage: several photographs are mounted
   * at once, and named from the stage they all described the one being looked at - so a
   * neighbour standing in while the next photograph arrives was announced as the photograph
   * it is standing in for. Per frame where its frames differ in what a reader sees: the
   * renditions of one photograph. Falls back to the stage's own `alt`.
   */
  alt?: string | ((source: string) => string);
}

function altOf(picture: StagePicture | undefined, source: string): string | undefined {
  return typeof picture?.alt === 'function' ? picture.alt(source) : picture?.alt;
}

// Firefox's HDR twin is the one source that is a `<video>`, and the only thing on this
// stage ever built as an object URL (`useHdrVideo`), so the element type is a property of
// the source rather than of the picture asking for it. That matters for a frame on its way
// off the stage: it is drawn from `painted`/`retiring` after its picture has left the
// props, and a flag read off the picture then flipped it to an `<img>` mid-exit, remounting
// a revoked blob as an image that cannot decode.
function isVideo(source: string): boolean {
  return source.startsWith('blob:');
}

function frameOf(picture: StagePicture): string | undefined {
  return picture.frame ?? picture.sources[picture.sources.length - 1];
}

interface Props {
  /**
   * The pictures this stage can show, in slot order. All of their frames are mounted and
   * decoded, and only the one at `showing` is opaque - so moving between them costs an
   * opacity change and nothing else. The viewer hands over the run either side of the
   * open photograph; stack triage hands over the two sides of a round.
   *
   * Under a single `photoKey` they also share a zoom and a pan, which is what lets a pair
   * be compared at one magnification.
   */
  pictures: readonly StagePicture[];
  /** Which of `pictures` is on screen. */
  showing?: number;
  alt: string;
  filename: string;
  /** The decoded size of a frame, reported once per source. */
  onImageLoad: (source: string, width: number, height: number) => void;
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
   * a neighbour the run was holding is up the instant it is asked for, so it would
   * paint and then jump as the layout resolved under it.
   */
  hold?: boolean;
  /**
   * Bind this stage's window-level keys. Off for the second of two mounted
   * stages, which would otherwise both act on one `f`.
   */
  keyboard?: boolean;
  /**
   * Draw the zoom readout into this element rather than over the frame. A portal rather
   * than a callback: the readout changes on every frame of a wheel zoom, and handing it
   * upwards would redraw the page around the stage at that rate.
   */
  toolsInto?: HTMLElement | null;
  /**
   * Where the zoom slider goes, which is a bar's menu and so is null whenever that menu is
   * shut. A portal for the reason `toolsInto` is one, a track being dragged a scale a frame.
   */
  zoomInto?: HTMLElement | null;
  /**
   * The element to put fullscreen, handed up as it mounts. Fullscreen is this stage's own,
   * so a page drawing the control itself cannot ask for it without the element it applies to.
   */
  fullscreenRef?: (element: HTMLDivElement | null) => void;
  /**
   * A line about the frame, in the corner of the stage, or null for the silence that is
   * the usual state. Pinned to the stage rather than drawn over the photograph, so a
   * reader zoomed in and panning finds it in the same place.
   */
  status?: { label: string; busy: boolean } | null;
  /**
   * A hairline just outside the frame, in this colour. An outline rather than a
   * border because it takes no space: two stages laid out to the same displayed
   * area keep it.
   */
  frameColor?: string;
  style?: stylex.StyleXStyles;
}

function noop(): void {
  /* a frame on its way off the stage reports to nobody */
}

// The image viewport: fit/zoom, wheel zoom, drag-to-pan and fullscreen. All of
// this is ephemeral view state, so it stays local rather than going through a
// store; nothing outside this component needs to know the pan offset.
export function PhotoStage({
  pictures,
  showing = 0,
  alt,
  filename,
  photoKey,
  step: arrivedBy = null,
  onSwipe,
  hold,
  retryEpoch,
  keyboard = true,
  onImageLoad,
  onImageMissing,
  toolsInto,
  zoomInto,
  fullscreenRef,
  status = null,
  frameColor,
  style,
}: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
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
  //
  // `of` is every painted frame against the picture it belongs to, in the order
  // they arrived. The picture and not just the frame, because a frame nobody is
  // asking for any more is still drawn inside the picture it arrived in, and by
  // then that picture is gone from the props.
  const [painted, setPainted] = useState<{ of: ReadonlyMap<string, string>; photoKey: string } | null>(null);
  // The decoded size of each painted source. Per source, because a stage holds
  // frames that may differ in shape, and `clampPan` is computed from whichever of
  // them is on screen.
  const [naturals, setNaturals] = useState<ReadonlyMap<string, Size>>(new Map());
  // The frames whose detail layer is as sharp as the view asks for (`StageDetail`).
  const [sharp, setSharp] = useState<ReadonlySet<string>>(new Set());
  const noteSharp = useCallback((source: string, isSharp: boolean) => {
    setSharp((previous) => {
      if (previous.has(source) === isSharp) return previous;
      const next = new Set(previous);
      if (isSharp) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  // The frames `painted` just replaced, kept mounted and opaque underneath for
  // RETIRED_FRAMES. Their rasters are the ones the browser already has, so they
  // are what shows through while the replacements' are being built.
  // `animated` and not a direction: which way the step went is the exchange's to own, and
  // sampled here it is read a render too early - `lastStep` lands after the route does, and
  // a warm frame re-decodes in that same commit - so the two answered differently on the
  // commonest path of all, a step onto a neighbour already held.
  const [retiring, setRetiring] = useState<{ of: ReadonlyMap<string, string>; animated: boolean }>({
    of: new Map(),
    animated: false,
  });

  const sources = pictures.flatMap((picture) => [...picture.sources]);
  const asking = new Map(pictures.flatMap((picture) => picture.sources.map((source) => [source, picture.key] as const)));
  // Which picture draws a frame: the one asking for it, or - for a frame on its
  // way off the stage - the one it arrived in.
  const pictureOf = (source: string): string =>
    asking.get(source) ?? painted?.of.get(source) ?? retiring.of.get(source) ?? source;

  // Everything with a raster, whichever photo it belongs to. A photograph stepped away
  // from keeps its own, being a neighbour now; what the cap below drops is only the
  // *showing* of one over a picture that has not arrived.
  const paintedSources = [...(painted?.of.keys() ?? [])];
  // Set once the frame covering an unarrived picture has been up long enough (see
  // `covering`), which is what stops a slow arrival from leaving the wrong photograph on
  // screen for the length of a build.
  const [expired, setExpired] = useState(false);
  // The frame last shown, which is what stands in while a picture arrives. Written below
  // once this render has settled what that is; idempotent, so a StrictMode double render
  // reaches the same answer.
  const standing = useRef<string | undefined>(undefined);
  const isThisPhoto = painted?.photoKey === photoKey;
  // What is up: this photo's frames in slot order, then any it has painted that
  // are no longer asked for, then - for the beat after a step - the previous
  // photo's. The middle group is a rendition being swapped: the frame on screen
  // stays on screen until its replacement decodes, which is the whole point of
  // holding a decoded frame. Dropping it there blanked the stage for the length of
  // the decode, and for the length of the *build* when the new rendition had to be
  // made first.
  // Every painted frame, in the order one should be preferred as a stand-in: this photo's
  // frames in slot order first, then any it has painted that are no longer asked for. Same
  // set as `paintedSources` either way - only `[0]` below reads the ordering.
  const preferred = isThisPhoto
    ? [...sources.filter((source) => paintedSources.includes(source)), ...paintedSources.filter((source) => !sources.includes(source))]
    : paintedSources;
  // The chosen picture's frame once it has decoded, else whatever else is up: a
  // pair whose second frame is still decoding shows the first rather than nothing.
  //
  // Not gated on the frame having been painted under *this* photoKey. A run mounts its
  // neighbours (see `pictures`), so the picture stepped to is routinely one this stage
  // painted while it was still showing the one before - which is the whole point, and
  // which that gate would have shown the previous photograph over for a beat.
  const picture = pictures[showing];
  const chosen = picture == null ? undefined : frameOf(picture);
  const shownKey = picture?.key;
  // Whichever frame was last on screen, falling back to the preferred one: a neighbour
  // finishing its decode while the stepped-to picture is still arriving would otherwise
  // capture the stage - a photograph two away, that the reader never asked for.
  const held = standing.current != null && paintedSources.includes(standing.current) ? standing.current : preferred[0];
  const arrived = chosen != null && paintedSources.includes(chosen) ? chosen : undefined;
  // A rendition replacing another of the same picture waits for its detail layer: zoomed in,
  // its fitted frame magnified would otherwise show before it sharpens.
  const swapping =
    arrived != null && held != null && held !== arrived && pictureOf(held) === shownKey && !isVideo(arrived);
  const ready = arrived != null && (!swapping || sharp.has(arrived));
  // Something else on screen while the picture asked for has nothing to show: the beat
  // after a step to a photograph this stage was not holding. Not a rendition swapping
  // under the picture already up, which is the same picture and stays.
  const standingIn = !ready && held != null && pictureOf(held) !== shownKey;
  const visible = ready ? chosen : standingIn && expired ? undefined : held;
  if (visible != null) standing.current = visible;
  const natural = (visible == null ? undefined : naturals.get(visible)) ?? NO_SIZE;
  const detailed = [...new Set([visible, swapping ? arrived : undefined])].filter(
    (source): source is string => source != null && !isVideo(source),
  );

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
  const { view, reset, zoomed, handlers, box } = zoom;

  // Off the observed box rather than a measurement: `useZoomPan` keeps it under a
  // ResizeObserver, and reading the element here would be a layout read on every frame of a
  // wheel zoom.
  const letterbox = letterboxOf(view, box, natural);

  // A new photo starts fitted; carrying a pan offset across frames would show
  // the next one scrolled to a corner. Keyed on the photo rather than the source,
  // so switching rendition - or flipping between a round's two frames - holds the
  // view it is already at.
  useEffect(reset, [photoKey, reset]);

  // A picture the stage was not holding has to arrive, and dropping what is on screen
  // first turns that into a blink of stage background - so the frame before it stays up.
  // Capped, because the picture and the panels beside it disagree until it goes, and a
  // photograph whose rendition has to be *built* would otherwise keep them disagreeing for
  // the length of the build.
  //
  // Nothing is unpainted by this: the frames stay where they are, rasters and all, and
  // only what is *shown* changes. Wiping them was what the cap did when a step meant
  // tearing the stage down, and with the neighbours held it took them with it.
  //
  // Timed from when the covering started rather than from the last step: stepping faster
  // than the cap leaves the timer running instead of restarting it, so holding the arrow
  // key cannot pin a frame from ten photographs ago to the stage.
  useEffect(() => {
    if (!standingIn) {
      setExpired(false);
      return;
    }
    const timer = setTimeout(() => setExpired(true), STALE_FRAME_MS);
    return () => clearTimeout(timer);
  }, [standingIn]);

  useEffect(() => {
    if (retiring.of.size === 0) return;
    const done = (): void => setRetiring({ of: new Map(), animated: false });
    // A stepped-away frame is animating out, so it is timed rather than counted:
    // unmounted after a few frames it would vanish part-way through its exit.
    if (retiring.animated) {
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

  // Which picture is up, and what it replaced. **The exchange, not the decode**: a run
  // mounts its neighbours, so the picture stepped to usually has its raster already and
  // there is no arrival to hang an animation on - the move itself is the event. This one
  // axis is also what tells a step from the three things that are not one, all of which
  // leave the shown picture where it was: a rendition swapped underneath it, a stage
  // painting its first picture, and a photograph held over into the next round.
  const shownBefore = useRef<{ picture: string; photo: string; source: string | undefined } | undefined>(undefined);
  const [exchange, setExchange] = useState<{ to: string; from: string; step: Step } | null>(null);
  // The direction is not settled when the exchange happens: the route moves first and
  // `lastStep` a render later, so it is filled in on the exchange it belongs to rather than
  // read loose at render.
  useEffect(() => {
    if (arrivedBy == null) return;
    setExchange((was) => (was == null || was.step === arrivedBy ? was : { ...was, step: arrivedBy }));
  }, [arrivedBy]);

  // The elements the pictures are drawn in, so the one arriving can be told to move.
  const pictureEls = useRef(new Map<string, HTMLDivElement>());
  const holdPicture = useCallback((key: string, element: HTMLDivElement | null): void => {
    if (element == null) pictureEls.current.delete(key);
    else pictureEls.current.set(key, element);
  }, []);

  /**
   * The picture arriving slides in from the side the reader moved towards.
   *
   * Asked for here rather than declared in the stylesheet, because a step is a *repeat*:
   * the same photograph is arrived at again and again as a reader goes back and forth, and
   * a CSS animation whose name is already on an element it has run before does not reliably
   * start again - the picture simply appeared, with no way to tell which way it had gone.
   * Driven from the exchange, every step is a new animation by construction, and `STEP_MS`
   * is one number rather than one here and six in the stylesheet.
   *
   * Nothing animates the picture being left: `styles.leaving` hides it outright, which is a
   * resting state and so holds whether or not anything ran.
   *
   * **It waits for the picture to be on the screen, not merely in the DOM.** Revealing a
   * sixty-megapixel frame is a texture upload the main thread blocks on - measured at 85ms -
   * and an animation started before it runs its whole length against a stalled compositor:
   * by the time there are pixels to see, the move is over. So it goes up held at its
   * starting offset (`fill: 'backwards'` behind a delay, which is what makes the picture
   * *appear* already displaced rather than jump there), and is released two animation frames
   * later - past the commit that carries the upload, and so past the stall. Released early
   * by nothing: a delay that is never lifted plays out on its own.
   */
  const played = useRef<unknown>(null);
  useEffect(() => {
    const step = exchange?.step;
    if (exchange == null || step == null || played.current === exchange) return;
    const element = pictureEls.current.get(exchange.to);
    if (element == null) return;
    // **Not until the picture it moves is the one on screen.** A decode resolving is not a
    // paint: a full-size camera JPEG revealed on a busy main thread lands a few hundred
    // milliseconds later, and an animation started when the exchange formed has run itself
    // out by then - the reader catches the tail of a move, or none of it.
    if (visible == null || pictureRef.current(visible) !== exchange.to) return;
    played.current = exchange;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Decoration, and the only thing here that is: what is on screen is settled by the
    // styles either way, so a host without this - jsdom, where the components are tested -
    // shows the step without the movement rather than failing to render it.
    if (typeof element.animate !== 'function') return;
    const from = step === 'fade' ? { opacity: 0 } : { translate: step === 'next' ? '22px' : '-22px' };
    // Whatever this picture was last told to do, it is not doing it any more. A move still
    // waiting out its delay holds the offset it starts from, so a reader stepping back and
    // forth over one pair would otherwise leave the earlier one to surface behind the newer
    // and shunt the photograph sideways once the newer had finished.
    if (typeof element.getAnimations === 'function') for (const spent of element.getAnimations()) spent.cancel();
    const move = element.animate([from, {}], {
      duration: STEP_MS,
      easing: 'ease-out',
      delay: HELD_MS,
      fill: 'backwards',
    });

    // **Released on the first frame the browser is drawing again.** Revealing the
    // photograph costs an upload the renderer stalls on, and it delivers no frames while it
    // does - so the frame after it arrives late, and counting frames instead lets one slip
    // through a gap in the work and starts the move against a picture nobody can see yet.
    // A gap back at the display's own rate is the stall being over, which is the first
    // moment there is anything to watch.
    let previous = performance.now();
    let frames = 0;
    let watching = true;
    const tick = (now: number): void => {
      if (!watching) return;
      const gap = now - previous;
      previous = now;
      frames++;
      if ((frames >= 2 && gap < SETTLED_FRAME_MS) || frames >= HELD_MS / SETTLED_FRAME_MS) {
        const waited = Number(move.currentTime ?? 0);
        move.effect?.updateTiming({ delay: Math.min(waited, HELD_MS) });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Or it goes on waking for a picture that has left the page, holding the element it
    // animates for as long as it does.
    return () => {
      watching = false;
    };
  }, [exchange, visible]);
  useEffect(() => {
    // Not until the picture has a frame with a raster in it. A neighbour the run was
    // holding does from the first render, which is the whole point; one that had to arrive
    // does not, and animating at the mount ran the slide out over an empty frame and left
    // the photograph to appear afterwards, all at once, with nothing to arrive by.
    if (shownKey == null || !ready) return;
    const was = shownBefore.current;
    // Written before every early return below, or a round that holds its winner over
    // leaves `photo` naming the round before: the next flip then reads as a step, and the
    // flip back is refused by the guard below and leaves the picture it is showing hidden as
    // the spent exchange's `from` - a stage stuck at opacity 0 for good.
    shownBefore.current = { picture: shownKey, photo: photoKey, source: visible };
    if (was?.picture === shownKey) return;
    // A different picture under the same `photoKey` is a flip, not a step: stack triage's
    // A/B puts two photographs on one stage precisely so the reader can trade them in
    // place, and an animation is what would stop them seeing the difference.
    if (was == null) return;
    if (was.photo === photoKey) {
      setExchange(null);
      return;
    }
    // Left in place rather than cleared after the animation: `from` is what keeps the picture
    // stepped away from hidden, and a timer here would reveal it under the one on screen.
    setExchange({ to: shownKey, from: was.picture, step: arrivedBy });
  }, [shownKey, photoKey, arrivedBy, ready, visible]);

  const onLoaded = useRef(onImageLoad);
  onLoaded.current = onImageLoad;
  const onMissing = useRef(onImageMissing);
  onMissing.current = onImageMissing;

  const wanted = sources.filter((source) => !failed.has(source));
  // The neighbours wait for something to be on the stage before they mount: an element
  // mounted is an element asking, and started any earlier they compete for the connection
  // with the frame the reader is waiting on.
  //
  // **Anything painted, not the picture asked for.** Gated on the latter, a step to a
  // photograph that had to arrive unmounted both neighbours for the length of that arrival
  // and mounted them again after - which is a fetch and a decode per step, for files the
  // page was already holding, and the exact trap this whole arrangement exists to avoid.
  const anythingUp = paintedSources.length > 0;
  // Whether the picture asked for has been up long enough to have arrived. Fetching the next
  // photograph is work for a screen nobody is looking at yet, and started in the commit the
  // step lands in it takes the connection and the decoder from the one the reader is waiting
  // on - which on a sixty-megapixel JPEG is the difference between a step that answers and
  // one that stalls. So it waits out the move, and begins once the reader is looking at it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!ready) return;
    const timer = setTimeout(() => setSettled(true), STEP_MS);
    return () => clearTimeout(timer);
  }, [shownKey, ready]);
  // Mounted for this photo but not yet painted. A frame painted for the photo
  // before this one does not count as up, however identical the URL: it is on its
  // way out, and this photo still has to decode its own.
  const fresh = (source: string): boolean => !(isThisPhoto && paintedSources.includes(source));
  // Every frame of the picture being looked at, at once: these are what the reader is
  // waiting on, and they are the only ones anybody is waiting on.
  const asked = wanted.filter((source) => fresh(source) && pictureOf(source) === shownKey);

  /**
   * The photographs held either side, mounted **one at a time**.
   *
   * A frame is a camera JPEG at whatever the sensor is - sixty megapixels on a body worth
   * culling on - so each costs tens of megabytes to fetch and a couple of hundred
   * milliseconds to decode. Mounted together they are three of those at once, and the
   * browser interleaves them: every one of them lands late, including the one the reader is
   * about to step onto. In turn, each is done by the time the next is asked for.
   *
   * Nearest first, and in the direction of travel before the other side: what the reader
   * asks for next is almost always the photograph they are already heading towards.
   */
  // How readily each picture would be stepped to: the way the reader is going before the way
  // they are not, and nearer before further.
  const nearness = new Map(
    pictures.map((picture, at) => {
      const away = (at - showing) * (arrivedBy === 'prev' ? -1 : 1);
      return [picture.key, away > 0 ? away : -away + 0.5] as const;
    }),
  );

  const nextUp = (): string[] => {
    if (!anythingUp || asked.length > 0 || !settled) return [];
    const queue = wanted
      .filter((source) => fresh(source) && pictureOf(source) !== shownKey)
      .sort((a, b) => (nearness.get(pictureOf(a)) ?? 0) - (nearness.get(pictureOf(b)) ?? 0));
    return queue.slice(0, 1);
  };

  const incoming = [...asked, ...nextUp()];


  // Read inside the promote below, which runs off a decode: the values captured in
  // that closure would be whatever was asked for when the decode started.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const pictureRef = useRef(pictureOf);
  pictureRef.current = pictureOf;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const shownRef = useRef(shownKey);
  shownRef.current = shownKey;

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
      // What is on screen, and only that. A frame nobody asks for any more is usually a
      // neighbour dropped from the trailing edge of the run, which was never visible and
      // has nothing to hold up: retired, it is drawn opaque at the bottom of the stack, so
      // what appeared to slide away on a step was a photograph two or three back.
      const outgoing = visibleRef.current;
      const covered = outgoing == null || outgoing === source ? [] : [outgoing];
      // Timed like a step only when what is going is a *picture*. A rendition being
      // swapped covers the frame it replaces inside the picture already on screen, which
      // is a few frames of overlap and no animation at all.
      const leaving = covered.some((frame) => pictureRef.current(frame) !== shownRef.current);
      if (covered.length > 0) {
        setRetiring({ of: new Map(covered.map((frame) => [frame, pictureRef.current(frame)])), animated: leaving });
      }

      const into = pictureRef.current(source);
      setPainted((previous) => {
        const of = new Map([...(previous?.of ?? [])].filter(([frame]) => asked.includes(frame)));
        of.set(source, into);
        return { of, photoKey };
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
    // Firefox's HDR twin is built in the page out of a still already fetched, so a failure
    // there is not the server missing a file and there is nothing to build. The frame is
    // still marked failed, or the stage would keep waiting on it and never say so.
    if (isVideo(source)) return;
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

  const toggleFullscreen = useCallback(() => toggleFullscreenOf(stageRef.current), []);

  const captureStage = useCallback(
    (element: HTMLDivElement | null): void => {
      stageRef.current = element;
      fullscreenRef?.(element);
    },
    [fullscreenRef],
  );

  // Both buttons only where the stage draws its own controls, which is a stage with no
  // bar to hand them to: the ghost pair over the corner of the photograph is what stack
  // triage's split mode has instead of a menu.
  const tools = (
    <>
      <ZoomControl zoom={zoom} variant="ghost" stepper={toolsInto == null} />
      {toolsInto == null && (
        <Button
          variant="ghost"
          iconOnly
          aria-label={PhotoStageStrings.fullscreen()}
          title={PhotoStageStrings.fullscreenTitle()}
          onClick={() => void toggleFullscreen()}
        >
          <Maximize size={ICON} />
        </Button>
      )}
    </>
  );

  useEffect(() => {
    if (!keyboard) return;
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Ctrl+F is the browser's find, and `f` alone is the only thing here anyone asked for.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') void toggleFullscreen();
      // The keyboard's way to the scales the slider covers: it sits in a menu popup, where
      // nothing may take the focus the menu's own items need.
      else if (e.key === '+' || e.key === '=') zoom.zoomTo(zoom.stopAfter, null);
      else if (e.key === '-') reset();
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, toggleFullscreen, zoom, reset]);


  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  // Still opaque under whatever replaced them. Not the frame on screen, which the
  // hold may name when a promotion left it where it was; and not one being asked
  // for again, since one source is one element and it has no raster to offer - the
  // hold is dropped rather than duplicated, which costs nothing, because the frames
  // it was covering are still what is on screen.
  // The reader asked for a frame that cannot be drawn, and something else is on screen in
  // its place. Said rather than left to look like a picker that does nothing: the stage
  // holds every rendition it has painted, so the stand-in is a real picture of the same
  // photograph and there is nothing about it that reads as a failure.
  const unreadable = chosen != null && failed.has(chosen);
  const notice =
    status ?? (unreadable ? { label: PhotoStageStrings.frameUnreadable(), busy: false } : null);

  const covering = [...retiring.of.keys()].filter((source) => source !== visible && !incoming.includes(source));
  // Of those, the ones nothing else mounts: a frame held under its replacement is
  // usually still painted, and keeps the slot it already had.
  const retired = covering.filter((source) => !paintedSources.includes(source));
  // Bottom to top: the frames on their way out, the ones on screen, the ones being
  // prepared. Nothing here moves on promotion - a promoted source keeps the slot
  // it already had, and a promotion appends - so no element is reinserted into the
  // DOM mid-swap, and the frame being covered is always under the one covering it.
  const mounted = [...retired, ...paintedSources, ...incoming.filter((source) => !paintedSources.includes(source))];
  const allFailed = sources.length > 0 && wanted.length === 0;

  // Sizes for frames nothing draws any more, off the same list that draws them. Kept by
  // source rather than cleared on the photograph: a run holds its neighbours, so the sizes
  // of the pictures either side are read the moment one of them is stepped to. Left to
  // accumulate, a session walking a few hundred photographs keeps every one of their sizes
  // for the life of the page. A size only exists once a frame has decoded, and a frame that
  // has decoded is painted, so nothing dropped here belongs to anything on screen.
  const mountedKey = mounted.join(' ');
  useEffect(() => {
    const live = new Set(mountedKey.split(' '));
    setNaturals((previous) => {
      const stale = [...previous.keys()].filter((source) => !live.has(source));
      if (stale.length === 0) return previous;
      const next = new Map(previous);
      for (const source of stale) next.delete(source);
      return next;
    });
  }, [mountedKey]);

  // And the bitmaps behind them, which are this page's to free: nothing else drops an
  // `ImageBitmap`, and at tens of megabytes apiece a session that walks a few hundred
  // photographs would hold every one of them until the tab went.
  const holder = useRef(`stage-${(holders += 1)}`).current;
  const zoomableKey = mounted.filter((source) => pictureOf(source) === shownKey).join(' ');
  useEffect(
    () => keepOnly(holder, mountedKey.split(' '), zoomableKey.split(' ')),
    [holder, mountedKey, zoomableKey],
  );
  useEffect(() => () => releaseHolder(holder), [holder]);

  // The same order, gathered into the pictures that draw them: a picture takes
  // the place its first frame had, so the stacking above still holds.
  const drawn: { key: string; sources: string[] }[] = [];
  for (const source of mounted) {
    const key = pictureOf(source);
    const into = drawn.find((group) => group.key === key);
    if (into == null) drawn.push({ key, sources: [source] });
    else into.sources.push(source);
  }

  function stateOf(source: string): FrameState {
    if (source === visible) return 'ready';
    if (covering.includes(source)) return 'retiring';
    // Painted but not showing: another rendition of this picture, the other half of a pair,
    // or a neighbour held for the step onto it. It keeps its raster on its own layer so
    // revealing it is an opacity change with no repaint.
    if (isThisPhoto && paintedSources.includes(source)) return 'layer';
    return null;
  }

  // A picture the props no longer name is on its way off the stage, and so is the one a
  // step just moved off - which a run still names, being the neighbour now. The exchange is
  // what says a step happened and which way it went; a picture the run simply dropped is
  // not one, and is left to go without an animation over content nobody saw.
  //
  // **Except while it is the one being looked at.** Leaving hides a picture outright,
  // and the photograph stepped to has to arrive before there is anything to hide it for: a
  // step to one this stage was not holding is covered by the frame already up, which lives
  // in the picture the step is leaving. Hidden on the exchange alone, that cover went with
  // it and the stage showed its own background until the new photograph decoded.
  function isLeaving(key: string): boolean {
    const drawing = visible == null ? undefined : pictureOf(visible);
    if (key === drawing) return false;
    return exchange?.from === key || !pictures.some((each) => each.key === key);
  }

  return (
    <div
      ref={captureStage}
      {...stylex.props(stageStyles.stage, fullscreen && styles.fullscreen, style)}
      style={frameColor == null ? undefined : { outline: `1px solid ${frameColor}`, outlineOffset: '1px' }}
      onMouseMove={() => fullscreen && setToolbarVisible(true)}
      onMouseLeave={() => setToolbarVisible(false)}
    >
      {!fullscreen &&
        (toolsInto == null ? <div {...stylex.props(stageStyles.tools)}>{tools}</div> : createPortal(tools, toolsInto))}
      {zoomInto != null && createPortal(<ZoomSlider zoom={zoom} />, zoomInto)}

      <div
        ref={viewportRef}
        {...stylex.props(stageStyles.viewport, fullscreen && styles.viewportFullscreen, stylex.defaultMarker())}
        role="region"
        aria-label={PhotoStageStrings.stage()}
        aria-busy={!ready && !unreadable}
        {...handlers}
      >
        {/* A frame that failed replaces the incoming one, not the picture already
            on screen: switching to a rendition that 404s should leave the one
            being compared against up, not blank the stage. Nothing to hold means
            there is nothing to say but this - unless the 404 is what started a
            build, which is the usual way a photo with no rendition is opened, and
            "no rendition yet" over a spinner already saying one is being made
            reads as the opposite of what is happening. */}
        {allFailed && painted == null && status?.busy !== true ? (
          <span {...stylex.props(styles.pending)}>{PhotoStageStrings.noRenditionYet()}</span>
        ) : (
          drawn.map((group) => (
            <div
              key={group.key}
              ref={(element) => holdPicture(group.key, element)}
              {...stylex.props(styles.picture, isLeaving(group.key) && styles.leaving)}
              aria-hidden={isLeaving(group.key) || undefined}
              style={{ transform }}
            >
              {group.sources.map((source) => (
                <StageFrame
                  key={source}
                  source={source}
                  photoKey={photoKey}
                  hold={hold === true}
                  video={isVideo(source)}
                  alt={altOf(pictures.find((each) => each.key === group.key), source) ?? alt}
                  state={stateOf(source)}
                  zoomed={zoomed}
                  shown={source === visible}
                  requested={source === chosen}
                  whole={zoomed && group.key === shownKey}
                  onDecoded={promote}
                  // Only a frame still being asked for. A retiring one is on its
                  // way off the stage, and building a rendition nobody is looking
                  // at because its element happened to error is work for no screen.
                  onMissing={sources.includes(source) ? reportMissing : noop}
                />
              ))}
              {/* The frame on screen and the rendition being swapped to: a neighbour is fitted
                  by definition, and the one being left is on its way out. */}
              {/* Keyed by source, so the canvas is a new one per file: a canvas holds one kind
                  of context for its whole life, and an HDR rendition is drawn through WebGPU
                  where a camera JPEG too large to import is drawn through 2D. */}
              {detailed
                .filter((source) => group.sources.includes(source))
                .map((source) => (
                  <StageDetail
                    key={source}
                    source={source}
                    natural={naturals.get(source) ?? NO_SIZE}
                    box={box}
                    view={view}
                    hidden={!zoomed}
                    shown={source === visible}
                    onSharp={noteSharp}
                  />
                ))}
            </div>
          ))
        )}

        {/* Inset to the photograph rather than to the viewport: a portrait frame in a
            landscape stage leaves letterbox either side, and a corner of the stage is a
            corner of nothing. Outside the pictures, which carry the zoom and pan, so a pan
            slides the frame under it rather than taking it off the screen. */}
        {notice != null && (
          <div
            {...stylex.props(styles.status)}
            role="status"
            aria-busy={notice.busy}
            style={{ top: `${letterbox.y}px`, right: `${letterbox.x}px` }}
          >
            {notice.busy && <Spinner small />}
            <Text variant="mono" style={styles.statusText}>
              {notice.label}
            </Text>
          </div>
        )}
      </div>

      {/* Fullscreen shows nothing but the photo; the bar surfaces on hover so the
          filename and the way out are always reachable without cluttering it. */}
      {fullscreen && (
        <div {...stylex.props(styles.bar, toolbarVisible && styles.barVisible)}>
          <Text variant="mono">{filename}</Text>
          <Button onClick={() => void toggleFullscreen()}>
            <Minimize size={ICON} />
            {PhotoStageStrings.exitFullscreen()}
          </Button>
        </div>
      )}
    </div>
  );
}
