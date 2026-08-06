# Bowerbird backend. Every pixel operation goes through native/rawshim, which links
# LibRaw, libavif and lensfun, so the image ships all three as system libraries.
#
# Debian rather than Alpine, which would save ~50MB of base. The original reason no
# longer holds - it was that Alpine's `vips` is built without libheif and so cannot
# write an AVIF, which stopped mattering when the encode moved to libavif and then
# libvips left entirely - so this is now inertia rather than a constraint. Alpine is
# untested; musl against LibRaw and lensfun is the part to check before trying it.
FROM debian:trixie-slim AS base
WORKDIR /app

# ~125MB of documentation, man pages and translations nothing in a container reads.
# Excluded at unpack time rather than deleted afterwards: a later RUN that deletes
# them leaves the bytes in the layer that installed them, so the image does not
# shrink.
RUN printf '%s\n' \
      'path-exclude /usr/share/doc/*' \
      'path-include /usr/share/doc/*/copyright' \
      'path-exclude /usr/share/man/*' \
      'path-exclude /usr/share/info/*' \
      'path-exclude /usr/share/locale/*' \
    > /etc/dpkg/dpkg.cfg.d/01-nodoc

# Runtime libraries only. The headers rawshim compiles against belong to the build
# stage and are installed there: a -dev tree drags hundreds of MB of libc6-dev, perl
# and friends that no runtime reads, and every byte of it was reaching the final image
# through this layer.
#
# No libvips, and dropping it took 29 packages out of the closure - ImageMagick,
# poppler, OpenEXR, HDF5, NSS, cfitsio and matio among them, ~34MB - for a library
# that by the end was decoding JPEG and reading back our own AVIFs. `jpeg.rs` does the
# first in pure Rust and libavif, already linked to write those files, does the second.
#
# No ffmpeg either, which used to apply the PQ transfer and encode the HDR video
# twin (§10.7). Nothing serves through it now: the still is written by libavif from
# a frame handed over as a pointer, and the twin Firefox needs is a rewrap of that
# same file, done in the browser. It survives in the `dev` stage below because the
# tests measure against it.
#
# libavif is what writes every AVIF, linked directly (`avif.rs`) - so the library
# rather than the binary. It cannot be ffmpeg's avif muxer instead, which writes no
# colr box and so cannot tag a still as HDR at all; that box is the whole reason
# libavif is here.
#
# liblensfun1 pulls its data package with it, and both halves are needed: the
# library is what rawshim links, and the ~4MB of XML under /usr/share/lensfun is
# where every lens profile lives. Without the data the database loads empty and
# every Canon frame silently falls back to fitting its own geometry - twice the
# time for a slightly worse grade, with nothing in the logs to say why.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libraw23t64 liblensfun1 libavif16 \
  && rm -rf /var/lib/apt/lists/*

# Bun's own image is Debian too, so the binary runs here unchanged and needs nothing
# but libc. Taking just the binary rather than building on oven/bun:1-debian drops
# that image's full-fat Debian base, 120MB against 78MB for slim.
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
# The parts of oven/bun's setup that outlive its base image: uid 1000 (see USER
# below), and the `node` shim packages shell out to.
RUN groupadd --gid 1000 bun \
  && useradd --uid 1000 --gid bun --shell /bin/sh --create-home bun \
  && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && mkdir -p /usr/local/bun-node-fallback-bin \
  && ln -s /usr/local/bin/bun /usr/local/bun-node-fallback-bin/node
ENV PATH="${PATH}:/usr/local/bun-node-fallback-bin"
ENV BUN_INSTALL_BIN=/usr/local/bin
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Owned by `bun` (uid 1000) here, in the stage every other one inherits, because a
# fresh Docker volume takes its ownership from the image directory it shadows. The
# dev compose file mounts named volumes over node_modules, and named ones over
# /config and /data in both; created against a root-owned path they arrive
# root-owned and the app can write neither its database nor a rendition.
RUN mkdir -p /app/node_modules /app/web/node_modules /config /data && chown -R bun:bun /app /config /data

# What the tests need and the app does not (`docker-compose.dev.yml`). ffprobe reads
# back what an encode produced, and avifenc is the reference the linked libavif path
# is pinned against - 300KB of binary behind ~200MB of ffmpeg, which is exactly why
# neither is in `base`.
#
# The purge is 192MB of Mesa and LLVM, reached only through ffmpeg -> libsdl2 ->
# libgl1. SDL2 is ffplay's video output and dlopen's libGL when it opens a window,
# which a headless encode never does. libgbm1 stays: libsdl2 has it as a real
# DT_NEEDED and ffmpeg will not start without it. Forcing past the dependency leaves
# apt unable to resolve anything in this stage until `--fix-broken` repairs it, so
# nothing may install after this line.
FROM base AS dev
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin \
  && dpkg --force-depends --purge libllvm19 libz3-4 mesa-libgallium libgl1-mesa-dri libglx-mesa0 \
  && rm -rf /var/lib/apt/lists/*

# Dependencies as a cacheable layer.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The pixel library (native/rawshim, DESIGN 10.4), built once per instruction set.
#
# Three builds, ~750KB each, because a shared object is four orders of magnitude
# smaller than the toolchain that produces one: compiling on the host at startup was
# tried and cost 906MB of image for a 750KB file. Measured, `x86-64-v4` captures the
# entire gain a `-C target-cpu=native` build on the host would - the win is AVX-512
# rather than any microarchitectural scheduling - so there is nothing left for a host
# compiler to find.
#
#   x86-64      the portable baseline; runs anywhere, including the Goldmont
#               Celerons in low-end NAS boxes, which have no AVX at all
#   x86-64-v3   AVX2, Haswell and Excavator onwards. ~5% of the grade stage
#   x86-64-v4   AVX-512. ~26% of the grade stage, ~8% of a rendition job
#
# The entrypoint picks between them by running each, so nothing here has to predict
# what the host supports.
FROM base AS native
# The -dev half of what base installs. build.rs generates the LibRaw bindings from
# these headers, so this stage has to inherit base rather than fork beside it: the
# generated field offsets are only right against the library the headers describe,
# and inheriting is what makes them the same package at the same version.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libraw-dev liblensfun-dev libavif-dev \
     build-essential ca-certificates curl git libclang-dev \
  && rm -rf /var/lib/apt/lists/*
# Downloaded to a file rather than piped into sh: in a pipeline the exit status is
# the *last* command's, so `curl ... | sh` reports success when curl fails and leaves
# a stage with no toolchain that only fails several steps later.
RUN curl --proto '=https' --tlsv1.2 -sSfo /tmp/rustup.sh https://sh.rustup.rs \
  && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable \
  && rm /tmp/rustup.sh
ENV PATH="/root/.cargo/bin:${PATH}"
COPY native ./native
# Separate target dirs: changing target-cpu invalidates every artefact anyway, so
# sharing one would rebuild the dependencies three times over rather than caching.
RUN set -eu; \
  for level in x86-64 x86-64-v3 x86-64-v4; do \
    RUSTFLAGS="-C target-cpu=$level" cargo build --release \
      --manifest-path native/rawshim/Cargo.toml \
      --target-dir "/build/$level"; \
  done

FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
# The baseline keeps the plain name: it is the fallback the loader ends at, and the
# only one guaranteed to run.
COPY --from=native --chown=bun:bun /build/x86-64/release/librawshim.so ./native/librawshim.so
COPY --from=native --chown=bun:bun /build/x86-64-v3/release/librawshim.so ./native/librawshim.v3.so
COPY --from=native --chown=bun:bun /build/x86-64-v4/release/librawshim.so ./native/librawshim.v4.so
# native/ stays writable rather than read-only: the entrypoint symlinks the variant
# it picked into it on every start.
COPY --chown=bun:bun native/entrypoint.sh native/verify_shim.ts ./native/
RUN chmod +x ./native/entrypoint.sh
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
# `bun run restore` is the documented way back from a bad catalogue (§4.9), and the
# backups it reads are on a named volume inside this image's world. Left out, the
# only supported deployment is the one deployment that cannot restore its own
# backups, discovered during the outage that needs it.
COPY --chown=bun:bun scripts/restore-backup.ts ./scripts/
EXPOSE 3000

# Everything the app writes lands on a bind mount - the photo library, its
# renditions, the Bin - and as root every one of those files arrives owned by root
# on the host, which is only discoverable after the fact and annoying to undo. uid
# 1000 is the `bun` user base creates and the usual first human account on a Linux
# host, so the common case needs no configuration; a host whose owner is not 1000
# overrides it with `user:` in the compose file.
USER bun
# The entrypoint tunes the pixel library and then execs the command, so `docker run
# … <anything>` still works and the app remains PID 1's exec target.
ENTRYPOINT ["/app/native/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
