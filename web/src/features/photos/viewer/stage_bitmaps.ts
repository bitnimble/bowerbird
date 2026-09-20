// Decoding the viewer's frames ourselves, into pictures this page owns.
//
// An `<img>` is decoded at the browser's discretion and *kept* at its discretion too: it
// drops the decoded bytes of anything it is not painting, so a neighbour held ready is
// decoded again on the way in - a couple of hundred milliseconds for a sixty-megapixel
// camera JPEG - and revealing it costs a texture upload of a quarter of a gigabyte, which
// the GPU process spends where no signal on this side can see it. That is what makes a step
// stall, and what leaves an animation timed against it running out over a picture nobody can
// see yet. Decoded here, the frame is a handle we hold: nothing evicts it, the work happens
// off the main thread, and it is decoded *to a size* rather than decoded whole and thrown
// away - a JPEG scales during the decode itself, so asking for 4K is both smaller and faster
// than asking for all of it.

import { type Region, paintExtended, planarLayout } from './stage_gpu';
import { orientationOfAvif } from 'avif-hdr-video';

/** The longest edge a frame is decoded to: a 4K stage at 2x, which is past any display we draw on. */
const DECODE_CAP = 4096;

/**
 * The longest edge a canvas may be given, whatever it is being asked to hold.
 *
 * Past its own limit a browser refuses the element **silently**: `getContext` hands back null,
 * nothing throws, and the frame reads as one the server never had. 8192 is under every
 * engine's - Chromium allows 16384 and an area of 16384², iOS Safari far less - and is still
 * past any display, so nothing is lost by staying inside it.
 */
const MAX_CANVAS_EDGE = 8192;

/**
 * What to size the canvas drawing this many pixels, which is not always what was asked for.
 *
 * **A decoder is free to ignore `desiredWidth`, and AVIF's does.** Scaled decode is a JPEG
 * trick (and a WebP one); everything else comes back whole - so a 33804-pixel panorama arrives
 * at 33804 however small a frame was asked for, and sizing the canvas to it produces the silent
 * refusal above. Fitted here, the draw resamples on the way in and the picture is simply the
 * size it was always meant to be.
 */
export function canvasSizeFor(width: number, height: number, cap = MAX_CANVAS_EDGE): { width: number; height: number } {
  const scale = Math.min(1, cap / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The same, for the frame the stage draws fitted: no more than the decode was asked for. */
export function fittedCanvasSize(frame: Decoded): { width: number; height: number } {
  return canvasSizeFor(frame.width, frame.height, DECODE_CAP);
}

// WebCodecs, which TypeScript's DOM library does not describe. Only what is used here.
interface ImageDecoderInit {
  data: ArrayBuffer;
  type: string;
  desiredWidth?: number;
  desiredHeight?: number;
}
interface ImageDecoderResult {
  image: VideoFrame;
}
interface ImageDecoderLike {
  decode(): Promise<ImageDecoderResult>;
  close(): void;
}
type ImageDecoderConstructor = new (init: ImageDecoderInit) => ImageDecoderLike;

const WebCodecs = (globalThis as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
function avifRotation(bytes: ArrayBuffer, type: string): 0 | 90 | 180 | 270 {
  if (type !== 'image/avif') return 0;
  try {
    return orientationOfAvif(new Uint8Array(bytes));
  } catch {
    return 0;
  }
}


export interface Decoded {
  /** Drawable as it is, and closed by us: a `VideoFrame` where the browser has WebCodecs, else an `ImageBitmap`. */
  picture: ImageBitmap | VideoFrame;
  close: () => void;
  closed: boolean;
  /** What was decoded, which is what the canvas is sized to. */
  width: number;
  height: number;
  /** And what the file itself holds, which is what a reader is told. */
  naturalWidth: number;
  naturalHeight: number;
  /** Clockwise display turn carried by AVIF; bitmap decodes already apply it. */
  rotation: 0 | 90 | 180 | 270;
}

const held = new Map<string, Decoded>();
const inFlight = new Map<string, { work: Promise<Decoded>; abort: AbortController }>();

// The uncapped frames behind a zoom, by the same source as the frame each magnifies.
const detailHeld = new Map<string, Decoded>();
const detailInFlight = new Map<string, { work: Promise<Decoded>; abort: AbortController }>();

export function decodedFrame(source: string): Decoded | undefined {
  return held.get(source);
}

/**
 * The shape of the file behind a blob, read from its header rather than its pixels.
 *
 * `onload` is the browser having parsed enough to lay the image out, which is the size and
 * not the picture; nothing paints this one, so nothing decodes it. It is how the size a
 * reader is shown stays the file's own after the frame itself has been decoded smaller - and
 * how a rendition already smaller than the cap is not asked to be scaled *up* to it.
 */
async function shapeOf(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const probe = new Image();
    probe.src = url;
    await new Promise<void>((resolve, reject) => {
      probe.onload = () => resolve();
      probe.onerror = () => reject(new Error('unreadable'));
    });
    return { width: probe.naturalWidth, height: probe.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes one frame, through WebCodecs where the browser has it.
 *
 * **`createImageBitmap` is not a way to open an HDR rendition.** It colour-manages as it
 * decodes and hands back something already tone mapped to SDR white, so the headroom the
 * render exists for is gone before any canvas sees it, whatever that canvas is configured
 * as. `ImageDecoder` hands back a `VideoFrame`, which carries its own primaries and transfer
 * function - the same thing that lets a browser show HDR video - and drawing one into an
 * extended-range surface keeps them (`drawInto`). It also decodes to a size, and closing it
 * genuinely stops work that is still running, which a bitmap decode gives no way to do.
 */
async function decodePicture(
  blob: Blob,
  natural: { width: number; height: number },
  signal: AbortSignal,
  cap = DECODE_CAP,
  cropped = false,
): Promise<Pick<Decoded, 'picture' | 'close' | 'width' | 'height' | 'rotation'>> {
  const longest = Math.max(natural.width, natural.height);
  const scale = longest === 0 || longest <= cap ? 1 : cap / longest;
  const width = Math.round(natural.width * scale);
  const height = Math.round(natural.height * scale);

  if (WebCodecs != null) {
    try {
      const bytes = await blob.arrayBuffer();
      const rotation = avifRotation(bytes, blob.type);
      const decoder = new WebCodecs({
        data: bytes,
        type: blob.type,
        ...(scale === 1 ? {} : { desiredWidth: width, desiredHeight: height }),
      });
      signal.addEventListener('abort', () => decoder.close(), { once: true });
      const { image } = await decoder.decode();
      // A frame the camera turned is stored one way and shown another, and only the second is
      // a coordinate anyone here can name. Drawing it whole is fine - every path applies the
      // turn - but a *sub-rectangle* of one is not: `drawImage` reads the rect against the
      // stored pixels, so asking for the middle of a portrait photograph returns a stretched
      // piece of somewhere else. Measured on a 9504x6336 camera JPEG shown as 6336x9504.
      //
      // So a caller that is going to crop gets a bitmap instead, whose pixels are the turned
      // ones and whose rects therefore mean what they say.
      const turned = rotation !== 0 || image.codedWidth !== image.displayWidth || image.codedHeight !== image.displayHeight;
      if (!cropped || !turned || planarLayout(image, rotation) != null) {
        return { picture: image, close: () => image.close(), width: image.displayWidth, height: image.displayHeight, rotation };
      }
      image.close();
    } catch (err) {
      // A file this decoder will not take - an unexpected media type, a codec it was built
      // without - is not a file the server is missing, and reported as one it would have the
      // viewer ask for a rendition to be built that is already there. Fall through and let
      // the bitmap decode have it.
      if (signal.aborted) throw err;
    }
  }

  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    ...(scale === 1 ? {} : { resizeWidth: width, resizeQuality: 'high' }),
  });
  return { picture: bitmap, close: () => bitmap.close(), width: bitmap.width, height: bitmap.height, rotation: 0 };
}

/**
 * Fetches and decodes one frame, at most once per URL.
 *
 * `whole` for a stage that is zoomed in, where [`decodeDetail`] then answers from this same
 * decode rather than decoding the file a second time.
 */
export async function decodeFrame(source: string, whole = false): Promise<Decoded> {
  return whole ? decodedAt(source, held, inFlight, Infinity, true) : decodedAt(source, held, inFlight, DECODE_CAP);
}

/** Every pixel of the file, in rects that mean what they say (`decodePicture`'s `cropped`). */
function holdsEveryPixel(frame: Decoded): boolean {
  const { picture } = frame;
  const turned =
    typeof VideoFrame === 'function' &&
    picture instanceof VideoFrame &&
    (frame.rotation !== 0 || picture.codedWidth !== picture.displayWidth || picture.codedHeight !== picture.displayHeight) &&
    planarLayout(picture, frame.rotation) == null;
  return !turned && frame.width === frame.naturalWidth && frame.height === frame.naturalHeight;
}

/**
 * The same file at its own pixels, for a reader who has zoomed past what the fitted frame
 * shows.
 *
 * Uncapped, which is the point of it: what a reader reaches at 100% is the file, and a cap
 * here is a cap on that. Nothing uploads the whole of it - the GPU path takes the drawn region
 * out with `copyTo`, and a frame too large to import is drawn through the 2D path instead
 * (`drawInto`) - so the size that matters is the screen's, not the file's.
 *
 * Answered by the stage's own frame where that already holds every pixel, which an AVIF always
 * does: its decoder ignores the size it is asked for.
 *
 * Otherwise kept apart from [`decodeFrame`]'s cache for as long as a stage names the source
 * zoomable ([`keepOnly`]), not only while a layer is drawing it, so a rendition flipped away
 * from and back to is not decoded twice. A layer with nothing to add any more drops it sooner
 * with [`releaseDetail`].
 */
export async function decodeDetail(source: string): Promise<Decoded> {
  const fitted = held.get(source);
  if (fitted != null && holdsEveryPixel(fitted)) return fitted;
  const whole = await decodedAt(source, detailHeld, detailInFlight, Infinity, true);
  // Landed after the reader stepped away, which no later `keepOnly` is certain to sweep.
  if (![...holders.values()].some((each) => each.zoomable.has(source))) releaseDetail(source);
  return whole;
}

/**
 * Drops one source's detail frame, which is held only while a reader is inside a photograph.
 *
 * By source rather than outright: stack triage shows two stages at once, and each mounts a
 * detail layer that releases what it is not using - so a bare clear would have either stage
 * closing the other's frame and aborting its decode, simply by being mounted.
 */
export function releaseDetail(source: string): void {
  const held = detailHeld.get(source);
  if (held != null) {
    closeDetail(held);
    detailHeld.delete(source);
  }
  const running = detailInFlight.get(source);
  if (running != null) {
    running.abort.abort();
    detailInFlight.delete(source);
  }
}

// Marked before it is closed, exactly as `keepOnly` does: a draw that started before this and
// resolves after it reads the flag, and drawing a closed frame is an invalid texture rather
// than an exception - so without it the failure is a blank canvas and a console full of GPU
// validation errors.
function closeDetail(decoded: Decoded): void {
  decoded.closed = true;
  decoded.close();
}

function decodedAt(
  source: string,
  store: Map<string, Decoded>,
  running: Map<string, { work: Promise<Decoded>; abort: AbortController }>,
  cap: number,
  cropped = false,
): Promise<Decoded> {
  const already = store.get(source);
  if (already != null) return Promise.resolve(already);
  const inProgress = running.get(source);
  if (inProgress != null) return inProgress.work;

  const abort = new AbortController();
  const work = (async (): Promise<Decoded> => {
    // Every way this ends because *we* dropped it reads as `superseded`, which is the one
    // rejection a caller is meant to shrug off. A fetch cancelled mid-flight rejects with
    // the abort long before the check below is reached, and told apart by message alone
    // that arrives as a frame the server could not give us: the stage marks it failed and
    // stops mounting it, so a rendition the page abandoned for a beat - the flip away and
    // back that the picker is for - is one it will not show again for the life of the page.
    const superseded = <T,>(err: unknown): T => {
      throw abort.signal.aborted ? new Error('superseded') : err;
    };
    const response = await fetch(source, { signal: abort.signal }).catch(superseded<Response>);
    if (!response.ok) throw new Error(`${response.status} for ${source}`);
    const blob = await response.blob().catch(superseded<Blob>);
    const natural = await shapeOf(blob).catch(superseded<{ width: number; height: number }>);
    const drawn = await decodePicture(blob, natural, abort.signal, cap, cropped).catch(
      superseded<Awaited<ReturnType<typeof decodePicture>>>,
    );
    // Abandoned while it was out: the reader has moved past this photograph, and holding it
    // would keep tens of megabytes for a picture nothing is going to draw.
    if (abort.signal.aborted) {
      drawn.close();
      throw new Error('superseded');
    }
    const decoded: Decoded = { ...drawn, closed: false, naturalWidth: natural.width, naturalHeight: natural.height };
    // Whatever was under this key goes with it. A second decode of one source is rare but
    // reachable (below), and overwriting silently would leave the first unreachable and open -
    // which is the whole file, held until the tab does.
    const stale = store.get(source);
    if (stale != null && stale !== decoded) {
      stale.closed = true;
      stale.close();
    }
    store.set(source, decoded);
    forget(running, source, abort);
    return decoded;
  })();

  running.set(source, { work, abort });
  work.catch(() => forget(running, source, abort));
  return work;
}

/**
 * Drops an entry only if it is still the one that put it there.
 *
 * A run that steps past a photograph and back starts a second decode of the same source while
 * the first is still unwinding its abort - and by key alone, the first's rejection then deletes
 * the *second's* entry. Untracked, it can no longer be aborted, every later ask starts another
 * decode of the same file, and each one that lands overwrites a frame nothing can close.
 */
function forget(
  running: Map<string, { work: Promise<Decoded>; abort: AbortController }>,
  source: string,
  abort: AbortController,
): void {
  if (running.get(source)?.abort === abort) running.delete(source);
}

/**
 * Draws a decoded frame into the canvas that shows it, at the widest range the browser gives.
 *
 * **Asked for on every frame, not only the HDR ones.** A rendition built HDR carries values
 * above SDR white, and an eight-bit `srgb` surface clamps them on the way in. Asking for the
 * wide surface unconditionally is what keeps one drawing path rather than a canvas for one
 * kind of file and an `<img>` for the other: SDR values occupy nought to one either way, so
 * nothing about an ordinary camera JPEG changes. Where the browser has neither, the
 * attributes are ignored and this is an ordinary 2D context.
 *
 * The attributes are read only the first time a context is asked for, so this is the only
 * place that asks.
 */
export async function drawInto(canvas: HTMLCanvasElement, frame: Decoded, region?: Region): Promise<void> {
  // Through the GPU where there is one, which is what carries an HDR rendition's headroom and
  // decodes the frame's own transfer function on the way (`stage_gpu.ts`). It answers for an
  // ordinary camera JPEG too: the curve and the primaries differ, the work does not.
  if (await paintExtended(canvas, frame.picture, region, frame.rotation)) return;
  // Otherwise plain and unconfigured, which is what a machine with no WebGPU shows: no colour
  // space asked for is no colour space converted to, so an SDR photograph comes out as the
  // `<img>` drew it, and the browser tone maps an HDR rendition on the way in rather than
  // clipping it - measured on a 1500-nit render, where a clip would blow the 2.9% of samples
  // above SDR white and this blows 0.04%.
  const flat = canvas.getContext('2d');
  // Null once the canvas has been configured for WebGPU, because a canvas holds one kind of
  // context for its whole life. Reported rather than skipped: `drawImage` silently doing
  // nothing leaves a blank canvas that the stage goes on to treat as a painted picture.
  if (flat == null) throw new Error('no drawable context');
  // To the canvas rather than at the frame's own size: the canvas is capped at what a browser
  // will allocate (`canvasSizeFor`), and a frame past that would otherwise be drawn corner-first
  // and cropped to the part that fitted.
  const bitmap = region != null && frame.rotation !== 0 && typeof VideoFrame === 'function' && frame.picture instanceof VideoFrame
    ? await createImageBitmap(frame.picture, { imageOrientation: 'from-image' })
    : null;
  try {
    const picture = bitmap ?? frame.picture;
    if (region == null) flat.drawImage(picture, 0, 0, canvas.width, canvas.height);
    else flat.drawImage(picture, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap?.close();
  }
}

const holders = new Map<string, { sources: ReadonlySet<string>; zoomable: ReadonlySet<string> }>();

/**
 * What one stage is holding, and by difference what nothing is.
 *
 * Explicit, because these are ours: a frame nobody closes is held until the tab goes, and at
 * tens of megabytes apiece a session that walks a few hundred photographs would keep every
 * one of them. By holder rather than outright, because stack triage's split shows two stages
 * at once and either one saying what it wants must not take the other's away.
 *
 * `zoomable` is the part of `sources` that keeps a [`decodeDetail`] frame: the photograph being
 * looked at, and not the neighbours held beside it, which would each keep a whole file.
 *
 * **Work in flight for a photograph nobody holds any more is abandoned, not awaited.** A
 * reader on the arrow key outruns the decoder, and a fetch and a decode still running for a
 * photograph they have already passed is the decoder not being available for the one they
 * are waiting on.
 */
export function keepOnly(holder: string, sources: readonly string[], zoomable: readonly string[] = []): void {
  holders.set(holder, { sources: new Set(sources), zoomable: new Set(zoomable) });
  const live = new Set<string>();
  const detailed = new Set<string>();
  for (const wanted of holders.values()) {
    for (const source of wanted.sources) live.add(source);
    for (const source of wanted.zoomable) detailed.add(source);
  }
  for (const [source, decoded] of held) {
    if (live.has(source)) continue;
    decoded.closed = true;
    decoded.close();
    held.delete(source);
  }
  for (const [source, running] of inFlight) {
    if (live.has(source)) continue;
    running.abort.abort();
    inFlight.delete(source);
  }
  for (const source of [...detailHeld.keys(), ...detailInFlight.keys()]) {
    if (!detailed.has(source)) releaseDetail(source);
  }
}

/** A stage has gone; whatever only it was holding goes with it. */
export function releaseHolder(holder: string): void {
  keepOnly(holder, []);
  holders.delete(holder);
}
