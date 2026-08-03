#!/usr/bin/env bash
# Materialise the patched wasm-bindgen-rayon checkout Cargo [patch] points at.
# Outside target/ so `cargo clean` cannot delete it; [patch] is required even for
# host builds because Cargo resolves patches for every target.
set -euo pipefail
cd "$(dirname "$0")"

REV=4eea1fa55a965ad516ef9f9e9449704c7eac91c5
DEST=patched/wasm-bindgen-rayon
PATCH=patches/wasm-bindgen-rayon+1.3.0.patch
MARKER_CONTENT="$REV $(sha256sum "$PATCH" | awk '{print $1}')"

if [[ -f "$DEST/.bb-patched" ]] \
  && [[ "$(cat "$DEST/.bb-patched")" == "$MARKER_CONTENT" ]] \
  && grep -q 'fn with_thread_pool' "$DEST/src/lib.rs" \
  && grep -q 'fn exit_thread_pool' "$DEST/src/lib.rs"; then
  exit 0
fi

rm -rf "$DEST"
mkdir -p patched
git clone --quiet https://github.com/RReverser/wasm-bindgen-rayon.git "$DEST"
git -C "$DEST" checkout --quiet "$REV"
# Apply while the clone still has its own .git so git does not walk up into the
# parent worktree and silently skip the patch.
git -C "$DEST" apply "$(pwd)/$PATCH"
rm -rf "$DEST/.git"

if ! grep -q 'fn with_thread_pool' "$DEST/src/lib.rs" \
  || ! grep -q 'fn exit_thread_pool' "$DEST/src/lib.rs"; then
  echo "ensure-patched-rayon: patch did not land expected exports" >&2
  exit 1
fi

printf '%s\n' "$MARKER_CONTENT" >"$DEST/.bb-patched"
