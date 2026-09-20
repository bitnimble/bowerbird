# Photo Stacks, Design

Date: 2026-07-29

A **stack** groups photos that are visually the same shot: a burst sequence, or
several takes of one scene. It is one entity in the library, shown as one tile,
expandable to its members.

## 1. Scope

- Automatic detection of stacks, on by default, per-library, with a tunable
  minimum similarity and a tunable time window.
- Manual stack creation from a multi-photo selection.
- Collapsed presentation in the library, shoot and album grids; expansion in
  place; unstack and remove-from-stack actions.
- A stack is **library-global**: it transcends shoots and albums.

Out of scope: stack navigation in the photo viewer / detail page. Opening a
member opens that photo, unchanged.

## 2. Data model

```sql
CREATE TABLE stacks (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin       TEXT NOT NULL CHECK (origin IN ('auto','manual')),
  date_created TEXT NOT NULL
);

CREATE INDEX idx_stacks_library ON stacks(library_id);
```

`origin` is load-bearing rather than informational. Detection re-runs over
already-stacked photos so that changing the similarity threshold re-forms
stacks (§4.3); without `origin` that pass would dissolve a manual stack whose
members are not similar; two lenses on the same subject, which is precisely
the case manual stacking exists for.

Added to `photos`:

```sql
stack_id     TEXT REFERENCES stacks(id) ON DELETE SET NULL,
stack_state  TEXT NOT NULL DEFAULT 'none'
               CHECK (stack_state IN ('none','stacked','unstacked')),
descriptor   BLOB,  -- perceptual descriptor, ~1.3 kB (§3); NULL until the tile is built

CREATE INDEX idx_photos_stack ON photos(stack_id);
```

`stack_state` is the three answers to "is this photo in a stack?":

| value | meaning | detection may claim it |
|---|---|---|
| `none` | never been in one | yes |
| `stacked` | currently in one | yes, if the stack is `auto` |
| `unstacked` | a human pulled it out | **never** |

`stack_state = 'stacked'` iff `stack_id IS NOT NULL`. The invariant is written
by the repository in one transaction rather than by a `CHECK`, because a
library delete cascades both `stacks` and `photos` in an order SQLite does not
define, and a spanning `CHECK` would fire mid-cascade.

Added to `libraries`, matching the per-library `rendition_source` precedent:

```sql
auto_stack                INTEGER NOT NULL DEFAULT 1,
auto_stack_similarity     REAL    NOT NULL DEFAULT 0.78,
auto_stack_window_seconds INTEGER NOT NULL DEFAULT 60
```

The similarity default is 0.78 rather than a rounder number because that is where
the spike reproduced the labelled groups (§9); the gap it sits in runs from 0.74
to 0.79.

## 3. The descriptor

Computed in Rust (`native/rawshim`), never in TypeScript (§8). Stored on the
photo when its grid tile is built, off the image handle the tile builder is
already holding, so it costs no extra decode.

It must survive, for the same scene:

- a different exposure
- slight camera shift or rotation between frames
- different transient subjects (people walking through)
- a different white balance or colour profile
- moderately different zoom / framing / direction

A 64-bit hash cannot do this, and the spike (§9) measured how badly: dHash and
DCT pHash both score the labelled pairs *below* hand-verified different-scene
pairs, so no threshold exists that keeps one without the other. What works is a
larger, deliberately blurry descriptor:

| part | size | what it buys |
|---|---|---|
| luma grid | 20×20, box-averaged, **rank-normalized** | rank-normalizing is the exposure and white-balance invariance: any monotonic tone curve leaves the cell ordering alone, so it leaves the descriptor alone |
| chroma grid | 20×20 of chromaticity after grey-world normalization, each channel rank-normalized | "the warm part is along the top", which is what separates a sunset from the white plaza beside it |
| coarse luma grid | 10×10, rank-normalized | alignment search only (below) |

Aspect is **squashed**, not fitted: a crop or a second body gives one scene two
aspect ratios, and that must not read as a difference.

Every grid is built twice: over the whole frame, and over its **central 78%**.
Stepping closer to a subject is a crop plus a resample, and nothing else in the
descriptor sees it, because a dolly scales every cell at once, which the trimmed
mean reads as most cells disagreeing.

The crop is centred, and measurably has to be: sliding it off centre lifts the
different-scene pairs far more than the same-scene ones (§9).

Two descriptors are compared at three pairings: both whole, then each one's
whole frame against the other's crop. Cropping both sides is the same view as
cropping neither, so that pairing is skipped. At each pairing:

1. Find the offset that best lines the two 10×10 coarse grids up, over ±1
   coarse cell.
2. At twice that offset, take the **trimmed mean absolute difference**, the
   best 75% of cells, of the 16×16 centre of each 20×20 grid against the
   other's window, for luma and for both chroma channels. Trimming is the
   occlusion tolerance: somebody walking through changes a handful of cells
   completely, and a plain mean lets those few cells outvote the scene they are
   standing in.
3. `similarity = 0.7·luma + 0.3·chroma`, clamped to `[0, 1]`.

The highest-scoring pairing wins. The three ratios span 0.78× to 1.28×, so a
frame stacks with one shot from roughly a quarter closer or further; beyond that
it falls out, which is what happened to the boat range's widest pair. A second
centred crop was measured and bought nothing a single one did not (§9).

Searching the alignment coarsely and then evaluating once, rather than
evaluating all 25 offsets at full size, is 19× faster for 0.014 of margin
(§9), the difference between a detection pass measured in seconds and one
measured in minutes.

Stored as `u8` per cell: 1.3 kB per view, so ~2.6 kB per photo, or ~260 MB for a
100k library. Large enough to notice in a SQLite file, negligible against the
~8 TB of RAW such a library holds. If it ever needs halving, the measured lever
is chroma resolution: at 10×10 it cost 0.017 of margin.

The contract:

- Rust computes the descriptor from the image handle the tile builder already
  holds, and **Rust also runs the comparison** (§4.3). No pixels and no
  descriptor maths cross into TypeScript.
- Similarity is in `[0, 1]`, which is what `auto_stack_similarity` thresholds.
- It is stored on the photo row, so detection is a database scan, not a decode.

## 4. Detection

### 4.1 When

After a sync finishes its processing stage, per library, when `auto_stack` is on
**and that sync added or changed photos**. No separate "scan now" control: a
manual sync is already the way to ask the library to re-look at itself, and a
second button for the same thing is a second thing to explain.

The added-or-changed condition is not an optimisation, it is what makes the
watcher survivable. `watch_enabled` defaults on with a 2s debounce, so saving a
file in a library triggers a scoped sync; without the condition each one would
re-sort and re-clique the whole collection. The sync already counts
`photos_added` and `photos_modified`, so the condition is those being non-zero.

### 4.2 Candidates

Photos in the library where:

- `stack_state IN ('none','stacked')`, and
- the photo is not a member of a `manual` stack, and
- the descriptor is not NULL, and
- the photo is not deleted or missing.

**There is no backfill.** The descriptor is written when a photo's grid tile is
built, so a photo imported before this feature has none and is never a candidate;
a library that already exists therefore stacks nothing until it imports something
new. This is a deliberate choice to not spend a pass over every existing photo
for a feature whose value is in what arrives next. The escape hatch costs
nothing extra: because the descriptor rides along with tile building, the
existing `POST /photos/rebuild-tiles` backfills a library as a side effect for
anyone who wants their history stacked.

Deliberately **no camera or lens gate**. Shooting one subject with two bodies or
two lenses to compare them later is a case stacking should serve, not exclude.
The time window is the only prefilter, which is why it is a setting.

### 4.3 Algorithm

Sort candidates by `COALESCE(date_taken, date_added)` and walk them once,
growing one stack at a time. The next photo joins the stack being built when
both hold:

- **it is adjacent in time**, no more than `auto_stack_window_seconds` after the
  photo before it, *not* after the stack's first photo, so a stack may chain
  arbitrarily far in time; and
- **it clears `auto_stack_similarity` against every photo already in the stack**,
  not merely against its neighbour.

Otherwise the stack closes and a new one starts at that photo. Groups of two or
more become stacks.

The clique requirement is what bounds a stack, and it removes the need for any
separate guard against chaining: a scene that drifts frame by frame reaches a
point where the newest photo no longer matches the one the stack started from,
and the stack ends there on its own. Measured on the labelled folder, the
largest stack produced is six frames (§9).

The whole loop lives in Rust behind one entry point taking the descriptors,
their timestamps, the threshold and the window, and returning a group index per
photo. TypeScript reads the rows, calls it once, and writes the stacks. A
comparison is ~15µs of descriptor maths rather than a popcount, which is not
something to run a million of across the FFI boundary one call at a time.

The pass rewrites every `auto` stack in the library from scratch. Raising the
threshold splits stacks, lowering it merges them, and the way to apply a
settings change is to sync. `unstacked` photos and `manual` stacks are
invisible to it.

The single walk makes the cost `n · s`, where s is the size of the stack being
built, never `n²`, and not a function of the window at all. Measured at **23k
comparisons per second** on one core with the scale search (66k without it), and
with the largest stack on real frames being seven, a 100k library is well under a
million comparisons: under a minute single-threaded, seconds across `rayon`,
which the crate already depends on, once per sync.

### 4.4 The human boundary

Any manual edit, create, add, remove, unstack, sets the stack's `origin` to
`manual`, and detection stops managing it permanently. Remove and unstack
additionally set every affected photo to `stack_state = 'unstacked'`.

## 5. Reading stacks

### 5.1 Collapsing

Collapsing happens in SQL, so a stack costs one row of a page and one unit of
`total`. In `photos_repository`, the scoped listing becomes:

```sql
WITH scoped AS (SELECT … FROM photos WHERE <scope + filters>),
reps AS (
  SELECT *,
    COUNT(*) OVER w AS stack_size,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(stack_id, id)
                       ORDER BY COALESCE(date_taken, date_added) DESC, id) AS rn
  FROM scoped
  WINDOW w AS (PARTITION BY COALESCE(stack_id, id))
)
SELECT … FROM reps WHERE rn = 1 ORDER BY <ordering> LIMIT ? OFFSET ?
```

with `total` becoming `COUNT(DISTINCT COALESCE(stack_id, id))` over `scoped`.

Two properties fall out of partitioning `scoped` rather than `photos`:

- **Album strictness is free.** `scoped` is already album-limited, so a member
  outside the album is not merely hidden, it does not exist to the query.
- **Filters compose correctly.** Filter out the newest member and the
  next-newest survivor becomes the representative, rather than the stack
  vanishing.

`PhotoSummary` gains `stack_id` and `stack_size`.

### 5.1.1 Positions, and where a stack becomes its members

The virtual grid (§18.3.2) selects by **position**, not by id: a selection is
runs of positions in the listing, and `PhotosService.resolve` turns those runs
into ids server-side via `photos_repository.idsAt`, which numbers rows with
`ROW_NUMBER() OVER (ORDER BY …)`. Two consequences, and they are the whole of
how stacks meet bulk actions:

- **`idsAt` must number the same collapsed listing the grid was built from.** It
  gets the identical CTE, or position 400 means one photo to the client and a
  different one to the server. The collapse therefore belongs in a helper both
  the listing and the numbering call, not written twice.
- **`resolve` is where a selected stack becomes all of its members.** Numbering
  yields one row per stack; expanding those rows to every member id is one join,
  in one place, and it is what makes "select everything, bin it" bin whole
  stacks without the client ever holding a member id. The §6 decision that bulk
  actions apply to the whole stack needs no client support at all.

### 5.2 Scope rules

- The representative is the newest **in-scope** member, so a shoot never shows
  a tile for a photo that is not in it.
- A stack spanning shoots is the **common** case, not an edge one: shoots now
  mirror the library's folders, so any stack whose photos sit in two folders is
  a stack spanning two shoots. The out-of-shoot overlay earns its place rather
  than serving a rarity.
- `stack_size` is the full member count in library and shoot views, and the
  in-album count in album views.
- A stack with one visible member renders as an ordinary tile.

### 5.3 Expansion

`GET /api/stacks/:id/photos?album_id=` returns the members, album-filtered when
an album is given. The shoot view needs no server support: `PhotoSummary`
already carries `shoot_id`, so the client knows which members are outsiders and
overlays them itself.

## 6. UI

Feature folder `web/src/features/photos`, following the existing store /
presenter / component split.

**Collapsed tile.** The representative's tile, plus a stack badge (layers icon
and the member count).

**Expansion.** Clicking a stack tile opens a **band of fresh rows directly below
the row that tile sits in**. The tile stays where it is and takes a dark overlay
with a down chevron, which is also how the stack closes: click it again. No
chevrons flanking the members.

The members live alone in that band, never sharing a row with photos outside the
stack, so no tile ever changes which neighbours it sits beside. The grid below is
displaced downwards by the band's height and otherwise untouched. A band needing
more than one row is simply more rows in the same band.

`visibleRows` (`web/src/ui/virtual_rows.ts`, shared with the Shoots page) takes
**one** `rowHeight` for the whole list, so band rows are ordinary tile rows at
the same cell geometry, marked by their background rather than their size. That
is what keeps the scroll a multiplication: an expansion changes how many rows
there are and what sits in them, never how tall a row is. Anything that gave a
band its own height would put the scroll height back into the DOM, which the
virtual grid exists to avoid.

**Any number of stacks may be open at once.** Expansions are a list of
`(position, member count)` sorted by position; `rowCount` is the base rows plus
each band's `ceil(members / columns)`, and mapping a display row to a collection
position is a prefix-sum walk over that list. Two consequences to build
deliberately rather than discover:

- **Opening a stack above the viewport must not move the view.** The band
  displaces everything below it, so opening one above the current scroll
  position adds the band's height to `scrollTop` in the same action. Heights are
  arithmetic here, so the correction is exact rather than a measurement.
- **Expansions survive a collection change; their coordinates are recomputed.**
  A band is identified by its `stack_id`, never by the position it was opened at,
  so ordering changing, a filter landing, or a sync inserting rows moves where it
  is drawn without closing it. See §6.1.

In `masonry` mode a band is content inside its block: the block reflows, its
`ResizeObserver` reports the new height, and `blockTops` shifts the rest, with no
row arithmetic involved. In `list` mode the members are simply more rows.

**Shoot overlay.** In a shoot view, an expanded member whose `shoot_id` differs
from the current shoot gets a dark overlay with an icon and "not in this shoot".

**Selection.** Selecting a collapsed tile selects **one position**, because
selection is positions and ids never reach the client for anything but the window
on screen. The stack becomes its members server-side in `resolve` (§5.1.1), so
every bulk action still applies to the whole stack.

**A band's members have no position of their own.** The listing is collapsed, so
the server numbers one row per stack and members are not in that numbering at
all; a member selection cannot be a `SelectionRanges` run. Members are instead
selected **by id**, in a set held beside the position ranges. This stays inside
the rule the virtual grid enforces rather than bending it: what must never happen
is an id standing in for an *unloaded* position, and a band's members are loaded,
on screen, and few.

The two selections are separate, and the bulk bar acts on whichever is non-empty.
Selecting inside a band does not carry a collection-wide position selection into
it, which is also the behaviour to want: "everything in this library" and "these
three frames of this burst" are different intentions.

The bulk bar therefore counts *entries*, where a stack counts as one, and says
so: "3 selected (7 photos)" needs a photo count the client does not have for
unloaded positions, so the count shown is of entries and the actions are honest
about covering whole stacks.

**Bulk bar actions.**

| action | shown when |
|---|---|
| Stack | two or more entries selected |
| Unstack | the selection is a single position that is a stack |
| Remove from Stack | the selection is band members, of one stack or several |

Stacking a selection that already contains stacked photos moves those photos
into the new stack; any stack left with fewer than two members is deleted.

### 6.1 Keeping bands and the scroll put

A band stays open across anything that moves positions. Its coordinates are
recomputed instead, and the scroll is rewritten so the view does not move.

**A row's identity is `COALESCE(stack_id, id)`**; the same key the collapsing
CTE partitions on (§5.1). That key is what the store holds for an open band and
for the scroll anchor, and positions are derived from it rather than stored.

On any refresh, re-ordering or filter change:

1. **Re-resolve each open band's position.** For a band whose row was re-read,
   `selection.rebase`'s samples already say where it went. For one outside that
   domain the client genuinely does not know, and must not guess: `rebase` drops
   positions outside its domain precisely because a nearest-shift guess silently
   renames photographs. So the position is asked for.
2. **One query for every band, not one per band.** Numbering rows costs a sort of
   the whole collection, which is the lesson `idsAt` already records; ten open
   bands must not mean ten sorts. `positionsOf(keys)` numbers once and reads all
   the wanted keys out of that numbering, exactly as `idsAt` reads runs.
3. **Rewrite `scrollTop` from the anchor.** Before the change, the store records
   the row key at the top of the viewport and the pixel offset within its row.
   After, the new position of that key plus the band heights above it give the
   scroll position exactly, every input is a number the store already holds, so
   this is arithmetic, not a measurement.

A band closes only when its stack genuinely leaves the collection: a filter that
excludes every member, or an unstack. A stack reduced to one visible member
renders as an ordinary tile (§5.2), which closes its band with it.

**Settings.** A "Stacks" panel beside "Renditions" in each library's settings:
the toggle, minimum similarity, and stack window in seconds.

## 7. API

| method | path | purpose |
|---|---|---|
| `GET` | `/api/stacks/:id/photos` | members; `?album_id=` filters strictly |
| `POST` | `/api/photos/positions` | positions of a set of row keys in a scoped, ordered, filtered listing, numbered once (§6.1) |
| `POST` | `/api/stacks` | create from `photo_ids`; returns the stack |
| `DELETE` | `/api/stacks/:id` | unstack: release every member, delete the row |
| `POST` | `/api/stacks/:id/remove` | remove `photo_ids` from the stack |

All four are `manual` operations per §4.4.

## 8. The Rust pixel boundary

A prerequisite to this work, and the reason the descriptor is not computed in
TypeScript. Today nothing in production reads RGB out of Rust, `pixels()`,
`imageFromRgb()` and `hdrGradedSamples().data` are consumed only by integration
tests, as is `raw_decoder.decodeRaw` / `DecodedImage`.

- Delete `decodeRaw` and `DecodedImage` (dead in production).
- Move `pixels`, `imageFromRgb` and `hdrGradedSamples` into
  `src/services/processing/rawshim_pixels.ts`, whose header states that pixel
  work belongs in Rust and that this module exists only so integration tests can
  assert on what Rust produced.
- Ban importing it from `src/**` with an oxlint `no-restricted-imports` rule, so
  pixel maths in TypeScript fails lint rather than review.
- `rawshim_ops.ts` keeps handles, `encodeJpeg` (an opaque JPEG for `image_api`
  to stream) and `saveAvif` (straight to disk), under a header stating that the
  only buffer leaving Rust is an encoded file on its way to the client.

The seven integration tests that assert on pixels keep working: they are the
only thing pinning pixel-level correctness (lossless render equality, the
JPEG-match colour fit, half-size decode, HDR grading stability), and rewriting
them as Rust-side comparisons is a larger and riskier job than the goal needs.

## 9. Validation

**Spike, before implementation.** A throwaway Rust binary in `native/rawshim`
scored candidate descriptors against a labelled set drawn from a private
library: one afternoon's shooting, 1122 frames, supplying both the positives and
a large negative set. Eight groups were labelled by the photographer as stacks
they would expect:

| group | note |
|---|---|
| sunset A | the first frame is a different exposure |
| sunset B | |
| boat | different aspect ratios, zoom levels, directions; one subject (a boat). Splitting into several stacks inside this range is acceptable |
| temple | |
| statue | |
| plaza | |
| seascape A | |
| seascape B | |

**Result.** 231 consecutive frames extracted, 78 labelled positive pairs.

The unlabelled remainder could not be assumed negative: it is one long session
at a handful of viewpoints, so most in-window pairs there are genuine stacks
nobody wrote down, the six highest-scoring "false positives" were all, on
inspection, the same scene twice. Negatives were therefore hand-verified by
contact sheet, and roughly 60 pairs were inspected across the score range to
find where "same scene" stops.

| descriptor | worst labelled pair | best verified negative | margin |
|---|---|---|---|
| dHash 64-bit | 0.531 | 0.641 | **−0.109** |
| DCT pHash 64-bit | 0.406 | 0.594 | **−0.188** |
| 4×4 tile statistics | 0.754 | 0.715 | 0.039 |
| rank-normalized luma, no shift | 0.613 | 0.500 | 0.113 |
| + trim, + shift search | 0.860 | 0.740 | 0.121 |
| + chroma (§3, full 25-offset search) | 0.838 | 0.675 | **0.162** |
| + chroma, coarse alignment (chosen) | 0.787 | 0.640 | **0.148** |

Both 64-bit hashes have a **negative** margin: the different-scene pairs score
above the same-scene pairs, so no threshold separates them. This is the finding
that decided §3.

The chosen descriptor's worst labelled pair is 0.787 and the best verified
different-scene pair is 0.640. Every one of the ~25 pairs inspected above 0.88
was genuinely the same scene; the verified different-scene pairs all fall at or
below 0.74.

**Grouping.** The §4.3 rule was then run over the same folder. At
`auto_stack_similarity = 0.78` and a 60s window it reproduces the labelled set:

| labelled group | produced |
|---|---|
| sunset A | exact, including the different-exposure frame |
| sunset B | one extra frame, confirmed as belonging |
| boat | two stacks, which was allowed up front |
| temple | exact |
| statue | exact |
| plaza | exact |
| seascape A | exact |
| seascape B | exact |

45 stacks over 140 of the 231 frames, the largest seven photos: one obelisk shot
from seven distances, checked by eye and correct. The threshold slope is smooth
either side, so there is no cliff for the setting to fall off. 0.78 is the
default because it is where the plaza group completes; 0.80 drops its last frame.

**The scale search was added after inspecting the near-misses.** Every arguable
rejection just under the threshold was a change of *distance*, the photographer
stepping closer or pulling wider; none was an exposure, motion, subject or colour
miss. Adding the crops lifted exactly those pairs and left the verified negatives
untouched:

| pair | no crops | with crops |
|---|---|---|
| obelisk, stepped closer | 0.777 | **0.834** |
| plaza, reframed | 0.741 | **0.773** |
| steps, reframed | 0.776 | **0.797** |
| steps, pulled wide | 0.757 | **0.779** |
| verified negative: sunset vs walkway | 0.630 | 0.630 |
| verified negative: road vs stairway | 0.640 | 0.640 |
| verified negative: plaza vs sculptures | 0.516 | 0.516 |
| verified negative: rocks vs building | 0.525 | 0.525 |

Margin is unchanged, eight more frames stack, and the boat range goes from three
stacks to two. Widening the threshold instead would have bought these back along
with everything else at that level, against a negative floor of 0.74.

**The crop must be centred, and one crop is enough.** Anchoring the crop window
off centre was measured as its own axis, at a single 78% fraction:

| crop set | worst labelled | best verified negative | margin | pairings |
|---|---|---|---|---|
| centre 85% + 72% | 0.787 | 0.640 | 0.148 | 5 |
| **centre 78%** | 0.787 | 0.641 | **0.146** | **3** |
| 78% left/right | 0.787 | 0.643 | 0.145 | 7 |
| 78% up/down | 0.788 | 0.739 | 0.049 | 7 |
| 78% four diagonals | 0.787 | 0.751 | 0.037 | 11 |
| 78% all nine anchors | 0.788 | 0.751 | 0.037 | 19 |

Off-centre anchors barely move the true pairs (0.787 → 0.788) and lift the
different-scene pairs hard (0.640 → 0.751): more freedom to slide the window is
more chance of a coincidental match between two unrelated frames. Vertical is
worse than horizontal, which fits the subject matter, these frames share sky
along the top and ground along the bottom, so a vertical slide lands sky on sky.
The sunset-against-a-walkway pair above goes from 0.630 to 0.739 under the
up/down sweep alone.

One centred crop at 78% then matches two at 85% and 72%, same 45 stacks over the
same 140 frames, 0.002 of margin apart, while cutting the pairings from five to
three and running 1.7× faster (23.3k against 13.5k comparisons per second). That
is what the spec settled on.

The spike that produced these numbers has been deleted, as planned: §3 is
implemented and covered by tests of its own, and the labelled library it read is
private, so the measurements are recorded here rather than made re-runnable.

**Tests.** Descriptor and grouping are pure functions given a descriptor per
photo, and get unit tests. The collapsing CTE gets repository integration tests
covering album strictness, filter interaction and pagination. The grid gets an
e2e covering collapse, expand, unstack and remove.
