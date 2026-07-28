# Bowerbird backend. Every pixel operation goes through native/rawshim, which
# links LibRaw and libvips, so the image ships both as system libraries.
FROM oven/bun:1-debian AS base
WORKDIR /app

# libraw.so is dlopen'd at runtime (raw_decoder.ts, metadata.ts). The -dev package
# provides the unversioned libraw.so symlink the FFI loader resolves.
#
# libvips is the image library sharp used to bundle; rawshim links it directly,
# so it has to be present rather than arriving inside a node_modules prebuild.
# The -dev package is what the native stage compiles against, and the runtime
# stage inherits the same base layer, so one install serves both.
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
RUN apt-get update \
  && apt-get install -y --no-install-recommends libraw-dev libvips-dev ffmpeg libavif-bin \
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
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl libclang-dev \
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

COPY --from=deps /app/node_modules ./node_modules
# The baseline keeps the plain name: it is the fallback the loader ends at, and the
# only one guaranteed to run.
COPY --from=native /build/x86-64/release/librawshim.so ./native/librawshim.so
COPY --from=native /build/x86-64-v3/release/librawshim.so ./native/librawshim.v3.so
COPY --from=native /build/x86-64-v4/release/librawshim.so ./native/librawshim.v4.so
COPY native/entrypoint.sh native/verify_shim.ts ./native/
RUN chmod +x ./native/entrypoint.sh
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
EXPOSE 3000
# The entrypoint tunes the pixel library and then execs the command, so `docker run
# … <anything>` still works and the app remains PID 1's exec target.
ENTRYPOINT ["/app/native/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
