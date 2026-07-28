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

# The Rust wrapper around LibRaw (native/rawshim, DESIGN §10.4). Built here rather
# than at runtime so the toolchain - rustc, cargo, and libclang for bindgen - stays
# out of the shipped image; only the ~400KB .so is copied forward.
#
# The portable x86-64 baseline, deliberately. `-C target-cpu=native` is worth 4-9%
# of a rendition job (DESIGN 10.4), but this stage may not run on the machine that
# runs the container, so taking it would mean compiling in the entrypoint: the whole
# toolchain in the runtime image and a compile error becoming a failure to start.
# `x86-64-v3` needs no such thing and is the obvious compromise, which is why it is
# worth naming as rejected: it captures a fifth of the gain and SIGILLs on the
# Goldmont Celerons that low-end NAS boxes - a likely host for this - ship with.
FROM base AS native
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential curl libclang-dev \
  && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
COPY native ./native
RUN cargo build --release --manifest-path native/rawshim/Cargo.toml

FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=native /app/native/rawshim/target/release/librawshim.so ./native/librawshim.so
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
