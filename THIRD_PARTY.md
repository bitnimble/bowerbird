# Third-party notices

Bowerbird itself is MIT (`LICENSE`). This file covers what is linked into the shipped
binaries under something else, which is the only place a licence other than MIT reaches a user.

## `lensdb` is LGPL-3, and statically linked

**`native/lensdb` reaches a reader still carrying a copyleft obligation of its own**, as do the
two components in the next section. It is the
lens geometry database (DESIGN §10.8), built on the `lensfun` crate - a pure-Rust port of
lensfun carrying lensfun's own database - which is LGPL-3.0-or-later code over CC BY-SA 3.0
data. A Rust dependency is compiled in, so the `librawshim` a reader installs is a **Combined
Work** under LGPL-3 §4 rather than a program that dynamically links one. (libstdc++ below is
GPL-3 and therefore copyleft too, but its Runtime Library Exception waives exactly this
obligation, which is why it needs no position taken.)

What §4 then asks of us is that a reader be able to relink the thing they were given against
their own modified `lensfun`. We are not yet doing that, and it is the open item here: the two
available routes are conveying `rawshim`'s object files or its rlib alongside the binary
(§4(d)(0)), or putting `lensdb` behind a shared library the app loads at run time (§4(d)(1)).
Shipping the source of `lensfun` and of `lensdb` unchanged satisfies §4(c) and (e) and is the
easy half; §4(d) is the half with a choice in it.

## LGPL components in this repository

- **rawler** (`native/vendor/dnglab`) - LGPL-2.1. The RAW decoder, compiled into `rawshim`.
- **samsung-frame-art** (`packages/samsung-frame-art`) - LGPL-3.0-only. A TypeScript port of
  samsungtvws's Frame TV art API, installed as its own package rather than imported by path, and
  shipped beside the desktop app's server bundle rather than inside it.

Beyond these and `lensdb`, nothing in the tree is copyleft without such an exception, and that is
a constraint rather than an observation. It
decided how the finished formats are read (DESIGN §7): both pure-Rust HEIC decoders on
crates.io - `heic` and `heic_decoder` - are AGPL-3 or a paid commercial licence, as is
`rav1d-safe`. So HEIC is `rust_h265` (MIT/Apache-2.0) behind an ISOBMFF reader of our own
(`native/heif`), and AVIF is the libavif already linked below on the server. `rav1d`
(BSD-2-Clause) cannot build for `wasm32-unknown-unknown`, so rawshim's browser build reads no AVIF;
it does build for `wasm32-wasip1-threads`, which is `native/avif_planes`, the AV1 decoder a browser
with no `ImageDecoder` gets (Safari). The remaining Rust and TypeScript dependencies are not listed
here: they are resolved from `Cargo.lock` and `bun.lock`, and all are permissive.

## The C libraries the server links

Server only: `rawshim`'s `renditions` feature is the one build that links C at all.

**Dynamic**, so the LGPL relink freedom is preserved by construction:

- **libaom**, **dav1d**, **sharpyuv** - libavif's codecs, the system's copies.
- **Highway**, **Brotli**, **Little-CMS** - libjxl's, likewise (`JPEGXL_FORCE_SYSTEM_*`).
- **The C++ standard library libjxl was built against**, which is whichever the target's own
  toolchain carries: **libstdc++** on Linux, GPL-3 with the GCC Runtime Library Exception,
  which is what makes linking it from a non-GPL binary permitted; **libc++** on macOS,
  Apache-2.0 with an LLVM exception; and on Windows the MSVC runtime, which is the linker's
  own and is named nowhere.

**Static**, both pinned by `scripts/get-lib*.ts` rather than taken from the distribution,
because a rendition and an export are bytes a reader keeps and which machine wrote them must
not be visible in them:

- **libavif** 1.4.2 - BSD-2-Clause. Every rendition and the gain map beside it.
- **libjxl** 0.11.1 - BSD-3-Clause. The JXL arm of an export.

**The desktop app ships all of it.** `build:native` builds `rawshim` with its default features,
which include `renditions`, and `scripts/build-sidecar.ts` copies that library into the app's
resources for the bundled server to open. That is not incidental: a replica generates its own
tiles and renditions with no network at all, so it needs the build the server has.

**Android does not, and nor does a browser.** The Android shell links `rawshim` with
`default-features = false` and the wasm build passes `--no-default-features`; neither links any C,
and neither links `lensdb`, so the paragraph above about LGPL-3 reaches neither of them. The RAW
decoder is rawler, the demosaic and the grade are WGSL, and the JPEG codec either side is Rust.
The `src-tauri` shell binary itself depends on `rawshim` not at all - it starts the bundled
server, which is what opens the library above.
