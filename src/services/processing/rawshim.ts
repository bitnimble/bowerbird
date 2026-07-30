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
  // The whole boundary for a rendition job: JSON in, JSON out, no addresses either
  // way. Returns the byte length of the reply, or how big a buffer it needs.
  bb_run_job: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  // Questions about pixels, for tests and pins. Same shape as bb_run_job.
  bb_for_testing_debug: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  // A response body on its way to a socket, copied into a buffer the caller owns
  // rather than handed over as an address (§10.4).
  bb_transcode_jpeg: {
    args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  // The camera's own preview, the same way.
  bb_extract_embedded: { args: [FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },

  // What the library will answer about a file without decoding it. Each fills a
  // struct or an array this side allocated.
  bb_read_header: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  bb_header_size: { args: [], returns: FFIType.u64 },
  // Stacking: descriptors in, group indices out, the whole walk in Rust (§19).
  bb_descriptor_size: { args: [], returns: FFIType.u64 },
  bb_stack_groups: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.f32, FFIType.i64, FFIType.ptr],
    returns: FFIType.i32,
  },

} as const;

type Shim = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols'];

let cached: Shim | null = null;

export function shim(): Shim {
  if (cached) return cached;
  // Every candidate's error, not just the last: a build that exists but is stale
  // fails on a missing symbol, and reporting only the last one blames the fallback
  // path for never having existed and hides the one that did.
  const failures: string[] = [];
  for (const candidate of CANDIDATES) {
    try {
      cached = dlopen(candidate, SYMBOLS).symbols;
      return cached;
    } catch (error) {
      failures.push(`  ${candidate}: ${String(error)}`);
    }
  }
  throw new Error(`could not load librawshim. Run \`bun run build:native\`. Tried:\n${failures.join('\n')}`);
}
