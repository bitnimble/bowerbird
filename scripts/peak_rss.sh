#!/usr/bin/env zsh
# Peak RSS of a command. No GNU time on this box; zsh's %M is the kernel's own
# rusage figure, so unlike sampling /proc it cannot miss a short-lived peak.
set -u

TIMEFMT='PEAK RSS: %MMB (%*E s)'
time ( "$@" )
