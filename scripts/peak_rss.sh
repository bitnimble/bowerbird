#!/usr/bin/env bash
# Peak RSS of a command, sampled from VmHWM. No GNU time on this box.
set -u

out=$(mktemp -t peak_rss.XXXXXX)
trap 'rm -f "$out"' EXIT

"$@" >"$out" 2>&1 &
pid=$!

peak=0
while [ -d /proc/$pid ]; do
  v=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null)
  if [ -n "$v" ] && [ "$v" -gt "$peak" ]; then peak=$v; fi
  # VmHWM is a high-water mark, so a coarse sample cannot miss a peak between reads.
  sleep 0.2
done
wait $pid
status=$?

echo "PEAK RSS: $((peak / 1024)) MB (exit $status)"
tail -40 "$out"
