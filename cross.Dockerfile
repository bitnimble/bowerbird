# `release:check`'s local cross-builds only. What users run is built natively per platform by
# `.github/workflows/release.yml`.
FROM debian:trixie-slim AS bun
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
COPY .bun-version ./
RUN case "$TARGETARCH" in amd64) build=x64-baseline ;; arm64) build=aarch64 ;; *) exit 1 ;; esac \
  && release="https://github.com/oven-sh/bun/releases/download/bun-v$(tr -d '[:space:]' < .bun-version)" \
  && curl -fsSL -O "$release/bun-linux-$build.zip" -O "$release/SHASUMS256.txt" \
  && grep " bun-linux-$build.zip\$" SHASUMS256.txt | sha256sum -c \
  && unzip -j "bun-linux-$build.zip" "*/bun" -d /usr/local/bin

FROM debian:trixie-slim AS base
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# node shim: the Tauri CLI shells out to node
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && mkdir -p /usr/local/bun-node-fallback-bin \
  && ln -s /usr/local/bin/bun /usr/local/bun-node-fallback-bin/node
ENV PATH="${PATH}:/usr/local/bun-node-fallback-bin"

FROM base AS cross
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl git unzip xz-utils zip \
  && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"
COPY rust-toolchain.toml ./
RUN curl --proto '=https' --tlsv1.2 -sSfo /tmp/rustup.sh https://sh.rustup.rs \
  && sh /tmp/rustup.sh -y --profile minimal --default-toolchain none \
  && rustup toolchain install --profile minimal \
  && rustup target add wasm32-unknown-unknown wasm32-wasip1-threads \
  && rm /tmp/rustup.sh

FROM cross AS source
COPY package.json bun.lock ./
COPY packages/samsung-frame-art ./packages/samsung-frame-art
# every platform's: a cross-built sidecar ships the target's libSQL and Parcel addons
RUN bun install --frozen-lockfile --os='*' --cpu='*'
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile
COPY . .
# the cache mount is not in the image, so each link becomes a copy
RUN --mount=type=cache,id=bowerbird-cross-pinned,target=/root/.cache,sharing=locked \
  rm -f /root/.cache/bowerbird/*/*.lock \
  && bun run get:shell \
  && bun run scripts/prune-pinned.ts \
  && for name in slangc pmrid environments; do \
       tree="$(readlink "native/rawshim/.$name")" \
       && rm "native/rawshim/.$name" \
       && cp -a "$tree" "native/rawshim/.$name" || exit 1; \
     done

FROM cross AS android
# The codecs' vcpkg build, and bindgen for `rawshim`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config python3 libclang-dev cmake \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/jdk \
  && curl -sSfLo /tmp/jdk.tar.gz https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse \
  && tar -xzf /tmp/jdk.tar.gz -C /opt/jdk --strip-components=1 \
  && rm /tmp/jdk.tar.gz
ENV JAVA_HOME=/opt/jdk
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="/opt/jdk/bin:/opt/android-sdk/cmdline-tools/latest/bin:${PATH}"
COPY .android-ndk-version ./
RUN curl -sSfo /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
  && unzip -q /tmp/tools.zip -d /tmp/tools \
  && mkdir -p "$ANDROID_HOME/cmdline-tools" \
  && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
  && rm -rf /tmp/tools.zip /tmp/tools \
  && yes | sdkmanager --licenses > /dev/null \
  && sdkmanager --install platform-tools "ndk;$(tr -d '[:space:]' < .android-ndk-version)"
RUN rustup target add aarch64-linux-android
COPY --from=source /app ./
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.gradle \
    --mount=type=cache,id=bowerbird-cross-pinned,target=/root/.cache,sharing=locked \
    --mount=type=cache,target=/app/native/rawshim/target \
    --mount=type=cache,target=/app/src-tauri/target \
  bun run build:wasm \
  && BOWERBIRD_ANDROID_DIST_DIR=/out/installer/android-arm64 bun run scripts/android-build.ts

FROM scratch AS android-dist
COPY --from=android /out/ /

# macOS from Linux, through osxcross and an SDK packaged from Xcode, which Apple does not let
# anyone redistribute: `release-check.ts` hands it in as the `macos-sdk` build context. The
# native library is built without `renditions`, since the codecs are built by vcpkg for the
# machine it runs on and not cross; and the `.app` is `mac-build.ts`'s, without the `.dmg`.
FROM cross AS osxcross
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bzip2 clang cmake cpio libbz2-dev libssl-dev liblzma-dev libxml2-dev llvm lld patch python3 uuid-dev zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/tpoechtrager/osxcross /tmp/osxcross \
  && git -C /tmp/osxcross checkout 27d21e4977c9751d01199c7a226a6faf494c3dd9
COPY --from=macos-sdk / /tmp/osxcross/tarballs/
RUN cd /tmp/osxcross \
  && TARGET_DIR=/opt/osxcross UNATTENDED=1 ./build.sh \
  && rm -rf /tmp/osxcross

FROM osxcross AS macos
RUN rustup target add aarch64-apple-darwin \
  && ln -s "$(ls /usr/lib/llvm-*/bin/llvm-otool | sort -V | tail -n1)" /usr/local/bin/otool \
  && curl -sSfLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$(bun --version)/bun-darwin-aarch64.zip" \
  && unzip -qj /tmp/bun.zip '*/bun' -d /opt/bun-darwin \
  && rm /tmp/bun.zip
ENV OSXCROSS_ROOT=/opt/osxcross
ENV BOWERBIRD_SIDECAR_RUNTIME=/opt/bun-darwin/bun
COPY --from=source /app ./
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/app/native/rawshim/target \
    --mount=type=cache,target=/app/src-tauri/target \
  bun run build:wasm \
  && bun run scripts/osxcross.ts bun run build:native:release --target aarch64-apple-darwin --no-default-features \
  && bun run build:sidecar --target aarch64-apple-darwin \
  && bun run scripts/mac-build.ts \
  && bun run scripts/build-payload.ts --target aarch64-apple-darwin --out /out/payload

FROM scratch AS macos-dist
COPY --from=macos /out/ /

# Windows from Linux, through cargo-xwin, which fetches the MSVC CRT and the Windows SDK itself,
# and NSIS. The native library is built without `renditions`, as for macOS.
FROM cross AS windows
RUN apt-get update \
  && apt-get install -y --no-install-recommends clang lld llvm nsis \
  && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-pc-windows-msvc \
  && cargo install cargo-xwin --version 0.23.1 --locked \
  && curl -sSfLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$(bun --version)/bun-windows-x64.zip" \
  && unzip -qj /tmp/bun.zip '*/bun.exe' -d /opt/bun-windows \
  && rm /tmp/bun.zip
ENV BOWERBIRD_SIDECAR_RUNTIME=/opt/bun-windows/bun.exe
COPY --from=source /app ./
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cache/cargo-xwin \
    --mount=type=cache,target=/app/native/rawshim/target \
    --mount=type=cache,target=/app/src-tauri/target \
  bun run build:wasm \
  && xwin_env="$(cargo xwin env --target x86_64-pc-windows-msvc)" \
  && eval "$xwin_env" \
  && bun run build:native:release --target x86_64-pc-windows-msvc --no-default-features \
  && bun run build:sidecar --target x86_64-pc-windows-msvc \
  && bun run scripts/bundle-app.ts --target x86_64-pc-windows-msvc --bundles nsis --runner cargo-xwin \
  && bun run scripts/build-payload.ts --target x86_64-pc-windows-msvc --out /out/payload \
  && mkdir -p /out/installer/windows-x86_64 \
  && cp src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe /out/installer/windows-x86_64/

FROM scratch AS windows-dist
COPY --from=windows /out/ /
