#!/usr/bin/env bash
# LibRaw as a wasm32 static archive, built with wasi-sdk rather than emscripten.
#
# Why not emscripten: it wants to own the JS glue and the module's entry, which would
# push our own Rust off wasm-bindgen. wasi-sdk is just clang plus a libc, so the archive
# it produces links into an ordinary `wasm32-unknown-unknown` cdylib and wasm-bindgen
# stays in charge of the boundary.
#
# The RAW never touches a filesystem - `libraw_open_buffer` takes bytes - so the libc
# surface that survives is malloc/free/memcpy/math. Whatever WASI imports remain get
# stubbed on the JS side rather than implemented.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sdk="$here/wasi-sdk-33.0-x86_64-linux"
src="$here/LibRaw-0.21.2"
out="$here/wasm"

if [ ! -d "$sdk" ]; then
  archive="$here/wasi-sdk.tar.gz"
  curl --fail --location --output "$archive" \
    https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz
  tar -xzf "$archive" -C "$here"
  rm "$archive"
fi

if [ ! -d "$src" ]; then
  archive="$here/libraw.tar.gz"
  curl --fail --location --output "$archive" https://www.libraw.org/data/LibRaw-0.21.2.tar.gz
  tar -xzf "$archive" -C "$here"
  rm "$archive"
fi

mkdir -p "$here/include"
ln -sfn "$src/libraw" "$here/include/libraw"
mkdir -p "$out/obj"

# LibRaw's own workers stay disabled: Rayon owns the browser pool and the decode is a
# one-shot. The pthread target still supplies a thread-safe allocator once the grade
# starts using that pool. jasper/jpeg/lcms decode formats the app does not read.
flags=(
  --target=wasm32-wasip1-threads
  --sysroot="$sdk/share/wasi-sysroot"
  # LibRaw signals its own errors by throwing, so exceptions cannot be switched off.
  #
  # `-wasm-use-legacy-eh=false` because a module cannot mix the two EH encodings, and the
  # halves disagree by default: clang 22 still emits the legacy `try` form here (measured
  # - 347 of them in the archive, zero `try_table`), while the sysroot's prebuilt
  # libc++abi is entirely `try_table`. Left alone the browser refuses the module outright
  # with "uses a mix of legacy and new exception handling instructions", naming
  # `fallback_malloc` inside libc++abi. The libraries are the fixed side, so LibRaw moves.
  -O2 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -fno-rtti
  -matomics -mbulk-memory -pthread
  -DLIBRAW_NOTHREADS
  -DNO_JASPER -DNO_JPEG -DNO_LCMS
  # Not `-DLIBRAW_WIN32_DLLDEFS=0`: the header guards on `#ifdef`, so defining it at all
  # selects the Windows `__declspec` path. LIBRAW_NODLL is the one that empties DllDef.
  -DLIBRAW_NODLL
  "-I$src"
  "-I$src/libraw"
)

# Every translation unit LibRaw has, minus x3f - Foveon, which needs its own decoder
# tree and which no camera this app reads produces. Globbed rather than listed: 0.21
# spreads 78 files over src/*/ and a hardcoded list silently builds a partial archive
# that only fails at link time, which is exactly what happened first time round.
mapfile -t units < <(find "$src/src" -name '*.cpp' -not -path '*/x3f/*' | sort)
echo "${#units[@]} translation units"

# A failed unit must stop the build, not be skipped.
#
# This loop used to pipe clang into grep and end with `|| true`, which took the exit
# status of the *grep* and threw it away - so a unit that would not compile was silently
# omitted, `ar` archived whatever happened to exist, and the script announced success.
# That is not hypothetical: the first run here built 2 of 76 files and said "built".
for unit in "${units[@]}"; do
  name="$(echo "$unit" | sed "s|$src/src/||; s|/|_|g; s|\.cpp$||")"
  if ! "$sdk/bin/clang++" "${flags[@]}" -c "$unit" -o "$out/obj/$name.o" 2>"$out/obj/$name.log"; then
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
echo "built $out/libraw.a"
"$sdk/bin/llvm-nm" --undefined-only "$out/libraw.a" 2>/dev/null | grep -oE '\b(fd_\w+|path_\w+|proc_exit|environ_\w+|clock_\w+|random_get)\b' | sort -u || true
