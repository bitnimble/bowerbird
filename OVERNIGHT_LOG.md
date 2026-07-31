# Overnight: stack triage

Task: finish `docs/superpowers/specs/2026-07-31-stack-triage-design.md`, then
implement it end to end on the `stack-triage` branch.

## The brief

**Goal.** A pairwise comparison screen for triaging one stack: two photos at a
time, verdict *A better* / *Both* / *B better* / *Neither*, ending in a keep set
written through `triage`. Two presentations (flip, split), a queue of Completed
and Upcoming rounds with any past round re-judgeable, undo, live writes,
refresh-survival.

**Decisions taken with the user before they left:**

| decision | answer |
|---|---|
| `PhotoStage` flip support | Do the real surgery (`pair` prop, two decodes, compositor layers). Pin current single-`src` behaviour with regression tests **first**, then refactor against them. |
| e2e | Must pass. Add the triage e2e. If the browser genuinely cannot launch here, log it rather than burn the night. |
| DESIGN.md | Fold the spec in as §20, mirroring §19 Photo Stacks. The spec file stays as the dated design record. |
| Done bar | All checks green, **plus** the app launched and driven through a real session in both modes and the queue, with screenshots in this file. |

Earlier decisions, from the spec conversation: live writes per verdict (not
deferred); all non-deleted, non-missing members compete whatever their triage;
equal displayed area in split; undo + Keep the rest + Neither + refresh-survival
all in v1; prefetch capped at 10; `Ctrl/Cmd+Z` for undo; queue parts named
Completed and Upcoming.

**Done-criteria.** All green, from the repo root unless noted:

- `bun run typecheck`, `bun run lint`, `bun test src`, `bun run test:integration`
- `web/`: `bun run typecheck`, `bun test src`, `bun run test:e2e`
- app launched, a session driven end to end, screenshots below

**Scope note.** The spec's §6 lists changes to existing components, two of which
are pre-existing bugs: `PhotoStage` fullscreen reads `document.fullscreenElement`
globally in both `setFullscreen` and `toggleFullscreen`, so with two stages
mounted one hijacks the other; and `refresh()` queues one full collection re-read
per call, so holding a cull key in the grid piles them up. Both get fixed at the
root per CLAUDE.md, not worked around.

**e2e fixture.** `STACK_PHOTOS_DIR` gets its own three-name list rather than
growing `PHOTO_NAMES`, which is shared with `catalogue.spec` and `culling.spec`
and would break ~15 count assertions for nothing. Note from last night: the
fixture is one ARW copied under several names, so auto-stacking is off for
fixture libraries unless a spec asks for it, the triage spec will need to ask.

**Commits.** Conventional, incremental, on `stack-triage`. No pushes; that's for
the morning.

**e2e fallbacks the user offered on the way out**: the Playwright MCP server, or
browsers already in `~/.cache/ms-playwright`, or spinning up
`docker-compose.dev.yml` myself.

## Progress

1. **Spec finished** (938 lines) and folded into `DESIGN.md` as §20.
2. **`stack_triage.ts`**, the tournament and the split layout, pure. 31 unit
   tests. The `champion` field the spec started with was deleted: moving a
   decisive winner to the *front* of the pool reproduces the hold-over exactly,
   and `nextRound` collapses to one scan with no branch.
3. **`PhotoStage` refactor**, a frame per source, each owning its own decode,
   so one stage can hold both frames of a round. Pinned first with two new e2e
   (zoom survives a rendition change, resets on a photo change); the whole
   culling suite of 38 passes unchanged.
4. **Store / presenter / page / storage** + route, entry button, shortcuts, CSS.
5. **e2e**, `triage.spec.ts`, 8 tests, its own three-frame library.

Found and fixed on the way, beyond the plan:

- `PhotoStage.toggleFullscreen` read `document.fullscreenElement` globally as
  well as `setFullscreen` did, so with two stages mounted the second stage's
  button exited the *first* stage instead of entering its own.
- `PhotosPresenter.patch` had no write ordering at all: `api.updatePhoto` is a
  bare fetch, so any two writes to one photo could land out of order. Now one
  promise chain.
- `refresh()` queued one full collection re-read per call. Holding a cull key in
  the grid on the Active filter already piled these up; now coalesced.
- An unused `existsSync` import in `test/integration/hdr_media.integration.test.ts`
  (the last lint warning in the repo; `bun run lint` is now silent).
- **A photograph could disappear from the catalogue.** `stacks_repository`'s
  `removePhotos` cleared `stack_id` but left `is_representative` at 0, and
  `representativeFilter` shows a row with no stack on that flag alone. So
  removing any member except the newest one made that photograph invisible in
  every listing, permanently, while `total` went on counting it. `dissolve` sets
  the flag; `removePhotos` did not. Found because the triage fixture needed a
  three-frame stack: with two members the only one you can remove and still
  leave a stack is the representative, which is why it had never shown. Fixed at
  the repository, with an integration test that I verified fails without the fix
  (the released photo is simply absent from the listing).

## Done

Stack triage is built and working end to end. Open a stack member in the viewer
and press **Triage stack**.

| done-criterion | result |
|---|---|
| `bun run typecheck` (root) | clean |
| `bun run lint` (root) | clean, including one pre-existing warning I removed |
| `bun run test src` (root) | **366 pass**, 0 fail |
| `bun run test:integration` | **164 pass**, 0 fail (1 new) |
| `web` `bun run typecheck` | clean |
| `web` `bun test src` | **148 pass**, 0 fail (31 new) |
| `web` `bun run test:e2e` | **66 pass**, 0 fail (8 new) |
| driven in a browser | yes, screenshots below |

### Screenshots

In `triage-shots/` in the repo root, **uncommitted** - delete them whenever.
Captured by driving the real app through a whole session at 1600x950:

1. `1-grid-with-stack.png` - the collapsed stack in the gallery
2. `2-viewer-entry-button.png` - the Triage stack button in the viewer header
3. `3-flip-mode.png` - flip, with the A / peek / B switch and the verdict bar
4. `4-queue-upcoming.png` - the queue before anything is judged
5. `5-split-mode.png` - split, both frames at equal area
6. `6-queue-completed.png` - the queue with a completed round in it
7. `7-summary.png` - Kept 1, Rejected 2, with Undo

I checked the split layout numerically rather than by eye: each half measured
562.44x842 in a 1364x842 box, the image filling it exactly at the photo's own
aspect, which is what the formula predicts (s = 688.3). Nothing is cropped; it
simply uses more space than flip, which spends a bar on the A/B switch.

### What changed against the spec while building

- **`Session.champion` is gone.** Moving a decisive winner to the *front* of the
  pool reproduces the hold-over exactly, so `nextRound` is one scan with no
  branch, and the exhaustion fall-through needs no case of its own. That deleted
  a field, an invariant, a defence of a non-problem, and a test.
- **`PhotoStage` needed more than the spec's prop.** The machinery was
  single-slot throughout, so it became a frame per source, each owning its own
  decode. A hidden pair member gets its own compositor layer, because the
  component's own comment records that an `opacity: 0` element is never
  rasterised - the exact stall flip mode cannot afford.

## Committed locally

Seven commits on `stack-triage`, **nothing pushed**:

```
ad82fd0 fix(triage): name both presentations, and count one round as one
9406551 docs: fold stack triage into DESIGN.md as section 20
62152bb test(triage): drive a stack triage session end to end
8bf3652 fix(stacks): keep a photograph in the catalogue when it leaves a stack
2e61c9e feat(triage): compare a stack two photos at a time
f71711d refactor(stage): let one stage hold several frames of the same photo
c665ffc feat(triage): the stack triage tournament, as pure functions
```

`8bf3652` is worth reading first: it is a **pre-existing data-visibility bug**,
not triage's own, and it would have bitten anyone using Remove from stack.

## Parked

- **Nothing pushed.** Seven commits ready to review: `git push -u origin
  stack-triage`.
- **A stray 1.7MB file called `undefined` sits in the repo root**, tracked, an
  AVIF committed by accident in `fa42bd2` (a rendition written to a path that
  stringified to "undefined"). Deleting a tracked file is irreversible so it is
  yours: `git rm undefined && git commit -m "chore: remove a stray rendition"`.
  Worth a look at what wrote it - the same call could do it again.

## Assumptions

- **The queue is a popover, not a dialog.** The spec said "a button in the
  header opens a list"; `PopoverButton` already exists and a Completed row is two
  thumbnails, which an `ActionMenu` option cannot hold.
- **Summary thumbnails are the `grid` rendition**, which is what a band already
  draws. The session's own rendition is for judging, not for recalling.
- **The pool starts in the order the server returns members** (newest first),
  not re-sorted into capture order. It decides which pairs get asked, so it had
  to be pinned somewhere; the server's order is what the rest of the app shows a
  stack in.
- **`Tab` switches presentation and `Esc` leaves.** The spec named neither; every
  letter worth having is either a verdict's neighbour or already bound.
- **Triage writes are `quiet`**, suppressing `patch`'s error toast, because the
  screen reports failures itself in one place. Without it one failed verdict
  raised both a toast and the bar's list.

## One thing to look at with fresh eyes

The **failed-write path is the least exercised part**. It is specified and
implemented (writes report success, failures collect into a "Not saved" row with
Retry, and the session does *not* roll back around them) but there is no test
that forces a write to fail - the e2e has no offline mode and I did not want to
add a fault-injection hook to `api.updatePhoto` for it. If you want that pinned,
that is the gap.
