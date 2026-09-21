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
# No ffmpeg either. Nothing serves through it: the still is written by libavif from a
# frame handed over as a pointer, and the twin Firefox needs is a rewrap of that same
# file, done in the browser. It survives in the `dev` stage below, where ffprobe reads
# an encode back with a decoder that is not ours.
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
# package covers AMD (RADV) and Intel (ANV). NVIDIA's driver comes from the host
# through nvidia-container-toolkit instead; what this image owes that arrangement is
# the block below. A box with no GPU renders, slowly, on SwiftShader, which the
# `swiftshader` stage fetches and `runtime` and `dev` carry.
#
# **lavapipe's manifest is deleted, so the loader never offers it.** It binds at most
# 128MiB of storage buffer and a 24MP frame is 144MB, so a container falling back to
# it would boot and then fail on every photograph. `gpu::device` refuses it too; this
# keeps the boot line honest.
#
# It is the largest thing here by far. Measured in the built image: libllvm19 at
# 127MB, mesa-vulkan-drivers at 81MB and libz3-4 at 27MB, so ~235MB installed. RADV
# links libLLVM, so that stays with the driver.
#
# The driver alone is not enough: the host's render node has to reach the container
# too, which is `devices:` and `group_add:` in the compose files.
# libaom3, libdav1d7 and libsharpyuv0 are named rather than left to arrive under libavif16, which
# is here for the `dev` stage's command-line tools: the binary links the pinned libavif statically
# and those three dynamically, so they are this image's dependency now and not that package's.
# libhwy1, libbrotli1 and liblcms2-2 are the same arrangement under the pinned libjxl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     liblensfun1 libavif16 libaom3 libdav1d7 libsharpyuv0 libhwy1 libbrotli1 liblcms2-2 \
     mesa-vulkan-drivers libegl1 \
  && rm /usr/share/vulkan/icd.d/lvp_icd.json \
  && rm -rf /var/lib/apt/lists/*

# **`libegl1` above is what makes NVIDIA's Vulkan work, and it looks like an OpenGL
# package.** Their ICD is a shim inside `libGLX_nvidia.so.0` that reaches the real driver
# by dlopening `libEGL.so.1` and asking GLVND for `glGetVkProcAddrNV`; with no libglvnd
# EGL in the image, `vk_icdNegotiateLoaderICDInterfaceVersion` answers
# `VK_ERROR_INITIALIZATION_FAILED` before it has looked at a device, and the container
# falls back to SwiftShader exactly as a host with no card does.
#
# That shim then needs GLVND pointed back at the NVIDIA vendor, and this manifest is the
# half nvidia-container-toolkit does not carry: it injects the Vulkan ICD manifest into
# /etc/vulkan/icd.d itself, but nothing puts an EGL vendor file anywhere. It names the
# library by soname, so on a host with no NVIDIA card the dlopen fails and GLVND falls
# through to the mesa vendor beside it.
RUN mkdir -p /usr/share/glvnd/egl_vendor.d \
  && printf '%s\n' \
      '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
    > /usr/share/glvnd/egl_vendor.d/10_nvidia.json

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

# The CPU Vulkan driver, through the same getter a machine with no GPU runs. A stage of its own
# rather than a step in `native`, so `dev` can carry it without building the crate three times.
FROM base AS swiftshader
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/pinned.ts scripts/get-swiftshader.ts ./scripts/
RUN bun run scripts/get-swiftshader.ts

# The Slang compiler, on the same terms: one stage fetches the pinned build and the three
# that need it copy the tree, rather than each refetching it.
FROM base AS slangc
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/pinned.ts scripts/get-slangc.ts ./scripts/
RUN bun run scripts/get-slangc.ts

# What the tests and the maintainer's scripts need and the app does not
# (`docker-compose.dev.yml`): ffprobe, to read back what an encode produced with a
# decoder that is not ours, and the pair `scripts/hdr-demo-assets.ts` drives to build the
# HDR demo page's assets. ~200MB of ffmpeg for it, which is exactly why it is not in
# `base`.
#
# The purge used to take 192MB of Mesa and LLVM reached through ffmpeg -> libsdl2 ->
# libgl1, on the grounds that SDL2 only dlopen's libGL to open a window and a headless
# encode never does. **Most of that has to stay now.** `base` installs
# mesa-vulkan-drivers, RADV links libllvm19, and the tests in this stage decode real
# RAWs - which is a grade, which is a shader, which needs an adapter. Purging libllvm19
# or mesa-libgallium here takes the AMD driver with it.
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
COPY --from=swiftshader /app/native/rawshim/.swiftshader/libvk_swiftshader.so /app/native/rawshim/.swiftshader/vk_swiftshader_icd.json /usr/local/share/vulkan/icd.d/
# Outside /app, which the dev compose files mount the repo over: the checkout's own
# `native/rawshim/.slangc` is a symlink into the *host's* cache and dangles in here, so the
# Vite plugin that compiles the browser's shaders finds this one on PATH instead.
COPY --from=slangc /app/native/rawshim/.slangc /opt/slangc
ENV PATH="/opt/slangc/bin:${PATH}"

# Dependencies as a cacheable layer.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The pixel library (native/rawshim, DESIGN 10.4), built once per instruction set.
#
# Three builds, ~20MB each, because a shared object is a fraction of the toolchain
# that produces one: compiling on the host at startup was tried and cost 906MB of
# image to ship 20MB of library. Measured, `x86-64-v4` captures the
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
#
# libavif and libjxl are not among them: the two `get-` scripts below build the pinned ones, and
# what they need from apt is the libraries underneath them and cmake to drive the builds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     liblensfun-dev libaom-dev libdav1d-dev libsharpyuv-dev cmake \
     libhwy-dev libbrotli-dev liblcms2-dev \
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
# The shaders, and the compiler that turns them into the WGSL `build.rs` `include_str!`s. **The
# crate does not compile without both** - not "renders differently", does not build - because every
# stage that produces a picture has one implementation and it is these files (§0.4).
COPY slang ./slang
COPY --from=slangc /app/native/rawshim/.slangc ./native/rawshim/.slangc
# `pinned.ts` for the two getters below: both record the version and the flags their tree was
# built with through it, and a stage that copies only the getter fails on
# `Cannot find module './pinned'` the first time anything builds this image.
COPY scripts/pinned.ts ./scripts/pinned.ts
# libavif, for the same reason and through the same arrangement: the pinned version is stated once,
# in the script a development machine runs. **apt's is too old to read a gain map** - trixie ships
# 1.1.1 with the API still behind the compile flag it was removed from in 1.2 - so an AVIF's
# highlights would depend on which machine opened it. Built against the system libaom and libdav1d
# installed above, so what a rendition *is* does not move with this.
COPY scripts/get-libavif.ts ./scripts/get-libavif.ts
RUN bun run scripts/get-libavif.ts
# libjxl, the same arrangement again. apt's is 0.7, which predates the encoder API settling in
# 0.10, so the same export request would produce a different file here than on a machine with a
# current one. Built against the system highway, brotli and lcms2 installed above.
COPY scripts/get-libjxl.ts ./scripts/get-libjxl.ts
RUN bun run scripts/get-libjxl.ts
# One target dir, emptied between levels. Changing target-cpu invalidates every
# artefact, so a dir per level caches nothing that three passes over one does not -
# it only holds all three at once, 2.5GB apiece, which a GitHub runner cannot fit.
RUN set -eu; \
  for level in x86-64 x86-64-v3 x86-64-v4; do \
    RUSTFLAGS="-C target-cpu=$level" cargo build --release \
      --manifest-path native/rawshim/Cargo.toml \
      --target-dir /build/target; \
    mkdir -p "/build/$level"; \
    mv /build/target/release/librawshim.so "/build/$level/librawshim.so"; \
    rm -rf /build/target; \
  done

# What PID 1 is, so that everything above this line can be replaced while the container
# keeps running (DESIGN §23.3). The same crate the desktop app supervises itself with,
# built here as its binary because there is no Tauri shell in a container to host it.
RUN cargo build --release --manifest-path native/launcher/Cargo.toml --target-dir /build/launcher

# The same crate again as wasm, which is what the editor ticks through in the
# browser (§0.4: one implementation, and this is it running on the other host).
# The web build imports the package directly, so it has to exist before vite runs.
#
# The release binary rather than `cargo install wasm-pack`, which builds it from
# source and costs minutes for a tool that publishes one.
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN rustup target add wasm32-unknown-unknown \
  && curl -sSfL https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz \
     | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-pack' \
  && bun run build:wasm \
  && rm -rf native/rawshim/target

# The web client, served by the bun server beside it in the final image.
#
# **The container publishes one port, and replication is why that matters.** A
# peer is dialled at the address a browser reaches it on (§9.1, §11.1) - so the
# address one device tells another to dial has to answer both the UI and /api.
# Shipping only the API leaves the one published address showing nothing, and the
# reader with no address to give the other device.
#
# **Two installs, because `web` is its own package with its own lockfile** - it is not
# a workspace of the root manifest, and vite, React and the plugins are only in its.
# The root install is what the client's type-only imports of the server's schemas
# resolve `zod` through; without the second, `bun run build` finds no vite.
#
# Full dependencies both times, unlike `deps`: none of the toolchain reaches the
# runtime stage, only the assets it produces.
FROM base AS web
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile
# The client imports the server's Zod schemas as types (web/src/api), so its build
# needs them present even though nothing of them survives into the bundle.
COPY src ./src
COPY web ./web
# Aliased by path in both vite.config.ts and web/tsconfig.json rather than
# resolved from node_modules, so it is source the build reads and not a
# dependency the install brings.
COPY packages ./packages
# The wasm decoder the editor ticks through. Its filenames are hashed into the
# bundle, so the package has to be there before vite resolves the import.
COPY --from=native /app/native/rawshim/pkg ./native/rawshim/pkg
# The browser's copy of the shaders, which is a build artefact and not committed: a Vite
# plugin runs `scripts/build-web-shaders.ts` from `buildStart`, so the config does not
# even *load* without that script, and the script does not run without the shaders and the
# pinned compiler.
COPY scripts ./scripts
COPY slang ./slang
COPY --from=slangc /app/native/rawshim/.slangc ./native/rawshim/.slangc
RUN cd web && bun run build

FROM base AS runtime
# **No `image.source` label here, deliberately.** GHCR reads it to attach the package to
# the repository, and a package with no repository behind it inherits none of its
# visibility or its README - but `docker/metadata-action` emits it, with the description
# and the licence, from the repository the release workflow is running in. That workflow is
# the only thing that pushes to GHCR, so writing this project's name here as well would be
# a second copy that a fork has to find (§23.8).
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# **Absolute, and that is load-bearing now.** Both default to a path relative to the
# working directory, and the working directory is the running version's own - so left
# unset, `docker run` with no compose file would put the catalogue inside the payload, and
# the first update would move the working directory and quietly start an empty one beside
# it. The two volumes `docker-compose.yml` mounts, which sets these to the same values.
ENV DB_PATH=/config/bowerbird.db
ENV DATA_DIR=/data
# Said outright rather than sniffed for. The image runs the same Linux a desktop build
# does and installs an entirely different file, so what an update means here - a new
# payload under /data, or `docker pull` - cannot be worked out from the kernel.
ENV BOWERBIRD_PLATFORM=docker-x86_64

# **Everything the app is lives under `payload/`, and nothing outside it does.** That
# directory is what an update replaces: `bowerbird-launcher` unpacks a newer one onto the
# data volume and runs that instead, and what is here is the version the image shipped
# with and the one a lost or broken update falls back to (DESIGN §23.3).
COPY --from=deps --chown=bun:bun /app/node_modules ./payload/node_modules
# The baseline keeps the plain name: it is the fallback the loader ends at, and the
# only one guaranteed to run.
COPY --from=native --chown=bun:bun /build/x86-64/librawshim.so ./payload/native/librawshim.so
COPY --from=native --chown=bun:bun /build/x86-64-v3/librawshim.so ./payload/native/librawshim.v3.so
COPY --from=native --chown=bun:bun /build/x86-64-v4/librawshim.so ./payload/native/librawshim.v4.so
# native/ stays writable rather than read-only: the entrypoint symlinks the variant
# it picked into it on every start.
COPY --chown=bun:bun native/entrypoint.sh native/verify_shim.ts native/report_gpu.ts ./payload/native/
RUN chmod +x ./payload/native/entrypoint.sh
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./payload/
COPY --chown=bun:bun src ./payload/src
COPY --chown=bun:bun assets/reference_frame.ARW ./payload/assets/reference_frame.ARW
RUN bun -e 'import { assertReferenceFrame } from "./payload/src/services/processing/renditions/reference_frame.ts"; assertReferenceFrame("./payload/assets/reference_frame.ARW")'
# `bun run restore` is the documented way back from a bad catalogue (§4.9), and the
# backups it reads are on a named volume inside this image's world. Left out, the
# only supported deployment is the one deployment that cannot restore its own
# backups, discovered during the outage that needs it.
COPY --chown=bun:bun scripts/restore-backup.ts ./payload/scripts/
# The built client, which this server serves at / (see index.ts). Assets only:
# the toolchain that produced them stays in the `web` stage.
COPY --from=web --chown=bun:bun /app/web/dist ./payload/web/dist
# Outside the payload, because it is the one thing an update must not be able to break:
# a supervisor replaced by the payload it supervises is a bad release with no way back.
COPY --from=native /build/launcher/release/bowerbird-launcher /app/bowerbird-launcher
# Where the loader looks by default, beside the hardware ICDs; the manifest names its library
# relative to itself.
COPY --from=swiftshader /app/native/rawshim/.swiftshader/libvk_swiftshader.so /app/native/rawshim/.swiftshader/vk_swiftshader_icd.json /usr/local/share/vulkan/icd.d/
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/libraries').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Everything the app writes lands on a bind mount - the photo library, its
# renditions, the Bin - and as root every one of those files arrives owned by root
# on the host, which is only discoverable after the fact and annoying to undo. uid
# 1000 is the `bun` user base creates and the usual first human account on a Linux
# host, so the common case needs no configuration; a host whose owner is not 1000
# overrides it with `user:` in the compose file.
USER bun
# So that `docker exec … bun run restore` (§4.9) lands where the scripts and the
# `node_modules` behind them are. Nothing about starting the app depends on it: the
# ENTRYPOINT is absolute, and the supervisor sets the working directory of the version it
# runs to that version's own directory.
WORKDIR /app/payload
# PID 1 is the supervisor, and the command below is what it runs - with `{payload}`
# replaced by whichever version is current, and that directory as the working directory,
# so the server resolves its own `node_modules` and its own pixel library rather than
# some other version's. `docker run … <anything>` still works: CMD is still the command.
#
# The versions live on the data volume rather than in the container's writable layer,
# which is the difference between an update that survives `docker compose up` and one
# that is silently rolled back by the next recreate.
ENTRYPOINT ["/app/bowerbird-launcher", "--home", "/data/updates", "--fallback", "/app/payload", "--"]
# The entrypoint tunes the pixel library and then execs the rest, which is why it is
# inside the payload: the variant it picks has to be the running version's.
CMD ["{payload}/native/entrypoint.sh", "bun", "run", "src/index.ts"]
