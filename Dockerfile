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

FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
