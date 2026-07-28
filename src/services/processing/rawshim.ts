import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';
import path from 'node:path';
import type { DecodedImage, OutputSpace } from './raw_decoder';

// The Rust wrapper around LibRaw (`native/rawshim`), built by `bun run build:native`.
//
// Decoding moved out of TypeScript for one reason: `params.half_size` has no setter
// in LibRaw's C API, and the FFI could only reach it by locating the struct at
// runtime and writing at an offset. That worked, and was checked from two
// directions, but "we believe this address is right" is a poor foundation for a
// field whose neighbours - `four_color_rgb`, `use_auto_wb` - silently change the
// picture when written to by mistake. bindgen resolves the field from the same
// headers the runtime library was built from, so the offset is the compiler's
// problem and stops being ours.
//
// It buys no speed. Measured against the TypeScript path it is 0.99x on a 61MP
// frame and 1.07x on a 24MP one, pixel-identical, because the time is inside
// LibRaw's unpack and demosaic either way. This is a correctness change.

const CANDIDATES = [
  // Next to the source tree in development, and where the Docker build stage puts it.
  path.join(import.meta.dir, '../../../native/rawshim/target/release/librawshim.so'),
  '/app/native/librawshim.so',
  'librawshim.so',
];

const SYMBOLS = {
  bb_decode: { args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  bb_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type Shim = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols'];

let cached: Shim | null = null;

function shim(): Shim {
  if (cached) return cached;
  let lastError: unknown;
  for (const candidate of CANDIDATES) {
    try {
      cached = dlopen(candidate, SYMBOLS).symbols;
      return cached;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `could not load librawshim (tried ${CANDIDATES.join(', ')}). Run \`bun run build:native\`. Last error: ${String(lastError)}`,
  );
}

// #[repr(C)] BbImage: u32 width, u32 height, u32 depth, 4 bytes padding, *mut u8
// data, usize len, u32 halved, 4 bytes padding, usize capacity.
const IMAGE = { width: 0, height: 4, depth: 8, data: 16, len: 24, halved: 32, size: 48 } as const;

/**
 * Decodes a RAW to an upright RGB bitmap.
 *
 * `atLeastLongEdge` is the longest edge the caller needs; where halving the frame
 * still clears it, the decode runs at half size, which is far cheaper. 0 means the
 * whole frame, which is what a native-resolution rendition requires.
 */
export function decodeViaShim(
  filePath: string,
  depth: 8 | 16,
  space: OutputSpace,
  atLeastLongEdge: number,
): DecodedImage {
  const S = shim();
  const handle = S.bb_decode(
    Buffer.from(`${filePath}\0`),
    depth,
    space === 'rec2020-linear' ? 1 : 0,
    Math.max(0, Math.floor(atLeastLongEdge)),
  );
  if (!handle) throw new Error(`rawshim could not decode ${filePath}`);

  try {
    const head = new DataView(toArrayBuffer(handle, 0, IMAGE.size));
    const length = Number(head.getBigUint64(IMAGE.len, true));
    const address = head.getBigUint64(IMAGE.data, true);
    // Copied rather than wrapped: the buffer belongs to Rust and is released
    // below, while the image outlives this call and is handed to sharp
    // asynchronously. A view would be a use-after-free waiting for a slow encode.
    const data = Buffer.from(new Uint8Array(toArrayBuffer(Number(address) as never, 0, length)));
    return {
      width: head.getUint32(IMAGE.width, true),
      height: head.getUint32(IMAGE.height, true),
      channels: 3,
      depth,
      data,
    };
  } finally {
    S.bb_free(handle);
  }
}
