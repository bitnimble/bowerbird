import { dlopen, FFIType } from 'bun:ffi';
import path from 'node:path';

// The Rust library (`native/rawshim`), built by `bun run build:native`. It wraps
// LibRaw and libvips - the two things this app does to pixels - and owns every
// decoded image for as long as TypeScript holds a handle to it.
//
// Decoding moved out of TypeScript because `params.half_size` has no setter in
// LibRaw's C API, and the FFI could only reach it by locating the struct at
// runtime and writing at an offset. That worked, and was checked from two
// directions, but "we believe this address is right" is a poor foundation for a
// field whose neighbours - `four_color_rgb`, `use_auto_wb` - silently change the
// picture when written to by mistake. bindgen resolves the field from the same
// headers the runtime library was built from, so the offset is the compiler's
// problem and stops being ours.
//
// Everything else followed because the boundary was in the wrong place. The fit
// evaluates tens of candidate geometries, each warping, blurring, pairing and
// solving; running any part of that from TypeScript meant crossing the boundary
// inside the loop. Resize, decode and encode go through libvips, which is the
// library sharp wrapped, so nothing about the output changed when they moved.

// In order of preference, first hit wins.
const CANDIDATES = [
  // Next to the source tree, which is a development build and what a live-mounted
  // dev container sees. Ahead of the container paths so a local `bun run
  // build:native` is what runs, rather than something the image shipped.
  path.join(import.meta.dir, '../../../native/rawshim/target/release/librawshim.so'),
  // The best of the image's instruction-set variants that this CPU proved it can
  // run, symlinked by the container entrypoint (§10.4). Absent when only the
  // baseline works, or when a variant was pinned to it.
  '/app/native/librawshim.selected.so',
  // The portable x86-64 build: the fallback, and the only one guaranteed to run.
  '/app/native/librawshim.so',
  'librawshim.so',
];

const SYMBOLS = {
  bb_decode: { args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  bb_decode_embedded: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.ptr },
  bb_extract_embedded: { args: [FFIType.cstring], returns: FFIType.ptr },
  bb_read_header: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  bb_hdr_argv: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.cstring, FFIType.cstring, FFIType.u32],
    returns: FFIType.ptr,
  },
  bb_hdr_options_size: { args: [], returns: FFIType.u64 },
  bb_fit_hdr: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  bb_hdr_colour_size: { args: [], returns: FFIType.u64 },
  bb_encode_hdr: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  bb_hdr_graded: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  bb_header_size: { args: [], returns: FFIType.u64 },
  bb_decode_file: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.ptr },
  bb_decode_image: { args: [FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.ptr },
  bb_image_from_rgb: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  bb_read_distortion_spline: { args: [FFIType.cstring, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  bb_fit: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  bb_fit_against: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  bb_render: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  bb_save_avif: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  bb_encode_jpeg: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.ptr },
  bb_free: { args: [FFIType.ptr], returns: FFIType.void },
  bb_buffer_free: { args: [FFIType.ptr], returns: FFIType.void },
  bb_profile_size: { args: [], returns: FFIType.u64 },
  bb_buffer_header_size: { args: [], returns: FFIType.u64 },
  bb_image_header_size: { args: [], returns: FFIType.u64 },
} as const;

type Shim = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols'];

let cached: Shim | null = null;

export function shim(): Shim {
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
