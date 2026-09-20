# Third-party notices

Bowerbird itself is MIT (`LICENSE`). This file covers the C libraries that are linked into
the shipped binaries, which is the only place a licence other than MIT reaches a user.

Rust and TypeScript dependencies are not listed here: they are resolved from `Cargo.lock`
and `bun.lock`, and none is copyleft.

That last clause is a constraint rather than an observation, and it decided how the finished
formats are read (DESIGN §7). Both pure-Rust HEIC decoders on crates.io - `heic` and
`heic_decoder` - are AGPL-3 or a paid commercial licence, as is `rav1d-safe`. So HEIC is
`rust_h265` (MIT/Apache-2.0) behind an ISOBMFF reader of our own, and AVIF is the libavif already
linked below rather than `rav1d` (BSD-2-Clause), which cannot build for `wasm32-unknown-unknown`.

## The C libraries the server links

Server only: `rawshim`'s `renditions` feature is the one build that links C at all.

**Dynamic**, so the LGPL relink freedom is preserved by construction:

- **lensfun** - LGPL-3 library, CC BY-SA 3.0 database. The geometry the fit falls back on.
- **libaom**, **dav1d**, **sharpyuv** - libavif's codecs, the system's copies.
- **Highway**, **Brotli**, **Little-CMS** - libjxl's, likewise (`JPEGXL_FORCE_SYSTEM_*`).
- **libstdc++** - GPL-3 with the GCC Runtime Library Exception, which is what makes linking
  it from a non-GPL binary permitted.

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
`default-features = false` and the wasm build passes `--no-default-features`; neither links any C.
The RAW decoder is rawler, the demosaic and the grade are WGSL, and the JPEG codec either side is
Rust. The `src-tauri` shell binary itself depends on `rawshim` not at all - it starts the bundled
server, which is what opens the library above.
