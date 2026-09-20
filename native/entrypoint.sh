#!/bin/sh
# Picks the fastest rawshim build this CPU can actually run, then starts the app.
#
# The image ships three, ~20MB each: a portable x86-64 baseline, an AVX2 build and
# an AVX-512 build. AVX-512 is worth ~26% of the grade stage and ~8% of a whole
# rendition job, and measured, it captures the entire gain a `-C target-cpu=native`
# build on the host would (DESIGN 10.4) - which is why the image ships variants
# rather than a compiler.
#
# Chosen by trying them, not by reading CPU flags. A build using an instruction the
# host lacks dies with SIGILL, which cannot be caught, so it is provoked here in a
# throwaway process and whatever survives is what the app loads. That needs no
# feature table, cannot be fooled by a hypervisor reporting flags it does not
# honour, and stays correct when a new level is added.
#
# Every failure path ends at the baseline, which is the condition for doing this at
# all: an exotic CPU must not turn into a container that will not boot.
set -eu

# Beside this script rather than an absolute path: an updated container runs the payload
# out of a version directory under /data, and the variant it probes has to be that
# version's library rather than the one the image was built with.
NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SELECTED="$NATIVE_DIR/librawshim.selected.so"

# A choice from an earlier start is not evidence about this one: a restart can land
# on a different host, and a stale symlink is loaded in preference to the baseline.
rm -f "$SELECTED"

# BOWERBIRD_SHIM_VARIANT pins one (baseline, v3, v4) for a host that reports
# instructions it does not honour, or to measure the difference in place.
case "${BOWERBIRD_SHIM_VARIANT:-auto}" in
  auto) candidates="v4 v3" ;;
  baseline) candidates="" ;;
  *) candidates="${BOWERBIRD_SHIM_VARIANT}" ;;
esac

for variant in $candidates; do
  candidate="$NATIVE_DIR/librawshim.$variant.so"
  if [ ! -f "$candidate" ]; then
    echo "rawshim: no $variant build in this image"
    continue
  fi
  if bun "$NATIVE_DIR/verify_shim.ts" "$candidate"; then
    ln -s "$candidate" "$SELECTED"
    echo "rawshim: using the $variant build"
    break
  fi
  echo "rawshim: the $variant build does not run on this CPU"
done

# The baseline needs no probe: it is plain x86-64, and if that cannot run then
# neither can Bun.
[ -e "$SELECTED" ] || echo "rawshim: using the portable baseline"

# Named rather than searched for. The image's layout is no longer a fixed path - an
# updated container runs out of a version directory under /data - and this is the only
# thing that knows both which directory that is and which variant won the probe above.
if [ -e "$SELECTED" ]; then
  BOWERBIRD_NATIVE_LIB="$SELECTED"
else
  BOWERBIRD_NATIVE_LIB="$NATIVE_DIR/librawshim.so"
fi
export BOWERBIRD_NATIVE_LIB

# Which GPU the grade will run on. Reported rather than checked: the image carries a CPU
# fallback, so the failure worth naming is not "cannot render" but "renders on the wrong
# thing and only looks slow". Never fatal, and never blocks the exec below.
bun "$NATIVE_DIR/report_gpu.ts" "$BOWERBIRD_NATIVE_LIB" || true

exec "$@"
