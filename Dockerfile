# Bowerbird backend. Every pixel operation goes through native/rawshim, which links
# libavif and lensfun, so the image ships both as system libraries. The RAW decoder is
# rawler and needs nothing installed.
#
# Debian rather than Alpine, which would save ~50MB of base. The original reason no
# longer holds - it was that Alpine's `vips` is built without libheif and so cannot
# write an AVIF, which stopped mattering when the encode moved to libavif and then
# libvips left entirely - so this is now inertia rather than a constraint. Alpine is
# untested; musl against lensfun is the part to check before trying it.
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
#
# **mesa-vulkan-drivers is not optional, and this image did not need it until the
# grade moved to the GPU.** The shaders are the only implementation of the grade -
# `tone.rs`'s was deleted, deliberately - so `job::run` refuses rather than falling
# back, and a container with no Vulkan driver builds no renditions at all. The
# package covers AMD (RADV), Intel (ANV) and lavapipe in one, so a box with no GPU
# still renders, slowly, off the CPU rasteriser. NVIDIA is its own arrangement -
# the proprietary driver plus nvidia-container-toolkit - and is not something an
# image can carry.
#
# It is the largest thing here by far. Measured in the built image: libllvm19 at
# 127MB, mesa-vulkan-drivers at 81MB and libz3-4 at 27MB, so ~235MB installed, most
# of it the LLVM that lavapipe is a JIT on top of. Dropping lavapipe would reclaim
# nearly all of it and leave a machine with no GPU unable to render anything, which
# is the trade this does not take.
#
# The driver alone is not enough: the host's render node has to reach the container
# too, which is `devices:` and `group_add:` in the compose files.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     liblensfun1 libavif16 mesa-vulkan-drivers \
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
# The purge used to take 192MB of Mesa and LLVM reached through ffmpeg -> libsdl2 ->
# libgl1, on the grounds that SDL2 only dlopen's libGL to open a window and a headless
# encode never does. **Most of that has to stay now.** `base` installs
# mesa-vulkan-drivers, lavapipe is an LLVM JIT built on mesa-libgallium, and the tests
# in this stage decode real RAWs - which is a grade, which is a shader, which needs an
# adapter. Purging libllvm19 or mesa-libgallium here removes exactly what the no-GPU
# runner falls back to.
#
# What is still GL and only GL goes: `libgl1-mesa-dri` and `libglx-mesa0` are the
# desktop GL and GLX paths, which no Vulkan ICD loads. libgbm1 stays for the same
# reason as before: libsdl2 has it as a real DT_NEEDED and ffmpeg will not start
# without it. Forcing past the dependency leaves apt unable to resolve anything in
# this stage until `--fix-broken` repairs it, so nothing may install after this line.
FROM base AS dev
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin \
  && dpkg --force-depends --purge libgl1-mesa-dri libglx-mesa0 \
  && rm -rf /var/lib/apt/lists/*

# Dependencies as a cacheable layer.
#
# `patches/` comes too, and has to: `package.json` names a `patchedDependencies` entry, and
# bun resolves that path at install time whether or not the package it patches is in the
# production tree. Without it every build of this image fails at this line with "Couldn't find
# patch file" - which is what it did from the commit that added the Tauri shell until the
# deployment was next built, this being the only stage that installs from a bare manifest.
FROM base AS deps
COPY package.json bun.lock ./
COPY patches ./patches
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
# The -dev half of what base installs. build.rs generates the lensfun and libavif
# bindings from these headers, so this stage has to inherit base rather than fork
# beside it: the generated field offsets are only right against the library the headers
# describe, and inheriting is what makes them the same package at the same version.
#
# The same four are what a development machine needs, and there is no substitute for
# any of them: without the -dev packages the crate does not link, and without
# libclang-dev bindgen cannot parse the headers it does have.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     liblensfun-dev libavif-dev \
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
# The shaders, which live in the page and are `include_str!`d by `gpu.rs`. **The crate does
# not compile without them** - not "renders differently", does not build - because the grade
# has one implementation and it is these files: the browser imports them and the native host
# compiles the same bytes (§0.4). So this stage needs a slice of `web/`, and the build failed
# here from the commit that moved the grade to the GPU until the image was next built.
#
# The directory rather than the tree: nothing else under `web/` is read at compile time, and
# copying more would rebuild this stage on every change to the page.
COPY web/src/features/raw_edit/gpu/wgsl ./web/src/features/raw_edit/gpu/wgsl
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
COPY --chown=bun:bun native/entrypoint.sh native/verify_shim.ts native/report_gpu.ts ./native/
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
