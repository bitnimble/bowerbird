import init, { JxlImage } from 'jxl-oxide-wasm';
// `?url` so Vite emits the wasm as an asset and hands back its real path. Left
// to itself the loader resolves a relative URL that the dev server answers with
// index.html, and instantiation fails on the HTML it gets back. The subpath is
// `./module.wasm`, which is what the package's exports map publishes.
import wasmUrl from 'jxl-oxide-wasm/module.wasm?url';

// No browser decodes JPEG XL natively yet (Chrome 149's
// `ImageDecoder.isTypeSupported('image/jxl')` is false), so the full-resolution
// export is decoded here and handed to an <img> as a PNG blob.
//
// The transcode exists rather than painting to a canvas because an <img> keeps
// the browser's own colour management, HDR compositing and zoom/pan. A canvas
// would flatten to SDR: neither 2D nor WebGL2 accepts a rec2100-* colour space,
// only sRGB and display-p3.

// PNG cICP: colour primaries, transfer characteristics, matrix coefficients,
// full-range flag. 9/16/0/1 is BT.2020 + PQ, which Chrome honours - verified by
// rendering the same pixels with and without the chunk and reading back
// different values.
const CICP_BT2020_PQ = new Uint8Array([9, 16, 0, 1]);

let ready: Promise<unknown> | null = null;

// One instantiation per page. The wasm is ~1.6MB, so it is fetched on first use
// rather than at startup: most sessions never open a full-resolution view.
function load(): Promise<unknown> {
  ready ??= init({ module_or_path: wasmUrl });
  return ready;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Inserts a chunk directly after IHDR, where colour chunks must appear. Rebuilds
// only the header: the IDAT data is passed through untouched, so this costs
// nothing on a 100MB image.
function withCicp(png: Uint8Array, cicp: Uint8Array): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature, then IHDR length/type/body/crc
  if (png.length < ihdrEnd) return png;
  const inserted = chunk('cICP', cicp);
  const out = new Uint8Array(png.length + inserted.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(inserted, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + inserted.length);
  return out;
}

export interface LosslessImage {
  url: string;
  width: number;
  height: number;
  /** Whether the source declared an HDR transfer, so the PNG was tagged for it. */
  hdr: boolean;
  revoke: () => void;
}

// True when the ICC profile describes a PQ or HLG transfer. jxl-oxide hands back
// the profile it rendered into; an SDR image must not be tagged BT.2020/PQ or
// the browser will stretch it into HDR range.
function isHdrProfile(icc: Uint8Array): boolean {
  // ICC tag signatures for the parametric curves PQ and HLG carry these
  // four-byte marks; a plain sRGB profile has neither.
  const text = new TextDecoder('latin1').decode(icc.subarray(0, Math.min(icc.length, 4096)));
  return text.includes('PQ') || text.includes('HLG') || text.includes('2100');
}

export async function decodeLossless(url: string, signal?: AbortSignal): Promise<LosslessImage> {
  await load();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`could not fetch the full-resolution render (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  const image = new JxlImage();
  try {
    image.feedBytes(bytes);
    if (!image.tryInit()) throw new Error('the full-resolution render is incomplete');

    const render = image.render();
    try {
      const width = image.width ?? 0;
      const height = image.height ?? 0;
      // Read the profile before encoding: encodeToPng consumes the render, and
      // touching it afterwards is a null pointer into the wasm heap.
      const hdr = isHdrProfile(render.iccProfile);
      // jxl-oxide encodes to PNG in Rust and keeps the bit depth, so there is no
      // scanline or zlib work to do in JS.
      const png = render.encodeToPng();
      const tagged = hdr ? withCicp(png, CICP_BT2020_PQ) : png;
      const objectUrl = URL.createObjectURL(new Blob([tagged as BlobPart], { type: 'image/png' }));
      return { url: objectUrl, width, height, hdr, revoke: () => URL.revokeObjectURL(objectUrl) };
    } finally {
      // Already consumed by encodeToPng on the success path; free() is safe to
      // call again and matters when the encode threw.
      try {
        render.free();
      } catch {
        /* already released */
      }
    }
  } finally {
    image.free();
  }
}
