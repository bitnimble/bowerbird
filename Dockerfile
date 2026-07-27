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
RUN apt-get update \
  && apt-get install -y --no-install-recommends libraw-dev libjxl-tools \
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
