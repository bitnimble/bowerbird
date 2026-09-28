#!/bin/sh
set -eu

NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BOWERBIRD_NATIVE_LIB="$NATIVE_DIR/librawshim.so"
export BOWERBIRD_NATIVE_LIB

# Report a missing GPU without blocking startup; SwiftShader can still render.
bun "$NATIVE_DIR/report_gpu.ts" "$BOWERBIRD_NATIVE_LIB" || true

exec "$@"
