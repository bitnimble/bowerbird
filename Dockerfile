# Bowerbird backend. RAW decoding/metadata use LibRaw via bun:ffi, so the image
# ships libraw as a system library. sharp's prebuilt binaries bundle libvips.
FROM oven/bun:1-debian AS base
WORKDIR /app

# libraw.so is dlopen'd at runtime (raw_decoder.ts, metadata.ts). The -dev package
# provides the unversioned libraw.so symlink the FFI loader resolves.
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
  && apt-get install -y --no-install-recommends libraw-dev ffmpeg libavif-bin \
  && rm -rf /var/lib/apt/lists/*

# Dependencies as a cacheable layer.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The Rust wrapper around LibRaw (native/rawshim, DESIGN §10.4). Built here rather
# than at runtime so the toolchain - rustc, cargo, and libclang for bindgen - stays
# out of the shipped image; only the ~400KB .so is copied forward.
#
# Deliberately not `-C target-cpu=native`: this stage may not run on the machine
# that runs the container. Building in the entrypoint instead would allow it, at
# the cost of putting the whole toolchain in the runtime image and turning a
# compile error into a failure to start. Measured, the tuning is worth ~20% on one
# hot loop that is currently at parity with the TypeScript it replaced, so it is
# not worth either.
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
