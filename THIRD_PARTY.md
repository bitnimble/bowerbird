# Third-party notices

Bowerbird itself is MIT (`LICENSE`). This file covers the C libraries that are linked into
the shipped binaries, which is the only place a licence other than MIT reaches a user.

Rust and TypeScript dependencies are not listed here: they are resolved from `Cargo.lock`
and `bun.lock`, and none is copyleft.

## lensfun and libavif

Server only, and the only two left: `rawshim`'s `renditions` feature links **lensfun**
(LGPL-3 library, CC BY-SA 3.0 database) and **libavif** (BSD-2-Clause). Both are dynamic
system packages in the Docker image, so the LGPL relink freedom is preserved by
construction.

Neither reaches a desktop or mobile build. Those link `rawshim` with
`default-features = false`, which links no C at all: the RAW decoder is rawler, the demosaic
and the grade are WGSL, and the JPEG codec either side is Rust.

LibRaw used to be here, in every build, and the CDDL election that permitted statically
linking it into the macOS and Android bundles was the most consequential licence decision in
this file. It is gone - rawler (LGPL-2.1, and a Rust dependency rather than a linked C
library) reads the RAWs now - and with it the libjpeg, Little-CMS and zlib archives the
static macOS link dragged along.
