import { dlopen, FFIType } from 'bun:ffi';
import path from 'node:path';

// The Rust library (`native/rawshim`), built by `bun run build:native`. Everything
// this app does to pixels happens in there, and it owns every decoded image for as
// long as TypeScript holds a handle to it.
//
// Decoding moved out of TypeScript because the half-size flag had no setter in the C API
// it lived behind, and the FFI could only reach it by locating the struct at runtime and
// writing at an offset. That worked, and was checked from two directions, but "we believe
// this address is right" is a poor foundation for a field whose neighbours silently change
// the picture when written to by mistake. There is no C decoder left to reach into.
//
// Everything else followed because the boundary was in the wrong place. The fit
// evaluates tens of candidate geometries, each warping, blurring, pairing and
// solving; running any part of that from TypeScript meant crossing the boundary
// inside the loop. Resize, decode and encode went with it - through libvips at
// first, which is the library sharp wrapped, so nothing about the output changed
// when they moved, and since through this side's own Rust.

// What this platform calls a shared library. A compiled server is the only build
// that ever runs anywhere but Linux, and it is told where to look rather than
// guessing, so this is for the message as much as for the search.
const LIB = process.platform === 'darwin' ? 'librawshim.dylib' : process.platform === 'win32' ? 'rawshim.dll' : 'librawshim.so';

// In order of preference, first hit wins.
const CANDIDATES = [
  // Where whatever started this server says it put it, which is how both shipped
  // deployments answer: the desktop shell unpacks the library as a resource, and the
  // container's entrypoint names the instruction-set variant that won its probe (§10.4).
  // Neither has a source tree to sit beside, and neither is at a path that can be
  // written down here - an updated install runs out of a version directory.
  ...(process.env.BOWERBIRD_NATIVE_LIB == null ? [] : [process.env.BOWERBIRD_NATIVE_LIB]),
  ...(process.env.BOWERBIRD_NATIVE_DIR == null ? [] : [path.join(process.env.BOWERBIRD_NATIVE_DIR, LIB)]),
  // Next to the source tree, which is a development build and what a live-mounted
  // dev container sees. Ahead of the container paths so a local `bun run
  // build:native` is what runs, rather than something the image shipped.
  //
  // `quick` before `release`: `build:native` writes the first, and a `release` left over from a
  // packaging run would otherwise shadow every rebuild since.
  path.join(import.meta.dir, '../../../../native/rawshim/target/quick/librawshim.so'),
  path.join(import.meta.dir, '../../../../native/rawshim/target/release/librawshim.so'),
  LIB,
];

const SYMBOLS = {
  // The whole boundary for a rendition job: JSON in, JSON out, no addresses either
  // way. Returns the byte length of the reply, or how big a buffer it needs.
  bb_run_job: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  // A job's one rendition, rendered by a client and handed over framed for this side to encode.
  // Replies as bb_run_job does.
  bb_write_rendered: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  // Questions about pixels, for tests and pins. Same shape as bb_run_job.
  bb_for_testing_debug: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  // One picture of a recipe, coded, for a client that will grade it itself. The same
  // shape as bb_run_job; what the reply *is* differs, and `ffi.rs` says how.
  bb_prepare_picture: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  bb_prepare_header_cap: { args: [], returns: FFIType.u64 },
  // How far the job counting itself right now has got, steps done over steps to do. Called from
  // the thread that is *not* inside `bb_run_job`, which is the only way to ask.
  bb_job_progress: { args: [], returns: FFIType.u64 },
  // Tells whatever job is running to stop at the next boundary it counts itself at. Called from
  // the same thread `bb_job_progress` is, and for the same reason.
  bb_cancel_job: { args: [], returns: FFIType.void },
  // A response body on its way to a socket, copied into a buffer the caller owns
  // rather than handed over as an address (§10.4).
  bb_transcode_jpeg: {
    args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  // The camera's own preview, the same way.
  bb_extract_embedded: { args: [FFIType.cstring, FFIType.u16, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  // An SDR base and its HDR twin as one file with the map between them (§10.5), and a
  // response body like the two above.
  bb_write_gain_map: {
    args: [
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.i32,
      FFIType.i32,
      FFIType.ptr,
      FFIType.u64,
    ],
    returns: FFIType.i64,
  },
  // A rendered AVIF re-encoded as PNG or TIFF, the same way.
  bb_export_still: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.f32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },

  // What the library will answer about a file without decoding it. Each fills a
  // struct or an array this side allocated.
  bb_read_header: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  bb_header_size: { args: [], returns: FFIType.u64 },
  // Stacking: descriptors in, group indices out, the whole walk in Rust (§19).
  bb_descriptor_size: { args: [], returns: FFIType.u64 },
  bb_descriptor_format: { args: [], returns: FFIType.u8 },
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
