#!/usr/bin/env bash
# Alerts only when the agent fleet has genuinely stopped making progress.
#
# Output-file mtime alone is a bad liveness signal: the transcripts are piped
# through tail, so a working agent can leave one untouched for a long build.
# Build activity is the check that distinguishes "slow" from "dead".
set -u

dir=$1
shift
quiet_for=2400

while true; do
  sleep 300

  builders=$(pgrep -c -f 'rustc|cargo' || true)
  [ -n "$builders" ] && [ "$builders" -gt 0 ] && continue

  now=$(date +%s)
  live=0
  for id in "$@"; do
    f=$dir/$id.output
    [ -f "$f" ] || continue
    age=$((now - $(stat -c %Y "$f")))
    if [ "$age" -lt "$quiet_for" ]; then
      live=$((live + 1))
    else
      echo "STALLED: agent $id quiet ${age}s with no build running"
    fi
  done

  if [ "$live" -eq 0 ]; then
    echo "FLEET IDLE: no builds, every agent quiet"
    break
  fi
done
