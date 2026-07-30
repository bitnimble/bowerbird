# Stack Triage, Design

Date: 2026-07-31

A **stack** (§19) is several takes of one scene. Picking the keepers means
comparing every take against every other, which is N² judgements and reads as
work rather than as photography.

**Stack triage** replaces that with a run of binary questions. Two photos at a
time, one question (which of these is better), and the session ends with a subset
of the stack the photographer is happy with. That subset may be one photo,
several, all of them, or none.

Terms, used exactly and only this way throughout:

| term | meaning |
|---|---|
| **round** | one pair, put to the photographer and judged |
| **the pool** | the photos still in contention, the `alive` field |
| **survivor** | a photo currently in the pool |
| **the keep set** | the survivors at the moment the session ends |
| **decisive** | the verdict *A better* or *B better*: exactly one photo leaves. `Neither` removes two and is **not** decisive |
| **a draw** | the verdict `Both` |
| **held over** | the winner of a decisive verdict, kept on screen for the next round rather than replaced (§2.2). It has no field of its own: it is whatever sits at the front of the pool |
| **the stage** | the area the photos are drawn in, one `PhotoStage` in flip and two in split (§3) |
| **A** and **B** | the two **slots** on screen, never photo names. Worked examples name photos `p`, `q`, `r` |

## 1. Scope

- A tournament over one stack's members, entered from the photo viewer.
- Two presentations of a round: **flip** (one photo at a time, hold to peek at
  the other) and **split** (both at once, each given the same area).
- A **queue**, listing the rounds already judged and the rounds still projected,
  with any past round reachable to be judged again.
- Verdicts write through the existing `triage` field.

Writing through `triage` rather than adding a stack-scoped keep flag is what
makes the result mean something outside this screen: the rejects land in the same
filter the gallery already hides, and the keepers in the same one it already
shows, so a session's outcome is immediately actionable with the bulk tools that
exist. The cost is real and is accepted deliberately: **a session overwrites
verdicts the photographer made in the viewer**, because a photo carries one
triage value and the tournament is entitled to it. §5 leans on this in the other
direction, letting an already-rejected member compete again, and the two are the
same decision seen from either end.

Out of scope: entering from a grid band, synchronised zoom in split mode,
comparing across stacks.

## 2. The tournament

### 2.1 State

```ts
type Verdict = 'a' | 'b' | 'both' | 'neither';

interface Round { a: string; b: string }

interface Session {
  alive: string[];            // the pool, in queue order
  seen: ReadonlySet<string>;  // every pair already judged, keyed by its two ids sorted and joined
  stopped: boolean;           // Keep the rest was pressed
}
```

A pair's key is its two ids **sorted lexicographically and joined with `|`**,
which no UUID contains. Stated because two implementers would otherwise pick
different joiners, and a session stored by one and read by the other would find
no pair it had already judged.

**Every judged pair goes into `seen`, decisive ones included**, even though a
decisive pair can never recur on its own (the loser has left the pool). Recording
them costs one insert and buys two things worth more than that: "a pair is never
offered twice" becomes a local property of `nextRound` instead of resting on the
separate fact that a removed photo never returns, and "this photo has been
judged" becomes derivable as *appears in some pair of `seen`*, which §2.6 needs
and would otherwise be a second set to carry.

`stopped` is in `Session` rather than in the store because undo restores a
`Session` and nothing else (§2.7). Ending early is a change to the tournament, so
it has to be inside the value that undo swaps, or Keep the rest is the one action
that cannot be taken back.

### 2.2 Choosing the round

```
nextRound(session):
  if stopped: return null
  return the first pair in index order over `alive` -- (0,1), then (0,2), (0,3),
         ... then (1,2) -- whose key is not in `seen`, or null
```

That is the whole rule. The index order is stated exactly because a second
reading exists (nearest-neighbour, `(0,1), (1,2), (2,3)`), and the two produce
different sessions.

**The winner stays on the stage, and the queue order is what puts it there.** A
decisive verdict moves the winner to the **front** of the pool (§2.3), so the
next round is `(0,1)`: the winner against the first photo it has not met. When it
has met everyone still in the pool, every `(0,k)` is in `seen` and the scan walks
on to `(1,2)`, a pair that cannot contain it, and it is no longer at the front
after the next verdict. Holding the winner over is the point: replacing both
photos every round makes the photographer re-learn two images each time, where
keeping one narrows the question to "is the new one better than the one I just
chose".

An earlier draft carried a `champion` field to express this, with a branch in
`nextRound`, an invariant tying it to the pool, and an argument about when a
stale one is cleared. Moving the winner to the front produces the identical
schedule with none of that: the hold-over, the exhaustion fall-through, and the
draw case all fall out of one scan over one list. What §3.1 needs is not "does
this round have a champion" but "is slot A the same photo it was", which is
`round.a === previousRound.a` and is the question it was really asking.

### 2.3 Verdicts

| verdict | the pool |
|---|---|
| A better | B removed, A moved to the front |
| B better | A removed, B moved to the front |
| Both | A then B moved to the back, in that order |
| Neither | both removed |

All four add the pair to `seen`.

The winner to the front is what holds it over (§2.2). The drawn pair to the back
is what spreads the work: without it the same two photos sit at the front and
every subsequent round pairs one of them with someone new, so one photo carries
the whole session.

**Neither may empty the pool.** A stack where every frame is soft has no keeper,
and a tool that insists on returning one would be lying about what the
photographer decided.

### 2.4 What the session guarantees

Every round either removes a photo from the pool or adds a pair to `seen`. Both
are monotone and bounded, so the session terminates; and `nextRound` only ever
returns a pair not in `seen`, so no round repeats.

**A session that ends by exhaustion returns a keep set that is a clique of mutual
draws.** It ends when no unseen pair is left among the survivors, so every pair of
them was judged; and any decisive judgement would have removed one of them, so
every one of those judgements was a draw. No photo is kept without having been
held up against every other photo that was kept, which is the property the whole
flow exists to deliver. It is the same guarantee an exhaustive comparison of every
pair would give, and it never costs more than one: the ceiling is the N(N−1)/2
rounds exhaustive comparison *is*, reached only if the photographer draws
everything. What the tournament buys is that a decisive verdict retires a photo
and, with it, every remaining round that photo would have appeared in, which is
why a decisive run reaches the same guarantee in N−1 (§2.5).

The guarantee is scoped to exhaustion on purpose. **Keep the rest forfeits it**,
knowingly: pressing it with `p` and `q` drawn and `r` never shown keeps all three,
and `r` has been compared with nothing. That is the trade the button exists to
offer, and §2.6 makes sure `r` is not *claimed* as a considered keeper.

A worked case, because this is the one that looks like a gap and is not. `p` and
`q` draw early; `r` then beats everything else, leaving the pool as `[r, p, q]`
with `seen = {pq, …}`. The session is not over: it offers `r` against `p`, and
then `r` against `q`, and only if both draw does it end with all three kept. The
draws `p`–`q` and `r`–`p` imply nothing about `q`–`r`, and the design does not
pretend they do.

### 2.5 Cost

- **N−1 rounds when every verdict is decisive**: the held-over winner beats each
  challenger in turn, which is the optimal number of comparisons for finding a
  maximum. It is the interesting figure rather than the best case. The actual
  minimum is ⌊N/2⌋, reached by answering `Neither` to everything, which is fast
  because it throws the stack away.
- **Worst case exactly N(N−1)/2**, every verdict a draw. Six photos is up to
  fifteen rounds. The bound is tight: each round consumes one distinct pair that
  was unseen among the pool, and an all-draw run consumes every one of them.

The worst case is real, so there is an escape rather than a cleverness: **Keep
the rest** ends the session immediately with every survivor kept.

The alternative was to treat draws as transitive, so that `p`≈`q` and `q`≈`r`
would skip `p` against `r`. Rejected, because it is not true: two photos can each
be worth keeping beside a third and still be separable from each other. Taking it
would also cost the §2.4 guarantee silently, on every session, where Keep the
rest costs it only when the photographer chooses to spend it.

### 2.6 What is written, and when

Elimination is the only verdict that is final, so it is the only one written
during the session.

- **A loser is `PATCH`ed to `triage: 'rejected'` as the verdict lands.** `Neither`
  writes both.
- **A win writes nothing.** The winner can still be eliminated two rounds later,
  so marking it `picked` now would be a claim the session has not made.
- **When the session ends, each survivor that appears in some pair of `seen` is
  `PATCH`ed to `triage: 'picked'`.** A survivor in no pair has never been on
  screen, and is left exactly as it was.

That last clause is the counterpart of the second. Without it, a pool of
`[p, q, r, t]` where the photographer answers *A better* then `Neither` ends with
one survivor, `t`, written `picked` having never been displayed: the same
unearned claim the win rule refuses to make, arriving by another door. It is also
what makes Keep the rest honest: it keeps everything, and claims only what was
looked at.

Writes go through `PhotosPresenter.setTriage`, which updates the grid row and any
open band member in place, so the gallery behind the viewer stays correct.

**Every triage value a session writes is one of three: `rejected`, `picked`, or
the photo's value when the session opened.** That last set is captured once, as a
`baseline: Record<photoId, Triage>` stored beside the session (§5), and it is
what every restore targets. Undo therefore needs to record only *which* photos an
action wrote, never what it overwrote, which is what makes §2.7's `changed` a
list of ids.

The baseline is captured at open and **never re-read from the member rows**,
because a rehydrate re-fetches those rows and they carry this session's own
rejections. Reading them again would make `rejected` the restore target for every
photo the session had already eliminated, so an undo after a refresh would put a
photo back in the pool and mark it rejected in the same breath.

**Writes are serialised, session-wide.** `api.updatePhoto` is a bare `fetch` and
nothing orders two writes to the same row, so a fast verdict followed by an undo
can land the restore first and the rejection second, leaving the server on
`rejected` while the session believes the photo is in the pool. One promise
chain, `this.writes = this.writes.then(…)`, the shape `refresh()` already uses, gives total ordering, which is stronger than per-photo ordering and needs no
stale-response detection: the second request is not sent until the first
resolves, so there is no stale response to detect. A session issues one or two
writes per human decision, so there is nothing to gain from parallelism.

**A failed write is reported, not compensated.** `PhotosPresenter.patch` catches,
toasts and resolves, so a caller cannot tell a rejection that landed from one
that did not, and the session would advance believing frames were rejected that
the server never took. `setTriage` therefore reports success, and the page keeps
a list of photos whose writes failed, shown in the bottom bar and again on the
summary as *n could not be saved · Retry*.

It does **not** rewind. Both failure directions are already safe: a failed
`rejected` leaves the photo untriaged, which destroys nothing, and a failed
restore is self-healing, since the photo either survives to be written `picked`
or is eliminated again. Rewinding would discard every verdict after the failed
round to compensate for a write that under-applied, and the compensating write
would travel the same failing path; a rewind that can itself fail and rewind
again, with nothing to terminate it.

**The closing writes are not fire-and-forget either.** The stored session
survives until every one of them has landed (§5), and the summary reports the
ones that did not rather than drawing them as keepers.

**The collection re-read is coalesced rather than suppressed.** `patch` awaits a
full `refresh()` whenever a triage field moves and the collection filters on
triage, which is the gallery default, so each verdict would re-read a block,
re-place every open band and re-run `photoPositions` for a screen nobody is
looking at, and the closing writes would do it N times over with the summary
waiting behind the backlog. The fix belongs in `refresh()`, not in a flag on
`setTriage`: a call arriving while one is pending collapses into a single
trailing re-read. That is the same bug the grid has today; holding `x` on the
Active filter queues one full re-read per keystroke, so fixing the class costs
three lines and no signature.

### 2.7 History, undo, and the queue

Every action pushes an entry: the session as it stood *before* the action, the
showing slot, what the photographer chose, and every photo the action wrote.

```ts
interface HistoryEntry {
  session: Session;                 // as it was BEFORE this action
  showing: 'a' | 'b';
  choice: Verdict | 'stopped';      // 'stopped' is Keep the rest
  changed: string[];                // photo ids this action wrote, in issue order
}
```

`showing` is in the entry because §3.1 makes the slot part of what the
photographer sees; restoring the pairing without it would leave the pinned slot
and the frame disagreeing. `choice` is in it because Completed has to *show* the
verdict, and it is not otherwise recoverable: it exists only as a diff against
the following entry's session, which the newest entry does not have. `changed`
is a list of ids rather than of previous values because every restore targets the
same baseline (§2.6).

**Rewinding to entry `i`**:

1. restore `history[i].session` and `showing`;
2. re-`PATCH` every id in the `changed` of entries `i` and after, deduplicated,
   to its baseline value;
3. **truncate `history` to length `i`.**

Step 3 is not bookkeeping. Without it the abandoned branch stays reachable:
rewind to round 0 of a four-round session, judge it differently, then press undo
twice, and the second undo restores entry 2's session, a pool from the branch
that was thrown away, with photos missing from it that no write ever rejected.
Completed would also keep listing rounds that no longer happened. Truncating is
safe precisely because step 2 has already restored everything those entries
wrote.

Deduplicating in step 2 is what makes the order not matter: one write per photo,
to a value that does not depend on which entry mentioned it.

- **Undo** (`Ctrl/Cmd+Z`, or `Backspace`) is rewinding to the last entry.
- **The queue** (below) is rewinding to any entry.

Snapshotting rather than inverting: `Session` is a small immutable value, so the
snapshot is cheaper to hold than an inverse operation is to get right, and one
assignment restores `alive`, `seen` and `stopped` together with no way for them
to disagree.

**Ending the session is part of the action that ended it.** `changed` is *every*
photo the action wrote, so when a verdict empties the pair set, the closing
`picked` writes join that verdict's entry, and undo reverses both and re-opens
the round. Keep the rest pushes its own entry, it flips `stopped`, which is a
change to `Session`, and its closing writes join that entry the same way. One
rule, both endings. A separate entry for a natural end would restore a session
for which `nextRound` is still null, so undo would land back on the summary it
was pressed from.

The ids are appended to `changed` **when each write is issued**, not when it
lands. Undo pressed on the summary while a closing `picked` is still in flight
would otherwise build its restore list without that photo, and the write would
land after the rewind, into a session that has resumed.

`status` is a computed, not a field: `loading` before the members arrive, `error`
if that fetch failed, `too-few` under two usable members, and otherwise
`round == null ? 'ended' : 'running'`. Derived rather than assigned for the same
reason `stopped` lives in `Session`; undo restores a session and nothing else,
so a `status` field would leave the photographer on a summary for a tournament
that had just resumed underneath it.

**The queue.** A button in the header opens a list in two parts:

- **Completed**, most recent first: each round's two thumbnails, in slot order,
  and the `choice` that was made, worded as the button was (*A better*, *Both*).
  Selecting one rewinds to it, so it can be judged again. This is the same
  operation undo performs, offered by name rather than by depth. The Keep the
  rest entry has no round to draw and is listed as the ending itself.
- **Upcoming**, in the order they would be asked: the rounds still to come,
  read-only and visibly inert, since a round that has not been judged is not
  somewhere to jump to.

It is a `PopoverButton` rather than an `ActionMenu`: a menu option is a label and
an icon, and a Completed row is two thumbnails. Opening it suppresses the verdict
keys for as long as it is open, for the reason a peek does (§3.1). Selecting a
Completed round does not confirm first; the house stance is report-with-an-undo,
and the rewind is itself the undo; but it is worth knowing that the rounds after
it are *discarded*, not merely stepped over, so this is the one place in the
screen where forward history is lost.

Upcoming has to assume verdicts it does not have, so it assumes the one that
makes it honest: **every remaining round draws.** That is exactly the run
`nextRound` and `applyVerdict` produce for `Both` repeated until null, so the
list is the pure functions run forward on a copy rather than a second
implementation of the schedule. It excludes the round on screen, which is not
still to come.

It is also the assumption that makes the list *stable in one direction*. Under
all-draw it is every pair still unseen among the pool, so **under any verdict
Upcoming only shrinks**: a draw removes the round just judged, a decisive verdict
removes every round the loser appeared in, and `Neither` removes both photos'
rounds. Assuming instead that the winner keeps winning would make it grow
whenever the winner lost, which reads as a plan that cannot be trusted. A rewind
restores the earlier, larger list, which is the whole point of a rewind and not a
counterexample to the claim.

The simulation stops at twenty rounds and the list says how many more there are.
A stack is seven frames in practice (§19.4.3), but a manual stack has no bound,
and C(n,2) at a thousand members is half a million rounds nobody will scroll.

The overflow count is `remainingPairs(session) − shown`, and never a second,
uncapped simulation. Under all-draw the run consumes exactly one unseen-among-the-
pool pair per round, so the full list length *is* `remainingPairs`, which is
also the `k` the bottom bar shows (§4), and is computed as
`C(n,2) − |{pair ∈ seen : both ids are in the pool}|`, one pass over `seen`.
Not `C(n,2) − |seen|`, which understates it once eliminations have left pairs in
`seen` naming photos that are gone; and not a scan of every pair of the pool,
which is the half-million-element loop the cap exists to avoid, one bar down.

## 3. Layout

### 3.1 Flip

One `PhotoStage` holding **both** of the round's frames, showing one at a time.
`photoKey` is the round, so the two are one photo as far as the stage's zoom and
pan are concerned: they survive the flip, which is exactly the gesture the mode
exists for, both frames at 100% over the same detail, alternating.

That needs a change to `PhotoStage`, and the change is not optional. Today the
frame being replaced is unmounted after three animation frames, and the render
list holds only `[retiring, painted, incoming]`; swapping `src` back and forth
would therefore remount and **re-decode** a full-size AVIF on every flip, on both
press and release.

Mounting both and toggling `opacity` is not enough either, and the component
already says why: its own `RETIRED_FRAMES` comment records that *an element
hidden with `opacity: 0` is never rasterised*, which is the reason a retiring
frame is held under its replacement for three frames. A naive alternate would
reintroduce that stall in the one gesture this mode exists for. **Both frames are
therefore promoted to their own compositor layer**, so each keeps a raster while
hidden and the flip is an opacity change the compositor applies without a repaint.
§6 specifies the props and this constraint together, because the prop without the
constraint is the bug.

The top bar is `A` · `↔` · `B`. A and B pin; `↔` is press-and-hold, showing the
other photo until release.

**A peek suppresses the verdict keys while it is held**, and clears on release,
on `pointercancel`, on the window losing focus, on `visibilitychange`, and on the
round changing. Both halves matter. Shift-held-then-arrow is an easy accident,
and it casts the exact inverse of what is on screen: the most destructive misfire
the screen has. And a `keyup` is never delivered for a modifier held across a
`Cmd+Tab`, so without the clears the peek sticks until the photographer thinks to
press and release the key again.

**The showing slot is kept when slot A holds the same photo it just held, and
reset to A when it does not**: the test is `round.a === previousRound.a`. A held-over winner
sits in slot A and the challenger takes B, so voting while looking at B opens the
next round still on B, which is the challenger: the one photo of the two not yet
seen. Voting while looking at A opens the next round on A, which is the same
photo, unchanged. That is deliberate: the alternative is a decisive verdict that
sometimes moves the picture and sometimes does not, depending on where the eye
happened to be. The round counter and the queue mark the advance; the frame is
not asked to.

Every other round puts a photo in slot A that was not there before, so there is
nothing to carry and it opens on A. Stating the rule as a comparison of slot A
rather than as "was there a winner held over" is what makes it cover the opening
round, `Both`, `Neither`, and a winner that has met everyone still in the pool,
without a case for each.

**Flip does not equalise area**, and split does (§3.2). One viewport with
`object-fit: contain` draws a landscape considerably larger than a portrait, the
same thumb on the scale §3.2 goes to some trouble to remove. Forcing equal area
here would mean sizing each frame independently inside one box, which is a second
layout system for the mode whose whole appeal is that both frames occupy the same
pixels. Stack members are takes of one scene and almost always share an aspect,
so this is priced as a limit (§10) with split as the answer for the pairs it
matters for, rather than as a feature.

### 3.2 Split, at equal area

Both photos get the **same displayed area**, whatever their orientation.

The obvious alternative is a common extent: both at one height in a row, both at
one width in a column. Its cost is that in a row it hands the two photos areas in
the ratio `aA / aB` exactly, which is 2.25× on a 3:2 beside a 2:3 and 7.5× on a
panorama beside a portrait. Size is persuasive, and a comparison tool must not
put a thumb on the scale.

Equal area is not even reliably the smaller picture. Where width is the binding
constraint, which is the usual case for a landscape pair in a wide viewport, it
uses *more* of the screen than a common height by `2(aA+aB)/(√aA+√aB)²`; across
the common camera aspects it matches or beats the common-extent rule more often
than not, and wins by 22% on the panorama pair. It gives up screen only where one
photo's aspect makes height the binding constraint, worst measured case a
portrait beside a wide landscape at about 7%. That is the trade: at most a few
per cent of pixels, against a size bias of up to several times.

With aspect `a = w/h` and displayed area `S`, a photo draws at `√(S·a)` by
`√(S/a)`. Writing `s = √S`, and `gap` for the gutter between the two photos:

- **row**: `s = min( max(0, W − gap) / (√aA + √aB),  H · min(√aA, √aB) )`
- **column**: `s = min( max(0, H − gap) / (1/√aA + 1/√aB),  W / max(√aA, √aB) )`

The gutter appears in one bound of each and not the other, because it is only
spent along the axis the photos are laid out on: two photos in a row share the
width between them and each has the full height to itself.

The clamp is inside the expression, not on the result, and that placement is
load-bearing. `S = s²` squares away a negative sign, so a box narrower than the
gutter would otherwise produce a positive area and render two small photos inside
a container of negative width, which looks like a layout rather than like
nothing.

Every constraint is a linear upper bound on `s`, so the smaller bound is the
maximum rather than merely a size that fits. The larger `s` wins, and each photo
draws at its size for that `s`; a tie goes to the row, which two squares in a
square box produce exactly, and which the function must not decide by accident.

`aA` and `aB` come from `PhotoSummary.width` and `.height`, which are positive
integers and display-upright, so `a = w/h` needs no orientation correction (§11).
They are on the list row, so the arrangement is known before a single pixel
decodes; reaching for `naturalWidth` instead would return NaN on the first frame
and, because both stages are sized together, blank the whole screen rather than
one half of it.

`W` and `H` are the space the two stages have between the bars, and they are the
one input this function cannot get from a store it already has. They are
**observables on `StackTriageStore`, written by the presenter from a
`ResizeObserver`** on the split container, which is the pattern the photos
presenter already uses for the grid's viewport: the measurement happens once per
resize, in the one place allowed to measure, and every render reads a number.
They are also the input that can legitimately be zero, during first paint or an
orientation change, which is what the clamp above protects against.

The alternative considered and rejected was two `flex: 1` children, letting
`object-fit: contain` size them. It is three lines of CSS, needs no measurement
at all, and for the equal-aspect pairs that are the norm in a stack it gives
equal area exactly. It was rejected because it does not *choose an arrangement*,
which is the requirement: it hands the transposed pair a 1.27× bias where the
formula gives 1.00, and it cannot switch to a column for the panorama pair that
needs one.

Given `W` and `H`, this is a pure function of four numbers and one constant. The
portrait-beside-landscape case needs no branch of its own.

Split mounts two stages, and each keeps its own zoom; synchronising them is
flip mode's job in v1.

## 4. The screen

Three bars. The verdicts are deliberately not adjacent to the view controls: a
three-way view switch beside a four-way verdict is a misclick generator, and here
a misclick rejects a photograph.

- **Header**, following `DetailNav`: the way back, the stack and its size, the
  **Queue** menu (§2.7), and the flip/split switch.
- **Top**, flip only: the `A` · `↔` · `B` switch.
- **Bottom**, both modes: `A better` · `Both` · `B better` · `Neither`, then
  `Undo`, `Keep the rest`, and the count: *n photos left, up to k rounds*. k is
  the number of pairs among the pool that are not in `seen`, counted by
  enumeration rather than as `C(n,2) − |seen|`, which understates it once
  eliminations have left pairs in `seen` naming photos that are gone.

k is an upper bound and only ever falls, for the reason the projected queue only
ever shrinks (§2.7); it is labelled *up to* so that a draw, which lowers it by
one while the pool stays the same size, does not read as a stalled counter.

Keys: `←` *A better*, `→` *B better*, `↓` or `Space` `Both`, hold `Shift` to peek
in flip mode, `Ctrl/Cmd+Z` or `Backspace` undo. Arrows because they point at the
slot they choose, which is literal in split and positional in flip, where the top
bar puts A and B on the same axis. The handler ignores events from `INPUT`,
`TEXTAREA` and `SELECT`, and takes `Ctrl/Cmd+Z` as the **only** modified chord,
ignoring every other modifier: `Cmd+←` and `Alt+←` are the browser's Back, and
without the guard navigating away would cast *A better* on the way out.
`Backspace` is offered beside `Ctrl/Cmd+Z` because it is what a photographer's
hand reaches for, and it is safe here in a way it is not elsewhere: the browsers
that mapped it to Back dropped that years ago. The keys go in `SHORTCUTS`
(`app.tsx`), the one place that lists the app's bindings for `?`.

`Neither` stays click-only. The only key left is `↑`, and it sits directly above
`↓`, a verdict that destroys nothing: the wrong neighbour for the one verdict
that destroys two photographs at once. It is a `variant="danger"` button, the
`destructive` flag the Bin uses is an `ActionMenu` option field, not a button
variant, and it reports *2 rejected* through `toasts.showUndoable`, the same
report-with-an-undo the bin uses, rather than asking first. The house stance on
destructive-but-reversible is that a confirmation on a repeated action is worse
than an undo.

`Escape` leaves the session, by the same route the header's way back takes.
`Tab`, not a letter, switches flip and split: every letter worth having is either
a verdict's neighbour or already bound in the viewer.

**Below about 700px the bars wrap**: the verdict group stays whole and on one
line, since a wrapped verdict row moves a destructive button under the cursor's
last position, and it is the count and the secondary actions that give way. The
bars' height is an input to §3.2, so a wrapping bar re-runs the arrangement
through the same `ResizeObserver` rather than needing its own path. Touch has no
`Shift`, so on a coarse pointer the peek is the `↔` button only, `touch-action:
none` on it so a long press does not raise the context menu.

**The verdict bar is disabled until both frames have decoded**, so a verdict
cannot be cast on a stage that is still building a rendition, and
`onImageMissing` is wired to `buildMissingRendition` exactly as the viewer wires
it. A stack whose members were never processed is otherwise a screen of *no
rendition yet* with live buttons under it.

The `A` · `↔` · `B` switch is a labelled group whose pressed state is announced,
and each new round is announced to a live region. The screen replaces its entire
content on a keystroke, which is otherwise a silent change.

**The session ends on a summary.** It is a screen rather than a return to the
viewer because the outcome is the thing the photographer came for and it is
otherwise invisible: the rejects have left the gallery's default filter, so
returning straight to the grid shows a stack that silently lost members.

It replaces the stage, keeping the header, and holds up to three labelled rows of
thumbnails: **Kept**, **Rejected**, and **Not saved** when any write failed, with
a Retry. A survivor that was never on screen; the Keep the rest case, is drawn
in Kept and marked *not compared*, because §2.6 goes to real trouble to keep that
distinction in the data and the screen would otherwise hide it. When `Neither`
has emptied the pool the summary says the stack was rejected entirely rather than
drawing an empty Kept row. Counts are of photos, not rounds.

Thumbnails are the `grid` rendition, which is what the band already draws and
what a contact-sheet row wants; the session rendition is for judging, not for
recalling. Clicking one opens that photo. Below them: Undo, and the way back.

**Prefetch is the first ten survivors.** Being derived from the pool, an
elimination tops it up with no bookkeeping, and the cap is there for a manual
stack of a thousand, where warming everything would be a thousand renditions
nobody asked for; §19.4.3 measured the largest real stack at seven frames, so in
practice this warms all of it.

The warm frames are mounted **by the page**, keyed by src, `aria-hidden` and
`pointer-events: none`, not through `PhotoStage`'s `preloadSrcs`, which is gated
on that stage having a frame up and would therefore unmount and re-warm the whole
set on every round. Keyed by src so that a survivor keeps its element and only
the eliminated photo's drops.

**Only the frames that can appear in the *next* round are drawn at stage size**;
the rest are warmed at any size. A decode is for the size an element is drawn at,
so a stage-sized warm is what makes the next round instant; but it is also a
full-resolution bitmap held live, and ten of those is hundreds of megabytes. At
most four photos can open the next round (the pool's first two after each of the
four verdicts), so four are drawn at stage size and the remaining six are fetched
warm, which puts the bytes in the HTTP cache without holding a raster. The cap of
ten is a fetch cap, which is what it was asked for as.

The session is judged at **one rendition throughout**, resolved by the triage
store from a **member row's own `library_id`**, against `LibrariesStore` and
`AppSettingsStore` directly, by the rule §18.5 states: the library's
`rendition_source`, with the settings' viewer-rendition mode on top.

It cannot reuse `PhotosStore`'s answer, and the reason is worth stating because
the names are inviting. `showing`, `preferredRendition`, `defaultRendition` and
`isAlwaysBuilt` are every one of them a function of `openPhoto`, which is
`photoFor(open?.id)`. Nothing clears `open` when the viewer unmounts, so from a
viewer entry all four answer for the **entry photo**, including, under
`remember_per_photo`, that one photo's remembered choice; which is precisely the
inheritance this paragraph exists to prevent. And on a refresh or a deep link into
the triage route there is no open photo at all, so `defaultRendition`'s library
lookup misses and returns `'embedded'`: the camera JPEG, in a `render` library,
for the one screen in the app whose purpose is pixel-peeping, with the session
silently changing rendition across a reload.

## 5. Entering, leaving, and surviving a refresh

The viewer's `DetailNav` gains a **Triage Stack** button beside the Rendition
menu, rendered when the photo has `stack_id != null`.

On `stack_id` alone, deliberately, and **not** on the grid tile's
`stack_id != null && stack_size > 1`. `stack_size` is a property of a collapsed
listing row, not of a photo: `toDetail` and the band-member listing both hardcode
it to 1, and in a scoped listing it counts only the members that survived the
filter. Every route into the viewer from a stack is therefore a `stack_size` of 1; a band member opened from an expanded stack, or a deep link, so the tile's
condition would hide the button on every path that can actually reach this
screen, and in an album would disagree with the unscoped member list the session
runs over. A stack has two or more members by construction, and any that drops
below two is dissolved, so `stack_id != null` is the honest test; the
"fewer than two usable members" page below covers a stack whose members have been
binned underneath it.

It navigates to `/stacks/:stackId/triage`. **Leaving is an explicit route to the
entry photo**, recorded in the session, falling back to its library. Not
`navigate(-1)`: nothing in the app uses it, and it strands anyone who refreshed,
or who opened the URL directly, on a history stack with nothing behind it.

The session opens on `listStackPhotos(stackId)`, which already excludes deleted
members server-side; missing ones are filtered here, **before** the count that
decides `too-few`, or a stack of two with one missing would open a tournament of
one. Every remaining member competes whatever its current triage, including one
already rejected: re-running the flow is a clean re-decision, and a rule that
excluded them would make a stack impossible to reconsider.

**The pool starts in the order the server returned**, which `memberIds` defines
as newest first. Not re-sorted into capture order: the ordering decides which
pairs are asked and in what order, so it has to be stated somewhere, and the
server's is the one the rest of the app already shows a stack in.

The fetch is guarded by re-checking the stack id after the await, a double mount
or a quick switch between stacks must not let an earlier response overwrite a
session that has since been rehydrated and validated. One comparison, not
`toggleBand`'s generation counter: nothing here moves underneath the fetch the
way a collection's rows do.

**The session is stored** under `bowerbird.triage.<stackId>` in `sessionStorage`,
on every change, and is cleared only once the closing writes have landed (§2.6).
`sessionStorage` rather than `localStorage` because a tournament is a thing the
photographer is in the middle of, not a preference: a session found in a tab
opened last week would be a set of half-made judgements about photographs whose
gallery has moved on. The stored shape is JSON, so **`seen` is written as an
array and rebuilt into a `Set` on load**. `JSON.stringify` renders a `Set` as
`{}`, which would silently return every session to a blank draw history and
re-offer pairs already judged, breaking the §2.4 guarantee in the one place
nothing would notice.

Stored with the session: the **history**, the **baseline** map (§2.6), and the
**entry photo id**. The history because the queue makes dropping it untenable; the Completed list would be empty after a refresh and the button that reaches a
past round would be dead while still drawn. The baseline because it is the one
thing that cannot be recovered from the server once the session has written over
it. The entry photo because it is the way back, and a refresh is exactly when the
history stack that would otherwise answer is gone.

**History is capped at the most recent 50 entries.** Each entry snapshots a whole
`Session`, `seen` included, so an unbounded history is O(N²) bytes on a large
manual stack, and the storage write is in a swallowing `try`/`catch`, the quota
error would be silent and refresh-survival would simply stop working with no
signal. Beyond 50 the oldest entries drop, so the Completed list is finite and
undo has a floor.

On open the stored session is rehydrated and then **validated against the
freshly-fetched members, by pruning `alive` only**. An id that is no longer a live
member is dropped from the pool, and nothing else changes. `seen` is deliberately
left alone: a pair naming a dead photo can never be offered again, since both
its members must be in the pool for `nextRound` to reach it, so pruning it buys
nothing, and §2.6 derives *this photo was on screen* from appearing in some pair
of `seen`, so dropping a survivor's only judged pair would silently demote a
considered keeper out of the closing `picked` write.

Re-deriving `alive` from the member list instead of pruning would return every
eliminated photo to the pool. Its round would at least not be re-offered, since a
decisive pair is in `seen`, but the photo would be back in contention having
already lost, which is worse than either.

Rehydration happens **only when the store holds no session for that stack**, so
navigating back to the viewer and forward again reuses the live session and its
history rather than reloading a copy and discarding what is in memory.

A stored shape that does not parse is discarded rather than allowed to break
opening the session, following `view_state.ts`.

The session key is removed when the closing writes land, so a reload on the
summary finds no session, and must not silently start a fresh tournament over
photos just judged. The cleared key is replaced by a `bowerbird.triage.done.<id>`
marker holding the outcome, which the page reads to draw the summary again, and
which is what a stale key from a session whose writes never landed is swept
against on the next open of any stack.

The mode, flip or split, is a preference about the machine rather than about the
stack, so it goes to `localStorage` under `bowerbird.triage.mode`. Two lines,
read with a membership check, rather than a `view_state.ts`-shaped module: that
one earns its validation by keying five source kinds and parsing a compound
object, where this is a single enum.

## 6. Changes to existing components

Four. The first is a prerequisite rather than a nicety, and is the largest single
piece of work in the feature.

**`PhotoStage` holds a pair.** `pair?: [string, string]` and `showing?: 0 | 1`,
alongside today's single `src`. This is not one prop on top of the existing
machinery: that machinery is single-slot throughout; one `incoming`, one
`incomingRef`, one `painted`, one `natural`, and a render list of exactly
`[retiring, painted, incoming]`; so both members need their own decode, their
own promote and their own measured size. `incoming = src === currentFrame ? null
: src` in particular means a source that is mounted but not showing never becomes
`incoming`, never reaches the decode effect, and never promotes, so a naive
alternate would be a frame that silently never loads.

Three constraints the implementation must meet, each of which is a bug if missed:

- **Both frames keep a raster while hidden**, via their own compositor layer
  (§3.1). Opacity alone un-rasterises, which is the stall the mode exists to
  avoid.
- **Both frames report their decode**, because §4 disables the verdict bar until
  both are up. `onImageLoad` fires only from `promote()`, i.e. only for the
  source that becomes visible, so it grows an argument naming which source
  loaded. Existing callers ignore it. `onImageMissing` needs the same argument,
  or a 404 cannot be attributed to a photo and `buildMissingRendition` has
  nothing to name.
- **`natural` follows the showing source, and `view` is re-clamped when it
  changes.** `clampPan` is applied only inside `zoomBy` and `onPointerMove`
  today, so flipping to a differently-shaped frame while panned leaves an
  out-of-range offset until the next drag.

**`PhotoStage` fullscreen is fixed to its own element**, in both places.
`setFullscreen` reads `document.fullscreenElement != null`, so with two stages
mounted one entering fullscreen puts the other into the fullscreen presentation
as well: black background, `100vh` viewport, tools gone, a floating exit bar over
a stage that is not fullscreen. `toggleFullscreen` reads the same global, so
pressing Fullscreen on the second stage while the first is fullscreen **exits the
first** instead of entering the second. Both become
`document.fullscreenElement === stageRef.current`. This is a bug in the component
today, not a triage requirement; split mode is merely the first thing to mount
two of them. The `f` key is separately window-level and needs the
`keyboard?: boolean` prop, default true, passed false to the second stage.

**`PhotosPresenter.setTriage` reports whether the write landed.** §2.6 needs a
caller that can tell, so the result becomes a boolean. Its existing callers
ignore it and are unaffected. `patch`'s error toast is suppressed for triage
writes made from a session, which reports failures itself and in one place
(§2.6); without that, one failed verdict raises both a toast and a bar.

**`PhotosPresenter` serialises writes and coalesces `refresh()`.** Both belong
here rather than in the triage presenter, and both fix the class rather than the
instance: the write ordering hazard is `api.updatePhoto` racing itself for *any*
caller, and the refresh pile-up already happens when the grid holds a cull key on
the Active filter. A triage presenter fixing them locally would leave the viewer
and the grid racing exactly as they do now.

## 7. Files

Feature folder `web/src/features/photos`, following the store / presenter /
component split, and the existing precedent of a pure module with its own tests
beside the presenter that drives it (`bands.ts`, `grid_layout.ts`,
`selection.ts`).

| file | holds |
|---|---|
| `stack_triage.ts` | the tournament and the layout, pure (below) |
| `triage_storage.ts` | the stored session under `bowerbird.triage.<stackId>`, its array-shaped `seen`, the done marker, and the mode |
| `stack_triage_store.ts` | observables and computeds only (below) |
| `stack_triage_presenter.ts` | every mutation: `open`, verdicts, `keepTheRest`, `rewindTo`, `setMode`, `setShowing`, the triage writes, the storage writes, the `ResizeObserver` |
| `stack_triage_page.tsx` | the route `/stacks/:stackId/triage`, registered in `app.tsx`, the two layouts, the queue popover, the summary, the keyboard layer |

The pure module, stated to the signature so that the page, the presenter and the
tests cannot each invent a different one:

```ts
export type Verdict = 'a' | 'b' | 'both' | 'neither';
export interface Round { a: string; b: string }
export interface Session { alive: string[]; seen: ReadonlySet<string>; stopped: boolean }
export interface Shape { width: number; height: number }
export interface Placed { direction: 'row' | 'column'; a: Shape; b: Shape }

export const UPCOMING_SHOWN = 20;
export const SPLIT_GAP = 16;                       // px, the gutter in §3.2

export function pairKey(x: string, y: string): string;        // sorted, joined with '|'
export function pairHas(key: string, id: string): boolean;
export function openSession(ids: string[]): Session;
export function nextRound(session: Session): Round | null;
export function applyVerdict(session: Session, round: Round, verdict: Verdict): Session;
export function losersOf(round: Round, verdict: Verdict): string[];
export function stop(session: Session): Session;
export function keepers(session: Session): string[];           // survivors seen in some pair
export function remainingPairs(session: Session): number;
export function upcomingRounds(session: Session, limit?: number): Round[];
export function arrangement(aA: number, aB: number, w: number, h: number): Placed;
```

`losersOf` exists so the verdict table (§2.3) is written once: the presenter needs
the ids to write `rejected` and would otherwise carry a second copy of it.
`keepers` is the §2.6 rule, so the closing writes cannot drift from the
guarantee. `applyVerdict` applies what it is given without checking the round
against `nextRound`; the presenter is the one place a verdict can be cast, and it
casts the round on screen.

The store, observables and computeds only:

```ts
stackId: string | null;  members: Map<string, PhotoSummary>;  baseline: Map<string, Triage>;
session: Session | null; history: HistoryEntry[];  showing: 'a' | 'b';
mode: 'flip' | 'split';  entryPhotoId: string | null;  failed: Set<string>;
loadError: string | null;  splitWidth: number;  splitHeight: number;
@computed round;  @computed status;  @computed rendition;  @computed warm;  @computed placement;
```

`splitWidth` / `splitHeight` are the §3.2 inputs, written by the presenter from a
`ResizeObserver`. `status` and `round` are computed rather than assigned, for the
reason §2.7 gives.

`StackTriageStore` takes `LibrariesStore` and `AppSettingsStore`, the same two
`PhotosStore` takes, and the two the rendition rule needs (§4). Not `PhotosStore`,
whose rendition members all answer for the open photo and whose peers are private.
`StackTriagePresenter` takes `PhotosPresenter`: **every write goes through it**,
and no store depends on a presenter.

Holding `session` as one `@observable.ref` is what makes a rewind a single
assignment: the tournament's whole state is one immutable value, so restoring a
snapshot cannot leave `alive`, `seen` and `stopped` disagreeing.

Wired in `stores_context.tsx` after `photos`, whose presenter it depends on.
`useCurrentLibraryId` in `app.tsx` learns `/stacks/*` too, or the rail loses its
library highlight for the whole session.

## 8. API

None. `listStackPhotos` (§19.5.3) supplies the members and `PATCH /api/photos/:id`
records the verdicts.

## 9. Testing

`stack_triage.ts` is pure and carries the correctness of the feature, so it takes
the unit tests:

- a run of decisive verdicts over N photos is exactly N−1 rounds and returns one
  survivor, whether the held-over winner keeps winning or each challenger takes
  over
- an all-draw run over 4 photos is exactly 6 rounds, every pair once, then ends
- over a randomised verdict sequence: no round is ever offered twice, and at
  exhaustion every pair of the keep set is in `seen` and none of those rounds was
  decisive
- a decisive verdict puts the winner at the front of the pool and the next round
  pairs it with the first photo it has not met; when it has met them all, the
  next round is a pair not containing it
- the §2.4 worked case: `p` and `q` draw, `r` then beats the rest, and the session
  still offers `r` against `p` and `r` against `q` before ending with all three
  kept
- `Neither` on the last two photos ends the session with no survivors, and a lone
  survivor that appears in no pair of `seen` is not written `picked`
- `upcomingRounds` is the all-draw schedule, excludes the round on screen, shrinks
  under every verdict, and is capped; `remainingPairs` equals the uncapped length
- `pairKey` is order-independent, and a `seen` round-tripped through the stored
  array shape still matches the pairs it held

`arrangement` takes the aspects and the box, so its cases are named by number
rather than by adjective, the earlier draft said "a panorama beside a portrait
chooses the column", which is false at 3:1 (it chooses the row, 621 against 490)
and only becomes true past about 4.5:1:

- both photos land at exactly equal area and exactly their own aspect, and both
  fit inside the box, for `(1.5, 1.5)`, `(0.667, 0.667)`, `(1.5, 0.667)`,
  `(1.0, 1.778)` and `(5.0, 0.667)` in a 1600×900 box
- of those, only `(5.0, 0.667)` chooses the column; the rest choose the row, two
  portraits included, which is the answer that looks wrong and is not
- `(1.0, 1.0)` in a square box ties, and the tie chooses the row
- a box narrower than the gutter still returns a non-negative `s` with both photos
  inside it, rather than a negative `s` squared back into a positive area

Three behaviours live outside the pure module and are the riskiest in the feature,
so they take tests of their own against a mocked presenter:

- **rehydrate and prune**: a stored session whose members changed underneath it
  comes back with the pool pruned, `seen` untouched, and the baseline map intact
  rather than re-read from the members
- **rewind**: rewinding to entry `i` re-writes exactly the photos entries `i` and
  after touched, to their baseline values, once each, and truncates the history
  so that a later undo cannot reach the abandoned branch
- **a failed write** is reported and does not rewind, and the session's own view
  of the pool is unchanged by it

`PhotoStage` is the other risk, because the pair support rewrites machinery the
whole app renders through. Its current single-`src` behaviour is pinned by e2e
first, zoom survives a rendition change, resets on a step to the next photo, and
a step does not blank the stage, and the refactor runs against those.

The page takes an e2e: enter from the viewer, run a three-frame stack to a
summary, reach a past round through the queue and re-judge it, and confirm the
keep set reads `picked` and the eliminated `rejected`. The stack fixture needs a
third frame, in its own name list rather than in the shared `PHOTO_NAMES`, and
the spec has to opt its library into auto-stacking, which fixture libraries
otherwise have off.

## 10. Limits

- Worst case is N(N−1)/2 rounds. Keep the rest is the escape, and it forfeits the
  §2.4 guarantee for the rounds never asked.
- Elimination assumes transitivity, so the result depends on round order.
- A session overwrites triage verdicts made elsewhere (§1).
- Flip does not equalise displayed area between a landscape and a portrait; split
  does.
- Split-mode zoom is unsynchronised; flip mode is the path for pixel-peeping.
- The undo history is stored per session and per stack, and capped at 50 entries:
  leaving a session and opening a different stack does not carry it, there is no
  cross-session history, and a very long session cannot be undone to its start.
- Reaching a past round through the queue discards the rounds after it. That is
  the one place forward history is lost.
- Writes that fail are reported and left failed; the session does not roll back
  around them.
- Entry is from the viewer only; a grid band has no triage action yet.
- The session is judged at one rendition throughout, and there is no rendition
  control on the screen.
