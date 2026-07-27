# Bowerbird backend. RAW decoding/metadata use LibRaw via bun:ffi, so the image
# ships libraw as a system library. sharp's prebuilt binaries bundle libvips.
FROM oven/bun:1-debian AS base
WORKDIR /app

# libraw.so is dlopen'd at runtime (raw_decoder.ts, metadata.ts). The -dev package
# provides the unversioned libraw.so symlink the FFI loader resolves.
#
# libjxl-tools provides cjxl, which encodes the full-resolution export (§10.5).
# sharp/libvips has no JXL encoder, so this is a real runtime dependency rather
# than a build-time convenience.
#
# ffmpeg applies the PQ/HLG transfer and encodes the HDR video (§10.7). It needs
# libaom for AV1 and libzimg for the zscale filter; a build without either
# cannot produce them. libsvtav1 is not a substitute: it implements AV1 Profile
# 0 only, so it silently downsamples the 4:4:4 renditions to 4:2:0.
#
# libavif-bin provides avifenc, which encodes the HDR still. ffmpeg's own avif
# muxer writes no colr box, so it cannot tag one as HDR at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libraw-dev libjxl-tools ffmpeg libavif-bin \
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
