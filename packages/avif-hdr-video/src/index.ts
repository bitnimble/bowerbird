// HDR AVIF stills, shown in HDR on Firefox.
//
// Firefox composites HDR for video and only video (bug 1889288). Hand it a PQ AVIF and
// it decodes the file, ignores the transfer, and paints the code values as if they were
// sRGB: a washed-out picture rather than a refusal, so nothing in the page can even
// observe that it went wrong. The same bitstream in an MP4 goes down the video path and
// reaches the panel.
//
// So that is all this does - it moves the frame into an MP4 and puts a `<video>` where
// the `<img>` was. Nothing is decoded or re-encoded: AVIF *is* AV1, and both files are
// ISOBMFF, so the OBUs come out of the AVIF's item data, go into an `mdat`, and about
// 800 bytes of boxes are written around them. A 4K frame converts in about a
// millisecond.
//
//   import { install } from 'avif-hdr-video';
//   install();
//
// Everything below `install` is there for applications that own their own rendering:
// `hdrVideoUrl` for one image, `avifToMp4` for the bytes alone.

/** PQ and HLG, the two CICP transfer characteristics that mean an image is HDR. */
const HDR_TRANSFERS = new Set([16, 18]);

const SEQUENCE_HEADER = 1;
const TEMPORAL_DELIMITER = 2;

export interface InstallOptions {
  /** Which images to consider. Over-matching costs a cache hit, not a broken picture. */
  selector?: string;
  root?: ParentNode;
  fetchOptions?: RequestInit;
}

/** An ISOBMFF box, as offsets into the file it was read from. */
interface Box {
  type: string;
  /** First byte after the header, so the start of the payload. */
  body: number;
  end: number;
}

/** An AV1 OBU, as offsets into the bitstream it was read from. */
interface Obu {
  type: number;
  start: number;
  end: number;
}

/** Everything the MP4 needs, read out of an AVIF's boxes. */
interface Still {
  width: number;
  height: number;
  transfer: number;
  sample: Uint8Array;
  configuration: Uint8Array;
  colour: Uint8Array | null;
}

/**
 * Shows every HDR AVIF on the page through a `<video>`, on browsers that need it.
 *
 * Idempotent, and a no-op away from Firefox: everything else renders these files
 * correctly as images, which is better in every way that matters - no autoplay rules, no
 * media element per picture, and a decode the browser can throw away under pressure.
 *
 * Images are matched by `selector`, fetched, and left alone unless they turn out to be
 * an HDR AVIF, so a selector that over-matches costs a cache hit rather than a broken
 * picture. The `<video>` takes the `<img>`'s `id`, `class`, `style`, `width`, `height`
 * and `alt`, so CSS written for the image keeps applying - except rules that select
 * `img` by name.
 *
 * @returns a function undoing the swap and stopping the watch
 */
export function install(options: InstallOptions = {}): () => void {
  const { selector = 'img[data-hdr], img[src$=".avif"]', root = document, fetchOptions } = options;
  if (typeof window === 'undefined' || !needsHdrVideo()) return () => {};

  const swapped = new Map<HTMLImageElement, HTMLVideoElement>();
  const seen = new WeakSet<HTMLImageElement>();
  let live = true;

  const consider = (image: HTMLImageElement): void => {
    if (seen.has(image) || (image.currentSrc === '' && image.src === '')) return;
    seen.add(image);
    void replace(image, fetchOptions).then((video) => {
      if (video == null) return;
      if (!live) {
        restore(image, video);
        return;
      }
      swapped.set(image, video);
    });
  };

  for (const image of root.querySelectorAll<HTMLImageElement>(selector)) consider(image);

  // Pages add images after load, and a framework may point an existing one somewhere
  // else; both look the same from here, since a new `src` means the element has not been
  // considered for the file it now holds.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        seen.delete(record.target);
        consider(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement && node.matches(selector)) consider(node);
        for (const image of node.querySelectorAll<HTMLImageElement>(selector)) consider(image);
      }
    }
  });
  observer.observe(root instanceof Document ? root.documentElement : (root as Node), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset'],
  });

  return () => {
    live = false;
    observer.disconnect();
    for (const [image, video] of swapped) restore(image, video);
    swapped.clear();
  };
}

/**
 * An object URL for the MP4 twin of an AVIF, or null where the file is not HDR.
 *
 * The caller owns the URL and should `URL.revokeObjectURL` it once the element showing
 * it is gone; until then the MP4 is held in memory.
 */
export async function hdrVideoUrl(source: string, fetchOptions?: RequestInit): Promise<string | null> {
  const response = await fetch(source, fetchOptions);
  if (!response.ok) throw new Error(`${source}: ${response.status}`);
  const avif = new Uint8Array(await response.arrayBuffer());
  const still = describe(avif);
  if (!HDR_TRANSFERS.has(still.transfer)) return null;
  return URL.createObjectURL(new Blob([wrap(still)], { type: 'video/mp4' }));
}

/**
 * Rewraps an AVIF still as a one-frame MP4 carrying the same AV1 frame, ready for a Blob
 * and an object URL.
 *
 * Does not ask whether the file is HDR - an SDR AVIF converts just as well, it simply
 * has no reason to. Throws where the file is not a single-frame AVIF this can copy: a
 * grid (tiled) image, an item stored outside the file, or anything with no AV1
 * configuration.
 */
export function avifToMp4(avif: Uint8Array): Uint8Array {
  return wrap(describe(avif));
}

/**
 * Whether this browser needs any of the above to show an HDR still in HDR.
 *
 * A user-agent sniff, which is normally the wrong tool and is the only one available
 * here: the failure is that Gecko renders a PQ still *wrongly* rather than refusing it,
 * so there is nothing for a feature test to catch. `(dynamic-range: high)` answers a
 * different question, and answers it false on Firefox even on an HDR display.
 */
export function needsHdrVideo(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('Firefox');
}

/**
 * Puts a `<video>` of `image` in its place, where its file turns out to be HDR.
 *
 * The fetch comes first and the swap only follows a successful one, so an image that is
 * not an HDR AVIF - or a URL that fails, or a frame this cannot carry - is left exactly
 * as the page wrote it.
 */
async function replace(image: HTMLImageElement, fetchOptions?: RequestInit): Promise<HTMLVideoElement | null> {
  const source = image.currentSrc || image.src;
  let url: string | null;
  try {
    url = await hdrVideoUrl(source, fetchOptions);
  } catch {
    return null;
  }
  if (url == null) return null;
  // Gone, or pointed elsewhere, while the bytes were in flight.
  if (!image.isConnected || (image.currentSrc || image.src) !== source) {
    URL.revokeObjectURL(url);
    return null;
  }

  const video = image.ownerDocument.createElement('video');
  video.src = url;
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.setAttribute('disableremoteplayback', '');
  if (image.id !== '') video.id = image.id;
  if (image.className !== '') video.className = image.className;
  const style = image.getAttribute('style');
  if (style != null) video.setAttribute('style', style);
  for (const name of ['width', 'height']) {
    const value = image.getAttribute(name);
    if (value != null) video.setAttribute(name, value);
  }
  // A video is not in the accessibility tree the way an image is, so the description has
  // to be restated rather than carried.
  if (image.alt !== '') video.setAttribute('aria-label', image.alt);
  video.setAttribute('role', 'img');

  image.replaceWith(video);
  return video;
}

function restore(image: HTMLImageElement, video: HTMLVideoElement): void {
  if (video.isConnected) video.replaceWith(image);
  URL.revokeObjectURL(video.src);
}

function describe(avif: Uint8Array): Still {
  const view = new DataView(avif.buffer, avif.byteOffset, avif.byteLength);
  const meta = findBox(view, 0, avif.byteLength, 'meta');
  if (meta == null) throw new Error('not an AVIF: no meta box');
  // `meta` is a FullBox, so its children start after the version and flags.
  const children = meta.body + 4;
  const primary = primaryItem(view, children, meta.end);

  // Chiefly to reject `grid`, which is several coded frames the container assembles and
  // a one-sample video cannot express. Encoders write one for images past their tiling
  // threshold, so it is a size away rather than an exotic case.
  const kind = itemType(view, children, meta.end, primary);
  if (kind !== 'av01') throw new Error(`the primary item is '${kind}', not a single av01 frame`);

  const properties = itemProperties(view, children, meta.end, primary);
  const av1c = properties.find((property) => property.type === 'av1C');
  if (av1c == null) throw new Error('no av1C: the primary item is not an AV1 frame');
  const ispe = properties.find((property) => property.type === 'ispe');
  if (ispe == null) throw new Error('no ispe: the primary item declares no size');
  const colour = properties.find((property) => property.type === 'colr');

  const frame = itemData(view, children, meta.end, primary, avif);
  const units = obus(frame);
  const header = units.find((obu) => obu.type === SEQUENCE_HEADER);
  if (header == null) throw new Error('no sequence header in the frame');

  return {
    width: view.getUint32(ispe.body + 4),
    height: view.getUint32(ispe.body + 8),
    // The nclx payload is 'nclx', primaries, transfer, matrix, then the range bit.
    transfer: colour == null || fourcc(view, colour.body) !== 'nclx' ? 0 : view.getUint16(colour.body + 6),
    // Temporal delimiters are not allowed in an MP4 sample, and AVIF item data opens
    // with one.
    sample: concat(
      units.filter((obu) => obu.type !== TEMPORAL_DELIMITER).map((obu) => frame.subarray(obu.start, obu.end)),
    ),
    // The sequence header has to be in the configuration record and not merely in the
    // sample. AVIF leaves it in the item data - the file's own av1C is four bytes with
    // no configuration OBUs at all - and a player that reads only the record then starts
    // its decoder with no colour description, which is the difference between this
    // compositing in HDR and showing flat.
    configuration: concat([avif.subarray(av1c.body, av1c.end), frame.subarray(header.start, header.end)]),
    colour: colour == null ? null : avif.subarray(colour.body, colour.end),
  };
}

function wrap(still: Still): Uint8Array<ArrayBuffer> {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('av01'), ascii('iso2'), ascii('mp41'));
  const description = box(
    'stsd',
    fullHeader(0, 0),
    u32(1),
    box(
      'av01',
      visualSampleEntry(still.width, still.height),
      box('av1C', still.configuration),
      ...(still.colour == null ? [] : [box('colr', still.colour)]),
    ),
  );

  // Laid out twice because `stco` holds the absolute file offset of the sample, which is
  // not known until everything before it has a size. The field is fixed width, so the
  // second pass comes out the same length as the first.
  const sized = moov(description, still, 0);
  const at = ftyp.length + sized.length + 8;
  return concat([ftyp, moov(description, still, at), box('mdat', still.sample)]);
}

// One second at 1000 ticks. Any duration would do for a frame that never changes; a
// round one keeps the boxes readable.
const TIMESCALE = 1000;
const DURATION = 1000;

/** @param sampleAt absolute file offset of the sample */
function moov(description: Uint8Array, still: Still, sampleAt: number): Uint8Array {
  const header = box(
    'mvhd',
    fullHeader(0, 0),
    u32(0), // creation
    u32(0), // modification
    u32(TIMESCALE),
    u32(DURATION),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10),
    UNITY_MATRIX,
    zeros(24), // pre_defined
    u32(2), // next track id
  );

  const track = box(
    'trak',
    box(
      'tkhd',
      // Enabled and in the movie, which is what a player looks for before it will show
      // the track at all.
      fullHeader(0, 3),
      u32(0),
      u32(0),
      u32(1), // track id
      u32(0),
      u32(DURATION),
      zeros(8),
      u16(0), // layer
      u16(0), // alternate group
      u16(0), // volume, silent this being video
      u16(0),
      UNITY_MATRIX,
      u32(still.width * 0x10000),
      u32(still.height * 0x10000),
    ),
    box(
      'mdia',
      box(
        'mdhd',
        fullHeader(0, 0),
        u32(0),
        u32(0),
        u32(TIMESCALE),
        u32(DURATION),
        u16(0x55c4), // 'und'
        u16(0),
      ),
      box('hdlr', fullHeader(0, 0), u32(0), ascii('vide'), zeros(12), ascii('VideoHandler\0')),
      box(
        'minf',
        box('vmhd', fullHeader(0, 1), zeros(8)),
        box('dinf', box('dref', fullHeader(0, 0), u32(1), box('url ', fullHeader(0, 1)))),
        box(
          'stbl',
          description,
          box('stts', fullHeader(0, 0), u32(1), u32(1), u32(DURATION)),
          box('stsc', fullHeader(0, 0), u32(1), u32(1), u32(1), u32(1)),
          box('stsz', fullHeader(0, 0), u32(still.sample.length), u32(1)),
          box('stco', fullHeader(0, 0), u32(1), u32(sampleAt)),
        ),
      ),
    ),
  );

  return box('moov', header, track);
}

/** The fixed part of a VisualSampleEntry, up to where its child boxes begin. */
function visualSampleEntry(width: number, height: number): Uint8Array {
  return concat([
    zeros(6),
    u16(1), // data reference index
    zeros(16), // pre_defined and reserved
    u16(width),
    u16(height),
    u32(0x00480000), // 72dpi horizontal
    u32(0x00480000), // 72dpi vertical
    u32(0),
    u16(1), // frames per sample
    zeros(32), // compressor name
    u16(0x18), // depth: colour with no alpha
    u16(0xffff),
  ]);
}

const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

/** The item the AVIF calls the picture, or 1 where it does not say. */
function primaryItem(view: DataView, start: number, end: number): number {
  const pitm = findBox(view, start, end, 'pitm');
  if (pitm == null) return 1;
  return view.getUint8(pitm.body) === 0 ? view.getUint16(pitm.body + 4) : view.getUint32(pitm.body + 4);
}

/** What one item holds, as its `infe` four-character code. */
function itemType(view: DataView, start: number, end: number, item: number): string {
  const iinf = findBox(view, start, end, 'iinf');
  if (iinf == null) return 'av01';
  // A FullBox whose entry count is 16 or 32 bits by version, followed by the entries.
  const counted = view.getUint8(iinf.body) === 0 ? 2 : 4;
  for (const infe of boxes(view, iinf.body + 4 + counted, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const version = view.getUint8(infe.body);
    // Versions 0 and 1 have no item type at all, and predate anything that writes AVIF.
    if (version < 2) continue;
    const id = version === 2 ? view.getUint16(infe.body + 4) : view.getUint32(infe.body + 4);
    if (id === item) return fourcc(view, infe.body + 4 + (version === 2 ? 2 : 4) + 2);
  }
  return 'av01';
}

/** The bytes of one item, out of wherever `iloc` says they are. */
function itemData(view: DataView, start: number, end: number, item: number, file: Uint8Array): Uint8Array {
  const iloc = findBox(view, start, end, 'iloc');
  if (iloc == null) throw new Error('not an AVIF: no iloc box');
  const version = view.getUint8(iloc.body);
  let at = iloc.body + 4;
  const offsetSize = view.getUint8(at) >> 4;
  const lengthSize = view.getUint8(at) & 0xf;
  const baseOffsetSize = view.getUint8(at + 1) >> 4;
  const indexSize = version === 0 ? 0 : view.getUint8(at + 1) & 0xf;
  at += 2;
  const items = version < 2 ? view.getUint16(at) : view.getUint32(at);
  at += version < 2 ? 2 : 4;

  for (let i = 0; i < items; i += 1) {
    const id = version < 2 ? view.getUint16(at) : view.getUint32(at);
    at += version < 2 ? 2 : 4;
    let stored = 0;
    if (version === 1 || version === 2) {
      stored = view.getUint16(at) & 0xf;
      at += 2;
    }
    at += 2; // data reference index
    const base = integer(view, at, baseOffsetSize);
    at += baseOffsetSize;
    const extents = view.getUint16(at);
    at += 2;
    const parts: Uint8Array[] = [];
    for (let e = 0; e < extents; e += 1) {
      at += indexSize;
      const offset = integer(view, at, offsetSize);
      at += offsetSize;
      const length = integer(view, at, lengthSize);
      at += lengthSize;
      parts.push(file.subarray(base + offset, base + offset + length));
    }
    if (id !== item) continue;
    // 0 is "somewhere in this file", which is what every AVIF an encoder writes uses; 1
    // is the `idat` box and 2 is another file entirely.
    if (stored !== 0) throw new Error(`the frame is not stored in the file (construction method ${stored})`);
    return concat(parts);
  }
  throw new Error(`no location for item ${item}`);
}

/**
 * The properties associated with one item, in the order `ipma` lists them.
 *
 * Through `ipma` rather than by reading `ipco` straight through, because a file with an
 * alpha plane or a gain map holds several of each property and only the association says
 * which of them belongs to the picture.
 */
function itemProperties(view: DataView, start: number, end: number, item: number): Box[] {
  const iprp = findBox(view, start, end, 'iprp');
  if (iprp == null) return [];
  const ipco = findBox(view, iprp.body, iprp.end, 'ipco');
  const ipma = findBox(view, iprp.body, iprp.end, 'ipma');
  if (ipco == null || ipma == null) return [];
  const all = [...boxes(view, ipco.body, ipco.end)];

  const version = view.getUint8(ipma.body);
  const wide = (view.getUint32(ipma.body) & 1) === 1;
  let at = ipma.body + 4;
  const entries = view.getUint32(at);
  at += 4;
  for (let i = 0; i < entries; i += 1) {
    const id = version < 1 ? view.getUint16(at) : view.getUint32(at);
    at += version < 1 ? 2 : 4;
    const count = view.getUint8(at);
    at += 1;
    const indices: number[] = [];
    for (let a = 0; a < count; a += 1) {
      // The top bit marks a property as essential to reading the item, and the index is
      // what is left: 15 bits or 7, by a flag on the box.
      indices.push(wide ? view.getUint16(at) & 0x7fff : view.getUint8(at) & 0x7f);
      at += wide ? 2 : 1;
    }
    if (id !== item) continue;
    return indices.flatMap((index) => {
      const property = all[index - 1];
      return property == null ? [] : [property];
    });
  }
  return [];
}

/** Every OBU in a bitstream, as offsets into it. */
function obus(bytes: Uint8Array): Obu[] {
  // Through a view so a read past the end throws here rather than parsing `undefined`
  // into a plausible-looking OBU.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Obu[] = [];
  let at = 0;
  while (at < bytes.length) {
    const header = view.getUint8(at);
    const type = (header >> 3) & 0xf;
    let cursor = at + 1 + ((header >> 2) & 1);
    let length: number;
    if (((header >> 1) & 1) === 1) {
      const size = leb128(view, cursor);
      cursor = size.at;
      length = size.value;
    } else {
      // Only the last OBU may leave its size out, and then it runs to the end.
      length = bytes.length - cursor;
    }
    const end = cursor + length;
    if (end > bytes.length) throw new Error('an OBU runs past the end of the frame');
    found.push({ type, start: at, end });
    at = end;
  }
  return found;
}

function leb128(view: DataView, at: number): { value: number; at: number } {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    const byte = view.getUint8(at + i);
    // Multiplied rather than shifted: the fifth byte reaches bit 28 and JavaScript's
    // shift is a signed 32-bit operation, so a 256MB frame would come back negative.
    value += (byte & 0x7f) * 2 ** (i * 7);
    if ((byte & 0x80) === 0) return { value, at: at + i + 1 };
  }
  throw new Error('a length is longer than eight bytes');
}

/** The boxes directly inside a range, as offsets into the file. */
function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      // A 64-bit size, which nothing here writes and a large `mdat` may carry.
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) throw new Error(`a box at ${at} is ${size} bytes, which does not fit`);
    yield { type: fourcc(view, at + 4), body, end: at + size };
    at += size;
  }
}

function findBox(view: DataView, start: number, end: number, type: string): Box | null {
  for (const found of boxes(view, start, end)) {
    if (found.type === type) return found;
  }
  return null;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/** @param size in bytes; ISOBMFF allows 0, 4 and 8 */
function integer(view: DataView, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return view.getUint32(at);
  if (size === 8) return Number(view.getBigUint64(at));
  throw new Error(`unsupported field width: ${size} bytes`);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat([u32(8 + parts.reduce((total, part) => total + part.length, 0)), ascii(type), ...parts]);
}

function fullHeader(version: number, flags: number): Uint8Array<ArrayBuffer> {
  return u32((version << 24) | flags);
}

function u32(value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u16(value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function zeros(count: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(count);
}

function ascii(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
