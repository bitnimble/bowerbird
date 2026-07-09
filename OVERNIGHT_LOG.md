# Overnight log

Scratch report for unattended `/overnight-now` work. Uncommitted.

## Task
"Set a timer for 2 hours, then do another review + autonomous fix pass."

## Working done-criteria
- Wait ~2 hours from the request (explicit user instruction), then run a full
  review + autonomous fix pass over the bowerbird codebase, matching the two
  prior passes: fan out parallel reviewers → verify every finding against the
  code myself → fix real issues autonomously → commit locally in logical groups
  → validate with `bun run typecheck`, `bun run test` (host jest), and container
  integration (`docker exec bowerbird-dev bun test test/integration`).
- Commit locally only (no push). Park anything irreversible / a genuine fork.

## Timer
- start epoch: 1783607066 (2026-07-10 00:24:26 AEST)
- target epoch: 1783614266 (2026-07-10 02:24:26 AEST) = start + 7200s
- Mechanism: ScheduleWakeup is capped at 3600s/wakeup, so chaining ~1h wakeups.
  On each wake, compare `date +%s` to the target: if remaining > 60s, schedule
  the next wakeup (min(3600, remaining)); once reached, run the review+fix pass.

## Assumptions
- The "2-hour timer" is an explicit deliberate delay (honored), not a stall on a
  question. During the wait I idle (as instructed) rather than doing other work.

## Findings (pass 3), verified before fixing
- [FFI/API reviewer] VERIFIED real: processUnprocessed dedups with an inFlight
  Set returning a no-op undefined; sync's detached `.then(set idle)` fires
  immediately on a duplicate call -> status 'idle' while thumbnails still run,
  and the real batch's `.then` clobbers with stale counts. Regression from the
  2nd-pass detach-processing fix. Fix: return the shared in-flight Promise.

## More verified findings (pass 3)
- [concurrency] moveIntoDir EXDEV fallback = existsSync+copyFile (not atomic) ->
  TOCTOU/data-loss for cross-fs custom data_path. Fix: exclusive open('wx').
- [concurrency] sync_lock stale-reclaim unlinkSync unguarded -> ENOENT on racer.
  Fix: try/catch ignore ENOENT.
- [concurrency] processUnprocessed dedup drops 2nd sync's trigger (no rerun).
  Fix: rerun flag (folded into the in-flight-promise fix).
- [concurrency] watcher outer catch (sync watch() failure during retry) swallows
  -> auto-sync dies after one failed retry. Fix: outer catch reschedules.
- [concurrency, minor] watcher.stop() doesn't stop an in-flight run rescheduling.
  Fix: stopped flag checked in run().finally.
- [DB/tests] listSupportedFiles exclusions (.bowerbird/Bin/non-arw) untested
  (16.2). Fix: add files.ts jest test.
- [DB/tests] shoot rename skips soft-deleted photos in shoot Bin (listUnderFolder
  is_deleted=0) -> stale file_path. Fix: include deleted photos in rename cascade.
- [DB/tests] dateTaken ignores EXIF OffsetTimeOriginal (no LibRaw accessor).
  Fix: document as Stage-1 limitation (like colorSpace).

## Progress
- 00:24 AEST: initialized log; scheduled first wakeup.
- 00:2x AEST: user said "kick it off now" -> cancelled the timer; starting the
  review + autonomous fix pass immediately (third pass). Still unattended.
- Dispatching 5 parallel reviewers (concurrency/lifecycle, sync/scan,
  services/fs, FFI/processing/API, DB/schemas/tests/conventions). Prior two
  passes fixed ~27 issues; reviewers told not to re-report those.
