import { dlopen, FFIType } from 'bun:ffi';
import path from 'node:path';
import { Logger } from '../../../logger';

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
const LIB =
  process.platform === 'darwin'
    ? 'librawshim.dylib'
    : process.platform === 'win32'
      ? 'rawshim.dll'
      : 'librawshim.so';

// In order of preference, first hit wins.
const CANDIDATES = [
  ...(process.env.BOWERBIRD_NATIVE_LIB == null ? [] : [process.env.BOWERBIRD_NATIVE_LIB]),
  ...(process.env.BOWERBIRD_NATIVE_DIR == null
    ? []
    : [path.join(process.env.BOWERBIRD_NATIVE_DIR, LIB)]),
  // Next to the source tree, which is a development build and what a live-mounted
  // dev container sees. Ahead of the container paths so a local `bun run
  // build:native` is what runs, rather than something the image shipped.
  //
  // `quick` before `release`: `build:native` writes the first, and a `release` left over from a
  // packaging run would otherwise shadow every rebuild since.
  path.join(import.meta.dir, '../../../../native/rawshim/target/quick', LIB),
  path.join(import.meta.dir, '../../../../native/rawshim/target/release', LIB),
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
  bb_for_testing_debug: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
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
  // What a render allocates, kept for the next one between a hold and its release.
  bb_hold_render_memory: { args: [], returns: FFIType.void },
  bb_release_render_memory: { args: [], returns: FFIType.void },
  bb_upscalable: { args: [FFIType.cstring], returns: FFIType.i32 },
  // The upscaler model the app downloaded, by its manifest's and weights' paths.
  bb_hold_upscaler_model: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
  // A response body on its way to a socket, copied into a buffer the caller owns
  // rather than handed over as an address (§10.4).
  bb_transcode_jpeg: {
    args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  // The camera's own preview, the same way.
  bb_extract_embedded: {
    args: [FFIType.cstring, FFIType.u16, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  // The one call that writes into the caller's buffer instead of filling it: a scrub is
  // length-preserving, so the file goes in and comes back the same size (DESIGN §18.8).
  bb_scrub_exif: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
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
  // What the library had to say since it was last asked, newline-separated, each led by `I` or `W`
  // for its level. From the first call on it holds those lines for this rather than printing them.
  bb_take_log: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
} as const;

type Shim = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols'];

const log = new Logger('rawshim');
const LOG_BYTES = 64 * 1024;

let cached: Shim | null = null;

export function shim(): Shim {
  if (cached) return cached;
  // Every candidate's error, not just the last: a build that exists but is stale
  // fails on a missing symbol, and reporting only the last one blames the fallback
  // path for never having existed and hides the one that did.
  const failures: string[] = [];
  for (const candidate of CANDIDATES) {
    try {
      cached = drainingLog(dlopen(candidate, SYMBOLS).symbols);
      return cached;
    } catch (error) {
      failures.push(`  ${candidate}: ${String(error)}`);
    }
  }
  throw new Error(
    `could not load librawshim. Run \`bun run build:native\`. Tried:\n${failures.join('\n')}`,
  );
}

/** The same calls, each followed by moving the library's held lines into the server's log. */
function drainingLog(symbols: Shim): Shim {
  const buffer = new Uint8Array(LOG_BYTES);
  const drain = (): void => {
    for (;;) {
      const written = Number(symbols.bb_take_log(buffer, LOG_BYTES));
      if (written === 0) return;
      for (const line of new TextDecoder().decode(buffer.subarray(0, written)).split('\n')) {
        if (line.startsWith('I')) log.info(line.slice(1));
        else log.warn(line.slice(1));
      }
    }
  };
  drain();
  const wrapped = Object.fromEntries(
    Object.entries(symbols).map(([name, call]) => [
      name,
      (...args: unknown[]): unknown => {
        try {
          return Reflect.apply(call, undefined, args);
        } finally {
          drain();
        }
      },
    ]),
  );
  // Same keys, same signatures: only the entries' functions were wrapped.
  return wrapped as unknown as Shim;
}
