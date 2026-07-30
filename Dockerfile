# Bowerbird backend. Every pixel operation goes through native/rawshim, which links
# LibRaw, libvips and lensfun, so the image ships all three as system libraries.
#
# Debian rather than Alpine, which would save ~50MB of base: Alpine's `vips` package
# is built without libheif, so it has no `heifsave` and cannot write a single AVIF -
# which is every rendition this app produces. True on stable and on edge.
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
# stage and are installed there: libvips-dev alone drags 549MB of development tree
# (libicu-dev, perl, libhdf5-dev, libc6-dev) against 127MB for the library itself,
# and every byte of it was reaching the final image through this layer.
#
# libheif-plugin-aomenc is not optional and is easy to miss. Debian ships libheif's
# codecs as separate plugin packages, and libvips pulls in only the *decoders*
# (dav1d, libde265) - so without this the image reads AVIF perfectly and cannot
# write a single one, which is every rendition this app produces. It surfaces as
# `heifsave` returning an error and nothing more specific.
#
# ffmpeg applies the PQ transfer and encodes the HDR video (§10.7). It needs
# libzimg for the zscale filter, which is what applies the transfer, and
# libsvtav1 for the video. SVT-AV1 implements AV1 Profile 0 only, which is
# exactly what is wanted: 4:4:4 is Profile 1, which no hardware decoder will
# take, and the video exists to reach a hardware HDR path.
#
# libavif-bin provides avifenc for the HDR still, which is 4:4:4 and so cannot
# come from SVT-AV1. ffmpeg's own avif muxer writes no colr box, so it cannot
# tag one as HDR at all.
#
# liblensfun1 pulls its data package with it, and both halves are needed: the
# library is what rawshim links, and the ~4MB of XML under /usr/share/lensfun is
# where every lens profile lives. Without the data the database loads empty and
# every Canon frame silently falls back to fitting its own geometry - twice the
# time for a slightly worse grade, with nothing in the logs to say why.
#
# The purge is 192MB of Mesa and LLVM, reached only through ffmpeg -> libsdl2 ->
# libgl1. SDL2 is ffplay's video output and dlopen's libGL when it opens a window,
# which a headless encode never does. It runs in this RUN rather than a later one
# for the same layer reason as the dpkg excludes above. libgbm1 stays: libsdl2 has
# it as a real DT_NEEDED and ffmpeg will not start without it. Forcing past the
# dependency leaves apt unable to resolve anything until it is repaired, which is
# why the build stage below opens with --fix-broken.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libraw23t64 libvips42t64 liblensfun1 libheif-plugin-aomenc ffmpeg libavif-bin \
  && dpkg --force-depends --purge libllvm19 libz3-4 mesa-libgallium libgl1-mesa-dri libglx-mesa0 \
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
# dev compose file mounts an anonymous volume over node_modules, and a named one
# over /data in both; created against a root-owned path they arrive root-owned and
# the app cannot write its own database.
RUN mkdir -p /app/node_modules /app/web/node_modules /data && chown -R bun:bun /app /data

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
#
# --fix-broken first because base amputated Mesa and LLVM out from under packages
# that declare them, and apt refuses to resolve anything at all while that stands.
# It puts them back, which this stage wants anyway: bindgen goes through libclang,
# and libclang links libLLVM.
RUN apt-get update \
  && apt-get install -y --fix-broken \
  && apt-get install -y --no-install-recommends \
     libraw-dev libvips-dev liblensfun-dev \
     build-essential ca-certificates curl libclang-dev \
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
COPY --chown=bun:bun native/entrypoint.sh native/verify_shim.ts native/smoke_avif.ts ./native/
RUN chmod +x ./native/entrypoint.sh
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
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
