import type { GainTerms, PlanarPicture, PlanesLayout, Signal } from '../../../avif/avif_planes';

export interface HeifPicture {
  picture: PlanarPicture;
  rotation: 0 | 90 | 180 | 270;
  /** Its brightest light over diffuse white. */
  peak: number;
}

/** `heif_view::Span`. */
interface Span {
  offset: number;
  length: number;
}

/** `heif_view::Coded`. */
interface Coded extends Signal {
  width: number;
  height: number;
  grid: [number, number];
  tile: [number, number];
  config: Span;
  codec: string;
  tiles: Span[];
}

/** `heif_view::View`. */
interface View {
  base: Coded;
  gain:
    | ({ mode: 'iso'; map: Coded; brightest: number } & Omit<
        Extract<GainTerms, { mode: 'iso' }>,
        'mode'
      >)
    | { mode: 'apple'; map: Coded; headroom: number; brightest: number }
    | null;
  rotation: 0 | 90 | 180 | 270 | null;
  matrix: number[][];
  table: Span;
  unhandled: string | null;
}

/** A HEIC through this browser's own HEVC decoder, from `heifView`'s framing of it. */
export async function decodeHeifView(
  framed: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  textureEdge: number,
): Promise<HeifPicture> {
  const length = new DataView(framed.buffer, framed.byteOffset).getUint32(0, true);
  const view = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))) as View;
  const payload = framed.subarray(Math.ceil((4 + length) / 4) * 4);
  if (view.unhandled != null) throw new Error(view.unhandled);
  if (view.rotation == null) throw new Error('this HEIC is mirrored');
  if (Math.max(view.base.width, view.base.height) > textureEdge) {
    throw new Error(`this HEIC is past this device's ${textureEdge}px texture limit`);
  }
  const table = payload.slice(view.table.offset, view.table.offset + view.table.length);
  const base = await planesOf(view.base, payload, signal);
  const map = view.gain == null ? null : await planesOf(view.gain.map, payload, signal);
  const tableLight = new Float32Array(table.buffer);
  const { gain } = view;
  return {
    picture: {
      ...base,
      finish: {
        signal: signalOf(view.base),
        matrix: view.matrix,
        table: tableLight,
        gain:
          gain == null || map == null
            ? null
            : { picture: map, signal: signalOf(gain.map), terms: termsOf(gain) },
      },
    },
    rotation: view.rotation,
    peak: gain?.brightest ?? tableLight.reduce((brightest, light) => Math.max(brightest, light), 0),
  };
}

function signalOf({ kr, kb, fullRange, depth }: Coded): Signal {
  return { kr, kb, fullRange, depth };
}

function termsOf(gain: NonNullable<View['gain']>): GainTerms {
  if (gain.mode === 'apple') return { mode: 'apple', headroom: gain.headroom };
  const { min, max, gamma, offsetBase, offsetAlternate } = gain;
  return { mode: 'iso', min, max, gamma, offsetBase, offsetAlternate };
}

async function planesOf(
  coded: Coded,
  payload: Uint8Array,
  signal: AbortSignal,
): Promise<PlanarPicture> {
  signal.throwIfAborted();
  const at = ({ offset, length }: Span): Uint8Array => payload.subarray(offset, offset + length);
  const description = at(coded.config);
  const codec = await decodable(coded.codec, description);
  const decoded: { picture: PlanarPicture | null; failure: unknown; placed: number } = {
    picture: null,
    failure: null,
    placed: 0,
  };
  const fail = (err: unknown): void => {
    decoded.failure ??= err;
  };
  const copies: Promise<void>[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const copy = (async (): Promise<void> => {
        const picture = (decoded.picture ??= allocated(coded, frame.format));
        await placed(frame, picture, coded);
        decoded.placed += 1;
      })();
      copies.push(copy.catch(fail).finally(() => frame.close()));
    },
    error: fail,
  });
  const abandon = (): void => {
    if (decoder.state !== 'closed') decoder.close();
  };
  signal.addEventListener('abort', abandon, { once: true });
  try {
    decoder.configure({ codec, description, optimizeForLatency: true });
    coded.tiles.forEach((tile, index) =>
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: index, data: at(tile) })),
    );
    await decoder.flush();
  } catch (err) {
    fail(err);
  } finally {
    signal.removeEventListener('abort', abandon);
    abandon();
  }
  await Promise.all(copies);
  signal.throwIfAborted();
  if (decoded.failure != null) {
    const why =
      decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure);
    throw new Error(`${codec} at ${coded.width}x${coded.height}: ${why}`);
  }
  // A tile the decoder dropped without an error would otherwise be a black rectangle.
  if (decoded.picture == null || decoded.placed !== coded.tiles.length) {
    throw new Error(`this HEIC decoded ${decoded.placed} of its ${coded.tiles.length} tiles`);
  }
  return decoded.picture;
}

/** The record's own codec string, or plain Main for Main Still Picture, a subset some decoders refuse by name. */
async function decodable(declared: string, description: Uint8Array): Promise<string> {
  const candidates = [declared, declared.replace(/^hvc1\.3\.8\./, 'hvc1.1.6.')];
  for (const codec of new Set(candidates)) {
    const { supported } = await VideoDecoder.isConfigSupported({ codec, description });
    if (supported === true) return codec;
  }
  throw new Error(`this browser decodes no ${declared}`);
}

const PACKED_FORMATS = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX']);

// After every plane: Chromium sizes a `copyTo` plane as whole strides, so a tile right of the first
// column ends its last row past its plane, and is refused as "not large enough" at the buffer's end
// or as overlapping the next plane.
const COPY_SLACK_ROWS = 1;

// A string: the DOM types predate Chromium's high bit depth formats.
function allocated(coded: Coded, format: string | null): PlanarPicture {
  const { width, height } = coded;
  if (format != null && PACKED_FORMATS.has(format)) {
    return {
      samples: new Uint8Array(new SharedArrayBuffer(width * (height + COPY_SLACK_ROWS) * 4)),
      layout: {
        width,
        height,
        bits: 8,
        subsampled: false,
        planes: [{ offset: 0, stride: width * 4 }],
      },
    };
  }
  const bytes = format === 'I420P10' ? 2 : 1;
  const chromaWidth = Math.ceil(width / 2);
  const chromaRows = Math.ceil(height / 2) + COPY_SLACK_ROWS;
  const lumaStride = width * bytes;
  const lumaSize = lumaStride * (height + COPY_SLACK_ROWS);
  const chroma = chromaWidth * bytes;
  let planes: PlanesLayout['planes'];
  if (format === 'NV12') {
    planes = [
      { offset: 0, stride: lumaStride },
      { offset: lumaSize, stride: chroma * 2 },
    ];
  } else if (format === 'I420' || format === 'I420P10') {
    planes = [
      { offset: 0, stride: lumaStride },
      { offset: lumaSize, stride: chroma },
      { offset: lumaSize + chroma * chromaRows, stride: chroma },
    ];
  } else {
    throw new Error(`this HEIC decoded to ${format ?? 'an opaque'} frames`);
  }
  return {
    samples: new Uint8Array(new SharedArrayBuffer(lumaSize + chroma * chromaRows * 2)),
    layout: { width, height, bits: bytes === 2 ? 10 : 8, subsampled: true, planes },
  };
}

function placed(frame: VideoFrame, picture: PlanarPicture, coded: Coded): Promise<unknown> {
  const index = frame.timestamp;
  const [columns] = coded.grid;
  const [tileWidth, tileHeight] = coded.tile;
  const x = (index % columns) * tileWidth;
  const y = Math.floor(index / columns) * tileHeight;
  const width = Math.min(tileWidth, coded.width - x);
  const height = Math.min(tileHeight, coded.height - y);
  if (width <= 0 || height <= 0) return Promise.resolve();
  const bytes = picture.layout.bits > 8 ? 2 : 1;
  const [luma, ...chroma] = picture.layout.planes;
  const interleaved = chroma.length === 1 ? 2 : 1;
  const visible = frame.visibleRect ?? { x: 0, y: 0 };
  const rect = { x: visible.x, y: visible.y, width, height };
  if (chroma.length === 0) {
    return frame.copyTo(picture.samples, {
      rect,
      format: 'RGBA',
      colorSpace: packedSpace(frame.colorSpace),
      layout: [{ offset: luma!.offset + y * luma!.stride + x * 4, stride: luma!.stride }],
    });
  }
  return frame.copyTo(picture.samples, {
    rect,
    layout: [
      { offset: luma!.offset + y * luma!.stride + x * bytes, stride: luma!.stride },
      ...chroma.map((plane) => ({
        offset: plane.offset + (y / 2) * plane.stride + (x / 2) * bytes * interleaved,
        stride: plane.stride,
      })),
    ],
  });
}

/**
 * The space a hardware decoder's RGB frame is copied out in, which `copyTo` converts it into: the
 * frame's own, so its codes are the stream's for the table. Eight bits of RGB can hold neither a
 * PQ or HLG signal nor BT.2020's gamut, so those are refused and shown rendered.
 */
function packedSpace(space: VideoColorSpace): PredefinedColorSpace {
  // Strings: the DOM types predate the wide-gamut and HDR values Chromium reports.
  const primaries = String(space.primaries);
  const transfer = String(space.transfer);
  if (['pq', 'hlg', 'linear'].includes(transfer) || primaries === 'bt2020') {
    throw new Error(`this HEIC's ${primaries} ${transfer} frames have no 8-bit RGB`);
  }
  return primaries === 'smpte432' ? 'display-p3' : 'srgb';
}
