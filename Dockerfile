# Bowerbird backend. Every pixel operation goes through native/rawshim, which links
# libavif, libjxl and every codec under them statically. The RAW decoder is rawler
# and the lens database is `lensdb`; neither needs anything installed.
#
# Debian rather than Alpine, which would save ~50MB of base. The original reason no
# longer holds - it was that Alpine's `vips` is built without libheif and so cannot
# write an AVIF, which stopped mattering when the encode moved to libavif and then
# libvips left entirely - so this is now inertia rather than a constraint. Alpine is
# untested; musl against the codecs below is the part to check before trying it.
FROM debian:trixie-slim AS bun
ARG TARGETARCH
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  rm /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip
COPY .bun-version ./
# baseline: the amd64 build oven/bun's own image ships, for CPUs without AVX2
RUN case "$TARGETARCH" in amd64) build=x64-baseline ;; arm64) build=aarch64 ;; *) exit 1 ;; esac \
  && release="https://github.com/oven-sh/bun/releases/download/bun-v$(tr -d '[:space:]' < .bun-version)" \
  && curl -fsSL -O "$release/bun-linux-$build.zip" -O "$release/SHASUMS256.txt" \
  && grep " bun-linux-$build.zip\$" SHASUMS256.txt | sha256sum -c \
  && unzip -j "bun-linux-$build.zip" "*/bun" -d /usr/local/bin

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
# debian image's docker-clean would empty the apt cache mounts
RUN rm /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-downloads

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
#
# No codecs: `rawshim` links all of them statically (`codecs` below). libstdc++6 is named because
# libjxl and highway are C++, and the runtime they need is the one thing of theirs that stays
# dynamic - mesa happens to pull it in today, which is not a reason to rely on it.
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
     libstdc++6 \
     mesa-vulkan-drivers libegl1 \
  && rm /usr/share/vulkan/icd.d/lvp_icd.json

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
# but libc. Taking just the binary rather than building on oven/bun's Debian image drops
# that image's full-fat Debian base, 120MB against 78MB for slim.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
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

# Every getter stage runs over a cache mount of its own, so an edit to a script that busts the
# layer still finds the tree it pinned there, by recipe, and fetches nothing. The mount is not
# in the image, so the link into it is swapped for a copy; and a build cancelled mid-fetch leaves
# its `makeOnce` lock behind, which the next one would wait an hour on.
FROM base AS swiftshader
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/get-swiftshader.ts ./scripts/
RUN --mount=type=cache,id=bowerbird-swiftshader,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-swiftshader.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.swiftshader)" \
  && rm native/rawshim/.swiftshader \
  && cp -a "$tree" native/rawshim/.swiftshader

# The print preview's HDR environments, which `hash-pkg.ts` serves beside the wasm module.
FROM base AS environments
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/get-environments.ts ./scripts/
RUN --mount=type=cache,id=bowerbird-environments,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-environments.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.environments)" \
  && rm native/rawshim/.environments \
  && cp -a "$tree" native/rawshim/.environments

# The upscaler's weights, which `src/upscale.rs` embeds as `src/pmrid.rs` does PMRID's.
FROM base AS upscaler
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/get-upscaler.ts ./scripts/
RUN --mount=type=cache,id=bowerbird-upscaler,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-upscaler.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.upscaler)" \
  && rm native/rawshim/.upscaler \
  && cp -a "$tree" native/rawshim/.upscaler

# The Slang compiler, on the same terms: one stage fetches the pinned build and the three
# that need it copy the tree, rather than each refetching it. Through vcpkg, like the codecs.
FROM base AS slangc
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl git tar unzip zip
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/vcpkg.ts scripts/android-ndk.ts scripts/get-slangc.ts ./scripts/
COPY native/rawshim/vcpkg ./native/rawshim/vcpkg
RUN --mount=type=cache,id=bowerbird-slangc,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-slangc.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.slangc)" \
  && rm native/rawshim/.slangc \
  && cp -a "$tree" native/rawshim/.slangc

# The denoiser's published weights, which `src/pmrid.rs` embeds - so this is a file the crate does
# not compile without, on the same terms as the shaders. A stage of its own because the getter
# unpacks a checkpoint with `fflate`, which is a dev dependency: `deps` installs `--production` and
# so has none, and the build stage has no `node_modules` at all.
FROM base AS pmrid
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates
COPY package.json bun.lock ./
COPY packages/samsung-frame-art ./packages/samsung-frame-art
RUN --mount=type=cache,id=bowerbird-bun,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/get-pmrid.ts ./scripts/
RUN --mount=type=cache,id=bowerbird-pmrid,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-pmrid.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.pmrid)" \
  && rm native/rawshim/.pmrid \
  && cp -a "$tree" native/rawshim/.pmrid

# libavif, libjxl and the six libraries under them, static, through the getter a development
# machine runs: one vcpkg commit fixes every version (`get-codecs.ts`), so the aom a container
# encodes with is the aom every other build does. A stage of its own, copied into `native`, so that
# an edit to the crate does not rebuild aom: nothing here reads the crate.
#
# What vcpkg wants from apt and does not fetch itself on Linux: a compiler, git, nasm for aom and
# dav1d's assembly, python3 for dav1d's meson, pkg-config, and zip for its binary cache. cmake and
# ninja it downloads at the versions it pins.
FROM base AS codecs
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential ca-certificates curl git nasm pkg-config python3 tar unzip zip
COPY scripts/pinned.ts scripts/prune-pinned.ts scripts/vcpkg.ts scripts/android-ndk.ts scripts/get-codecs.ts ./scripts/
COPY native/rawshim/vcpkg ./native/rawshim/vcpkg
RUN --mount=type=cache,id=bowerbird-codecs,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run scripts/get-codecs.ts \
  && bun run scripts/prune-pinned.ts \
  && tree="$(readlink native/rawshim/.codecs)" \
  && rm native/rawshim/.codecs \
  && cp -a "$tree" native/rawshim/.codecs

# What the tests and the maintainer's scripts need and the app does not
# (`docker-compose.dev.yml`): ffprobe, to read back what an encode produced with a
# decoder that is not ours, and the pair `scripts/demo-assets.ts` drives to build the
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
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin \
  && dpkg --force-depends --purge libgl1-mesa-dri libglx-mesa0
COPY --from=swiftshader /app/native/rawshim/.swiftshader/libvk_swiftshader.so /app/native/rawshim/.swiftshader/vk_swiftshader_icd.json /usr/local/share/vulkan/icd.d/
# Outside /app, which the dev compose files mount the repo over: the checkout's own
# `native/rawshim/.slangc` is a symlink into the *host's* cache and dangles in here, so the
# Vite plugin that compiles the browser's shaders finds this one on PATH instead.
COPY --from=slangc /app/native/rawshim/.slangc /opt/slangc
ENV PATH="/opt/slangc:${PATH}"

# Dependencies as a cacheable layer.
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/samsung-frame-art ./packages/samsung-frame-art
RUN --mount=type=cache,id=bowerbird-bun,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile --production

# The toolchain and the sources both builds of the crate read: the library below and
# the wasm package after it. What the crate needs from apt is a linker and libclang-dev,
# without which bindgen cannot parse the codecs' headers.
FROM base AS rust
RUN --mount=type=cache,id=bowerbird-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=bowerbird-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential ca-certificates curl git libclang-dev
# Downloaded to a file rather than piped into sh: in a pipeline the exit status is
# the *last* command's, so `curl ... | sh` reports success when curl fails and leaves
# a stage with no toolchain that only fails several steps later.
ENV PATH="/root/.cargo/bin:${PATH}"
COPY rust-toolchain.toml ./
RUN curl --proto '=https' --tlsv1.2 -sSfo /tmp/rustup.sh https://sh.rustup.rs \
  && sh /tmp/rustup.sh -y --profile minimal --default-toolchain none \
  && rustup toolchain install --profile minimal \
  && rm /tmp/rustup.sh
COPY native ./native
# The shaders, and the compiler that turns them into the WGSL `build.rs` `include_str!`s. **The
# crate does not compile without both** - not "renders differently", does not build - because every
# stage that produces a picture has one implementation and it is these files (§0.4).
COPY slang ./slang
COPY --from=slangc /app/native/rawshim/.slangc ./native/rawshim/.slangc
COPY --from=pmrid /app/native/rawshim/.pmrid ./native/rawshim/.pmrid
COPY --from=upscaler /app/native/rawshim/.upscaler ./native/rawshim/.upscaler
COPY --from=environments /app/native/rawshim/.environments ./native/rawshim/.environments

FROM rust AS native
COPY --from=codecs /app/native/rawshim/.codecs ./native/rawshim/.codecs
RUN --mount=type=cache,id=bowerbird-cargo-registry,target=/root/.cargo/registry \
    --mount=type=cache,id=bowerbird-native-target,target=/build/target \
  RUSTFLAGS="-C target-cpu=x86-64" cargo build --release \
    --manifest-path native/rawshim/Cargo.toml \
    --target x86_64-unknown-linux-gnu \
    --target-dir /build/target \
  && cp /build/target/x86_64-unknown-linux-gnu/release/librawshim.so /build/librawshim.so

# The same crate again as wasm, which is what the editor ticks through in the
# browser (§0.4: one implementation, and this is it running on the other host).
# The web build imports the package directly, so it has to exist before vite runs.
#
# The release binary rather than `cargo install wasm-pack`, which builds it from
# source and costs minutes for a tool that publishes one.
FROM rust AS wasm-build
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN rustup target add wasm32-unknown-unknown wasm32-wasip1-threads \
  && curl -sSfL https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz \
     | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-pack' \
  && bun run build:wasm \
  && rm -rf native/rawshim/target

# The package alone, so the release workflow can hand in the one its `wasm` job built
# (`--build-context wasm=native/rawshim/pkg`) and skip the stage above.
FROM scratch AS wasm
COPY --from=wasm-build /app/native/rawshim/pkg /

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
COPY packages/samsung-frame-art ./packages/samsung-frame-art
RUN --mount=type=cache,id=bowerbird-bun,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile
COPY web/package.json web/bun.lock ./web/
RUN --mount=type=cache,id=bowerbird-bun,target=/root/.bun/install/cache,sharing=locked \
  cd web && bun install --frozen-lockfile
# The client imports the server's Zod schemas as types (web/src/api), so its build
# needs them present even though nothing of them survives into the bundle.
COPY src ./src
COPY web ./web
# The page keys its precompiled pipelines on this (web/src/app/build_version.ts).
COPY VERSION ./VERSION
# Aliased by path in both vite.config.ts and web/tsconfig.json rather than
# resolved from node_modules, so it is source the build reads and not a
# dependency the install brings.
COPY packages ./packages
# The wasm decoder the editor ticks through. Its filenames are hashed into the
# bundle, so the package has to be there before vite resolves the import.
COPY --from=wasm / ./native/rawshim/pkg
# The browser's copy of the shaders, which is a build artefact and not committed: a Vite
# plugin runs `scripts/build-web-shaders.ts` from `buildStart`, so the config does not
# even *load* without that script, and the script does not run without the shaders and the
# pinned compiler.
COPY scripts ./scripts
COPY slang ./slang
COPY --from=slangc /app/native/rawshim/.slangc ./native/rawshim/.slangc
# Where a bug report goes (§18.8). A build argument rather than one of the runtime's
# variables below: it is compiled into the bundle here, and a container's environment is
# read long after that. A build given none hides the form.
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
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
# The two volumes `docker-compose.yml` mounts, which sets these to the same values. Absolute,
# so `docker run` with no compose file does not put the catalogue in the working directory.
ENV DB_PATH=/config/bowerbird.db
ENV DATA_DIR=/data
# Said outright rather than sniffed for. The image runs the same Linux a desktop build
# does, and is updated by pulling a new image rather than by anything it downloads.
ENV BOWERBIRD_PLATFORM=docker-x86_64

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=native --chown=bun:bun /build/librawshim.so ./native/librawshim.so
COPY --chown=bun:bun native/entrypoint.sh native/report_gpu.ts ./native/
RUN chmod +x ./native/entrypoint.sh
COPY --chown=bun:bun package.json bun.lock tsconfig.json VERSION ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun assets/reference_frame.ARW ./assets/reference_frame.ARW
RUN bun -e 'import { assertReferenceFrame } from "./src/services/processing/renditions/reference_frame.ts"; assertReferenceFrame("./assets/reference_frame.ARW")'
# `bun run restore` is the documented way back from a bad catalogue (§4.9), and the
# backups it reads are on a named volume inside this image's world. Left out, the
# only supported deployment is the one deployment that cannot restore its own
# backups, discovered during the outage that needs it.
COPY --chown=bun:bun scripts/restore-backup.ts ./scripts/
# The built client, which this server serves at / (see index.ts). Assets only:
# the toolchain that produced them stays in the `web` stage.
COPY --from=web --chown=bun:bun /app/web/dist ./web/dist
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
ENTRYPOINT ["/app/native/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
