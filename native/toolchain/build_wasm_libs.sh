#!/usr/bin/env bash
# The C libraries the browser build links: LibRaw, libaom and libavif, each as a wasm32
# static archive built with wasi-sdk rather than emscripten.
#
# Why not emscripten: it wants to own the JS glue and the module's entry, which would
# push our own Rust off wasm-bindgen. wasi-sdk is just clang plus a libc, so the archives
# it produces link into an ordinary `wasm32-unknown-unknown` cdylib and wasm-bindgen
# stays in charge of the boundary.
#
# Nothing here touches a filesystem - the RAW arrives as bytes and the AVIF leaves as
# bytes - so the libc surface that survives is malloc/free/memcpy/math. Whatever WASI
# imports remain get stubbed on the JS side rather than implemented.
#
# **The versions are pinned to what the server links**, because the point of building the
# encoder for the browser at all is that the editor's frame is the rendition's frame. Two
# libaoms would be two pictures.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sdk="$here/wasi-sdk-33.0-x86_64-linux"
libraw_src="$here/LibRaw-0.21.2"
aom_src="$here/libaom-3.8.2"
avif_src="$here/libavif-1.0.4"
out="$here/wasm"

# `-mllvm -wasm-enable-sjlj` because libaom signals codec errors with setjmp/longjmp,
# which on wasm is lowered onto exception handling and is a hard error without it.
#
# `-wasm-use-legacy-eh=false` because a module cannot mix the two EH encodings, and the
# halves disagree by default: clang 22 still emits the legacy `try` form, while the
# sysroot's prebuilt libc++abi is entirely `try_table`. Left alone the browser refuses the
# module outright with "uses a mix of legacy and new exception handling instructions". The
# prebuilt libraries are the fixed side, so everything built here moves.
eh_flags="-fwasm-exceptions -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"

# **No `-msimd128` here, and it was measured rather than assumed.** These three are the
# only scalar code in the module - LibRaw has no wasm kernels, and libaom is built
# `AOM_TARGET_CPU=generic`, which takes out its x86 and NEON paths and leaves plain C - so
# letting clang vectorise them looks like the obvious win. It is a large loss. Building all
# three with it takes the module from 6.8MB to 8.8MB and the SIMD instruction count from
# 14k to 465k, and every figure gets worse (minimum of 12 settles and 16 drags, repeated,
# scalar reproducing within 2%):
#
#     still PNG     settle 1198 -> 1580ms    drag  96 -> 164ms
#     AV1 in MP4    settle 1575 -> 2128ms    drag 124 -> 284ms
#
# The still route's drag is the tell: it is `grade_from` and `png::encode_pq`, both Rust,
# and it calls none of these libraries at all - so a 71% regression there is not vectorised
# code running slowly, it is the extra 2MB of code costing the engine more than the vector
# lanes save. Only libaom's encode is in a hot path in the first place, and it is one
# encode per settle against a grade that is already parallel.
simd_flags=""

fetch() {
  local dir="$1" url="$2" archive="$here/fetch.tar.gz"
  [ -d "$dir" ] && return 0
  curl --fail --location --output "$archive" "$url"
  tar -xzf "$archive" -C "$here"
  rm "$archive"
}

fetch "$sdk" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz
fetch "$libraw_src" https://www.libraw.org/data/LibRaw-0.21.2.tar.gz
fetch "$aom_src" https://storage.googleapis.com/aom-releases/libaom-3.8.2.tar.gz
fetch "$avif_src" https://github.com/AOMediaCodec/libavif/archive/refs/tags/v1.0.4.tar.gz

# CMake fetched rather than required, for the same reason wasi-sdk is: a checkout should
# build without anything being installed system-wide first, and this is not worth a sudo.
# Kitware's own build, so no compiler or Python is involved either - `python3 -m venv`
# needs an `ensurepip` that a stock Debian python does not ship.
#
# Make rather than Ninja as the generator, purely so there is one fewer thing to fetch.
cmake_dir="$here/cmake-4.1.2-linux-x86_64"
fetch "$cmake_dir" https://github.com/Kitware/CMake/releases/download/v4.1.2/cmake-4.1.2-linux-x86_64.tar.gz
export PATH="$cmake_dir/bin:$PATH"

# The header trees bindgen reads, kept apart from /usr/include so a wasm parse cannot
# reach glibc (see the note in build.rs).
mkdir -p "$here/include"
ln -sfn "$libraw_src/libraw" "$here/include/libraw"
ln -sfn "$avif_src/include/avif" "$here/include/avif"
mkdir -p "$out/obj"

# ---------------------------------------------------------------------------------------
# LibRaw. Compiled unit by unit rather than through its own build system, which wants to
# configure against a host.
#
# LibRaw's own workers stay disabled: Rayon owns the browser pool and the decode is a
# one-shot. The pthread target still supplies a thread-safe allocator once the grade
# starts using that pool. jasper/jpeg/lcms decode formats the app does not read.
libraw_flags=(
  --target=wasm32-wasip1-threads
  --sysroot="$sdk/share/wasi-sysroot"
  # LibRaw signals its own errors by throwing, so exceptions cannot be switched off.
  -O2 $eh_flags $simd_flags -fno-rtti
  -matomics -mbulk-memory -pthread
  -DLIBRAW_NOTHREADS
  -DNO_JASPER -DNO_JPEG -DNO_LCMS
  # Not `-DLIBRAW_WIN32_DLLDEFS=0`: the header guards on `#ifdef`, so defining it at all
  # selects the Windows `__declspec` path. LIBRAW_NODLL is the one that empties DllDef.
  -DLIBRAW_NODLL
  "-I$libraw_src"
  "-I$libraw_src/libraw"
)

# Every translation unit LibRaw has, minus x3f - Foveon, which needs its own decoder
# tree and which no camera this app reads produces. Globbed rather than listed: 0.21
# spreads 78 files over src/*/ and a hardcoded list silently builds a partial archive
# that only fails at link time, which is exactly what happened first time round.
mapfile -t units < <(find "$libraw_src/src" -name '*.cpp' -not -path '*/x3f/*' | sort)
echo "LibRaw: ${#units[@]} translation units"

# A failed unit must stop the build, not be skipped.
#
# This loop used to pipe clang into grep and end with `|| true`, which took the exit
# status of the *grep* and threw it away - so a unit that would not compile was silently
# omitted, `ar` archived whatever happened to exist, and the script announced success.
# That is not hypothetical: the first run here built 2 of 76 files and said "built".
for unit in "${units[@]}"; do
  name="$(echo "$unit" | sed "s|$libraw_src/src/||; s|/|_|g; s|\.cpp$||")"
  if ! "$sdk/bin/clang++" "${libraw_flags[@]}" -c "$unit" -o "$out/obj/$name.o" 2>"$out/obj/$name.log"; then
    echo "FAILED $unit"
    head -20 "$out/obj/$name.log"
    exit 1
  fi
done

# Stale objects from an earlier run would be archived alongside the current ones and
# nothing would notice, so the count has to match what was just compiled.
built="$(find "$out/obj" -name '*.o' | wc -l)"
if [ "$built" -ne "${#units[@]}" ]; then
  echo "expected ${#units[@]} objects, found $built - stale output in $out/obj"
  exit 1
fi

"$sdk/bin/ar" rcs "$out/libraw.a" "$out"/obj/*.o

# ---------------------------------------------------------------------------------------
# libaom, through its own CMake.
#
# `AOM_TARGET_CPU=generic` takes out every x86 and NEON path, which is the whole of what
# stands between this and a wasm build - the C fallbacks are complete.
#
# Single-threaded, like LibRaw and for the same reason. libaom would otherwise call
# `pthread_create`, which under wasip1-threads needs a `wasi_thread_spawn` import that
# only a WASI host provides - and this module's threads come from wasm-bindgen-rayon,
# which spawns workers the browser's way. The encode is one frame on the settle, so what
# is lost is tile threading on a frame the grade has already parallelised into.
#
# Encoder only: the browser has its own AV1 decoder and this module never reads one back.
cmake -S "$aom_src" -B "$here/build-aom" \
  -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-pthread.cmake" \
  -DWASI_SDK_PREFIX="$sdk" \
  -DCMAKE_BUILD_TYPE=Release \
  -DAOM_TARGET_CPU=generic \
  -DBUILD_SHARED_LIBS=0 \
  -DCONFIG_AV1_DECODER=0 \
  -DCONFIG_MULTITHREAD=0 \
  -DCONFIG_RUNTIME_CPU_DETECT=0 \
  -DENABLE_TESTS=0 -DENABLE_TOOLS=0 -DENABLE_EXAMPLES=0 -DENABLE_DOCS=0 -DENABLE_TESTDATA=0 \
  -DCMAKE_C_FLAGS="$eh_flags $simd_flags" -DCMAKE_CXX_FLAGS="$eh_flags $simd_flags" >/dev/null
cmake --build "$here/build-aom" -j 16
cp "$here/build-aom/libaom.a" "$out/libaom.a"

# ---------------------------------------------------------------------------------------
# libavif, against the libaom just built.
#
# `AVIF_LOCAL_AOM` wants the codec at `ext/aom` with its archive under `build.libavif`,
# which is cheaper to satisfy than teaching `find_package` about a cross build.
#
# `CMAKE_DISABLE_FIND_PACKAGE_libsharpyuv` because `find_package(libsharpyuv QUIET)`
# otherwise finds the *host's* copy and links an x86 archive into a wasm one. It is only
# reached for sharp 4:2:0 downsampling, which nothing here asks for.
mkdir -p "$avif_src/ext" "$aom_src/build.libavif"
ln -sfn "$aom_src" "$avif_src/ext/aom"
cp "$out/libaom.a" "$aom_src/build.libavif/libaom.a"

cmake -S "$avif_src" -B "$here/build-avif" \
  -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-pthread.cmake" \
  -DWASI_SDK_PREFIX="$sdk" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=0 \
  -DAVIF_CODEC_AOM=ON -DAVIF_LOCAL_AOM=ON \
  -DAVIF_CODEC_AOM_DECODE=OFF -DAVIF_CODEC_AOM_ENCODE=ON \
  -DAVIF_BUILD_APPS=OFF -DAVIF_BUILD_TESTS=OFF -DAVIF_BUILD_EXAMPLES=OFF \
  -DAVIF_BUILD_GDK_PIXBUF=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_libsharpyuv=ON \
  -DCMAKE_C_FLAGS="$eh_flags $simd_flags" >/dev/null
cmake --build "$here/build-avif" -j 16
cp "$here/build-avif/libavif.a" "$out/libavif.a"

# ---------------------------------------------------------------------------------------
# A host library reaching an archive is silent until the wasm link fails with an
# unresolved symbol that names nothing useful, so the check is here rather than there.
for archive in libraw libaom libavif; do
  if "$sdk/bin/llvm-nm" --undefined-only "$out/$archive.a" 2>/dev/null | grep -q SharpYuv; then
    echo "$archive.a references the host's libsharpyuv"
    exit 1
  fi
done

ls -la "$out"/*.a
echo "remaining WASI imports:"
"$sdk/bin/llvm-nm" --undefined-only "$out"/*.a 2>/dev/null |
  grep -oE '\b(fd_\w+|path_\w+|proc_exit|environ_\w+|clock_\w+|random_get)\b' | sort -u || true
