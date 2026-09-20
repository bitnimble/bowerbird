# Bowerbird design: Stacks and stack triage

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 19. Photo Stacks

A **stack** groups photographs of one shot: a burst, or several takes of a
scene. It is one entity in the catalogue, shown as one tile, expandable to its
members. A stack is **library-wide** and transcends the shoots and albums its
members sit in, which since shoots mirror folders (§4.1) is the ordinary case
rather than an unusual one: any stack whose photos are in two folders is a stack
across two shoots.

### 19.1 Why not a perceptual hash

The obvious answer is a 64-bit perceptual hash, and it does not work. Measured
against a labelled folder of 231 frames, dHash scores the worst true pair at
0.531 while a hand-verified *different-scene* pair scores 0.641; DCT pHash is
0.406 against 0.594. Both have a **negative** margin - the different scenes
outscore the same ones - so no threshold separates them. They are not merely
weak here; they are unusable.

What a descriptor has to survive, for two frames of one scene, is a different
exposure, a shift or small rotation, people walking through, a different white
balance or colour profile, and a step closer or further back.

### 19.2 Schema

```sql
CREATE TABLE stacks (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
  date_created  TEXT NOT NULL
);
```

The `origin` column is load-bearing rather than informational. Detection re-runs
over already-stacked photos so that changing the threshold re-forms stacks
(§19.4.3), and without it that pass would dissolve a manual stack whose members
are not alike - two lenses on one subject, which is the case manual stacking
exists for.

On `photos`: `stack_id`, `descriptor` (a BLOB, §19.3), and `stack_state`, which
is the three answers to "is this photo in a stack?"

| value | meaning | detection may claim it |
|---|---|---|
| `none` | never been in one | yes |
| `stacked` | currently in one | yes, if the stack is `auto` |
| `unstacked` | a human pulled it out | **never** |

`stack_state` is `stacked` exactly when `stack_id` is set. The repository writes
both together rather than a `CHECK` spanning them, because a library delete
cascades `stacks` and `photos` in an order SQLite does not define and such a
constraint would fire mid-cascade.

On `libraries`: `auto_stack`, `auto_stack_similarity` (0.78) and
`auto_stack_window_seconds` (60). Per library because one catalogue may be
burst-heavy sport where the stack is the unit of work and another a studio where
every frame is deliberate.

### 19.3 The descriptor (`native/rawshim/src/stacks.rs`)

Rust computes it, Rust compares it, and TypeScript only ever stores the blob and
hands it back. A comparison is arithmetic over a couple of thousand cells, and a
library-sized pass makes hundreds of thousands of them, so handing that across
the FFI boundary one call at a time would cost more than the work.

Two views of the frame - the whole thing, and its **central 78%** - each holding
a rank-normalized luma grid at 20x20, two grey-world chroma grids at 20x20, and
a 10x10 luma grid used only to find the alignment. 2.6 kB per photo, so ~260 MB
for a 100k library, against the terabytes of RAW such a library holds.

Three properties do the work:

- **Rank normalization** is the exposure and white-balance invariance: any
  monotonic tone curve leaves the ordering of the cells alone, so it leaves the
  descriptor alone. Cells that tie share the mean of the ranks they span, and
  cells are rounded to the precision the descriptor stores *before* being
  ranked. Both matter more than they look: a flat sky, a blown highlight and a
  neutral shadow are long runs of equal cells, and the chromaticity of a grey
  region differs cell to cell only in the last bits of a float division. Ranking
  that raw turns numerical noise into a full-scale signal, and two frames of one
  grey scene describe it completely differently.
- **Aspect is squashed, not fitted.** A crop or a second body gives one scene two
  aspect ratios, and that must not read as a difference.
- **The trimmed mean** - the best 75% of cells - is the occlusion tolerance.
  Somebody walking through changes a handful of cells completely, and a plain
  mean lets those few outvote the scene they are standing in.

Comparing two descriptors takes the best of three pairings: both whole, and each
one's whole frame against the other's crop. Cropping both sides is the same view
as cropping neither, so that pairing is skipped; trying both directions is what
makes the score symmetric, which the grouping needs. Each pairing finds the
offset that best lines the 10x10 grids up, then evaluates the real distance once
at that offset. Searching coarsely and evaluating once rather than evaluating all
25 offsets at full size is 19x faster for 0.014 of margin.

The crop is centred, and measurably has to be: anchoring it off centre moves the
true pairs by 0.001 and lifts the different-scene pairs from 0.640 to 0.751,
because more freedom to slide the window is more chance of a coincidental match.
Vertical is worse than horizontal, since frames of a landscape share sky along
the top and ground along the bottom.

The descriptor is written when a photo's **grid tile** lands, read back from the
tile rather than computed inside the render, so every photo is described from
the picture the grid actually shows however its tile was produced. Two libraries
are then comparable even when one serves the camera's JPEG and the other a
demosaiced render.

### 19.4 Detection (`stacks_service.ts`)

#### 19.4.1 When

After a sync **and the processing it queued** have both settled, and only when
that sync added or changed photos. It waits for processing rather than for the
scan because what it needs is the derived files: photos imported a moment ago
have nothing to compare yet. The added-or-changed condition is not an
optimisation - watching is on by default with a fifteen-second debounce, so a
save starts a scoped sync, and without it a library would re-clique its whole
collection every quarter of a minute while somebody worked in it.

There is no separate "scan now" control: a manual sync is already how you ask a
library to re-look at itself.

#### 19.4.2 Candidates, and the absence of a backfill

Photos whose `stack_state` is `none` or `stacked`, which are not members of a
`manual` stack, and which have a descriptor. Deliberately **no camera or lens
gate**: shooting one subject with two bodies to compare them later is a case
stacking should serve.

A photo imported before this feature has no descriptor and is never a candidate,
so an existing library stacks nothing until it imports something new. There is
no backfill pass, because the value is in what arrives next rather than in a
walk over everything that already landed - and rebuilding a library's tiles
already backfills it as a side effect, since the descriptor rides along with the
tile.

#### 19.4.3 The rule

Candidates are walked once in time order, **within a shoot**, growing one stack
at a time. The next photo joins when **both** hold: it is no more than
`auto_stack_window_seconds` after the photo before it, *not* after the stack's
first photo; and it clears `auto_stack_similarity` against **every** photo
already in the stack, not merely against its neighbour.

A stack never spans two shoots. A shoot lists the whole of one that reaches out
of it, dimming the members filed elsewhere (§19.6.1), and no gesture on that page
can take the grouping apart - so a stack detection formed across a folder
boundary is one the reader cannot answer. Two cards filed into a folder each is
the ordinary way to arrive at frames seconds apart that were never one burst.
Photos in no shoot are grouped together, the library root being a folder like any
other. A stack a *person* made may still span shoots: that is them saying so.

The clique requirement is what bounds a stack, and it removes the need for any
separate guard against chaining: a scene that drifts frame by frame reaches a
point where the newest photo no longer matches the one the stack started from,
and the stack ends there on its own. On the labelled folder the largest stack
produced is seven.

The pass rewrites every `auto` stack in the library from scratch, which is what
makes the similarity setting mean something after it changes: raise it and stacks
split, lower it and they merge. Photos leaving an auto stack during that rewrite
go back to `none` rather than `unstacked` - this is detection changing its own
mind, not a person rejecting the grouping.

Cost is `n * s` where s is the size of the stack being built, never `n^2`, and
not a function of the window at all. Measured at 23k comparisons per second per
core.

#### 19.4.4 The human boundary

Any manual edit - create, add, remove, unstack - sets the stack's `origin` to
`manual`, and detection stops managing it permanently. Remove and unstack
additionally set every affected photo to `unstacked`. Enforced in the service
rather than at the API, so a later caller cannot route around it.

### 19.5 Reading stacks

#### 19.5.1 Collapsing

Collapsing happens in SQL, so a stack costs one row of a page and one unit of
`total`. One helper builds the predicate, used by the listing, by `idsAt` and by
`positionsAt` - written twice, a position would mean one photograph to the client
and another here. That one helper is also what makes an uncollapsed listing a flag
rather than a second query path (§19.5.4).

**`total` is counted with that same predicate**, as `SUM(CASE WHEN <it> THEN 1 END)`
over the scope on the one pass that `COUNT(*)` gives `photo_total`. `total` is by
definition how many rows the listing returns, so counting it any other way is that rule
written twice - and the two ways do not stay equal, because the helper both collapses a
stack *onto* a key and removes a panorama's frames outright (§19.4), where no count over
keys can express a row that is not there. The grid believes the count over the rows: one
too many reserves a slot nothing arrives for, and the tile never fills.

A listing answers with `photo_total` beside `total`: the same scan's `COUNT(*)`,
so a reader is told how many photographs the collection holds while the grid is
still numbered by its entries. The count in the controls is the former - a stack
of eight is eight photographs to whoever took them - and every position, every
selection run and every row of the rail is the latter.

**It is a filter, not a window function, and that is the whole of why listings
are still fast.** A window has to see every scoped row before `LIMIT` can take a
hundred of them, so it sorts the collection for every block a scroll fetches:
measured at 179ms a page on 200k photos against 0.9ms for the same listing
without stacks, and paid by every library whether or not it has a single stack.
As a filter the ordering index is walked and stops at the page, and the same
listing costs 4.2ms.

The filter has two arms:

- `photos.is_representative`, a stored flag set on every unstacked photograph and
  on one member of each stack, which answers for almost every row with an
  equality test;
- failing that, "this stack has no visible flagged member, and no visible member
  sorts before me" - which **promotes** the next survivor when the flagged one is
  hidden, by a filter, by the bin, or by being in another shoot.

So the flag is a hint rather than a truth. Stale or missing, the second arm still
returns the right row and only costs a little more. What it must never be is set
on two members of one stack, which would show that stack twice, so a partial
unique index (`photos(stack_id) WHERE stack_id IS NOT NULL AND is_representative
= 1`) makes that an error at the write rather than a duplicate tile nobody
notices.

It is maintained by `refreshRepresentative` (`stacks/stack_membership.ts`), called
on every membership change **and on every verdict or binning of a member**. The
last two matter because the flag being a hint is not the same as it being free:
the promotion arm is a correlated subquery per row, and rejecting the member a
stack stands for is what every triage session does (§20.2), so a stack whose flag
was left behind paid for the slow arm on every read from then on.

It picks the newest member that is neither rejected nor binned, which is the
member the promotion arm would pick in an unfiltered listing, so the two agree.
Deprioritised rather than excluded: a stack whose members are all rejected still
has exactly one flagged member, and the index keeps meaning what it means. The
comparison has to be null-safe (`COALESCE(triage, '')`), because `untriaged` is
stored as NULL and `NULL = 'rejected'` is NULL, which SQLite sorts *before* 0 -
so the oldest untriaged frame would outrank the newest keeper on nothing but its
NULL.

One consequence to know rather than discover: the collapsed row sorts on its
representative's date, so rejecting the newest member moves the stack's tile back
to the second-newest's place in the grid. For a burst that is a few positions;
for a stack spanning days it is a jump, on the keypress that caused it.

The promotion arm carries the **same scope and filters as the outer query**,
which is what keeps the properties the window gave for free. An album is strict,
because a member it does not hold is not a candidate to stand for the stack. A
shoot promotes to the newest *in-shoot* member, so it never shows a tile for a
photograph that is not in it. And a filter promotes rather than making the stack
vanish.

Two costs remain, both once-per-pass rather than per-block: the `total` count is
a full scan (it always was), and `positionsAt` numbers rows without a bound
because it cannot know where its keys are, at ~158ms on 200k photos. It runs on a
refresh with bands open, not on every block.

**Selecting a stack means selecting every photograph in it**, and `idsAt` is
where that happens: a collapsed row stands for its stack, so expanding the chosen
rows to their members is one join in one place, and no client holds a member id
to do it with.

#### 19.5.2 Scope rules

- The row a scope shows is the newest **in-scope** member, so a shoot never shows
  a tile for a photograph that is not in it. That is the promotion arm's doing;
  the stored flag is library-wide and knows nothing of scope, which is why the
  arm carries the outer query's own filters.
- `stack_size` is the full membership in library and shoot views, and the
  in-album count in an album view.
- A stack with one visible member renders as an ordinary tile, carrying a badge
  back into its band (§19.6.1).

#### 19.5.3 Expansion

`GET /api/stacks/:id/photos` returns every member; `?album_id=` narrows to what
that album holds. `?shoot_id=` narrows nothing - each row carries its own
`shoot_id`, which is all the client needs to dim the members that are elsewhere -
it names the shoot whose *hiding* this band is exempt from, so a band opened on a
hidden shoot's own page holds the members that page's tile counted (§12.4). Both
are the same rule: a band has to agree with the listing it was opened from, which
is also why it is told which side of the bin to answer for.

**Stepping through the viewer sees the collection uncollapsed.** The grid shows a
stack as one tile; Previous and Next visit every frame of it. Two endpoints answer
the same listing with `representativeFilter` left off, and nothing else in the
system uses them, so the collapse is untouched everywhere it matters:

| method | path | purpose |
|---|---|---|
| `POST` | `/api/photos/neighbours` | the run around one photograph, ±50 by default |
| `POST` | `/api/photos/range` | the run between two, either end optional, capped |

Both take the same scope and filters a position lookup does, and both are a
**keyset seek** off a row's own sort key rather than an offset: a position in an
uncollapsed listing is not something the client holds, and computing one is the
`ROW_NUMBER` pass §19.5.1 measures in the hundreds of milliseconds - per arrow
press. The seek is ~0.2ms for a 50-row window on 200k photographs.

**An open band lists its members in that same ordering**, which `GET
/api/stacks/:id/photos` therefore takes as a parameter: the collection's, not the
library's, since a shoot and an album each carry one of their own. A sort of the
band's own reads as two bugs at once - the band and the viewer disagreeing about
which frame is second, and Next from the band's first member leaving the stack
entirely, because in the collection's order that member is the stack's last.

**Required, and with no default**, which is the part that keeps it true. A default
is a sort the route picks for a caller that did not think about it, and a caller
that did not think about it is exactly how the two came apart - stack triage seeds
its tournament from this same listing and was reached, months later, by someone
adding a parameter every other caller passed. Required, the compiler names them
all; defaulted, they go on working and quietly disagree.

Two spellings in it are load-bearing and look wrong, so they are commented where
they sit. The group predicate must be the indexed *expression* `(date_taken IS
NULL) = 0|1`, never `IS NULL` / `IS NOT NULL` on the column: only the exact
expression matches `idx_photos_*_order_taken`, and without it the leading column
is unconstrained, the row-value comparison cannot become a range constraint, and
the whole collection is scanned into a temp b-tree - 4.8ms against 0.01ms at 40k
rows. And `date_taken IS NULL` must be *absent* from each seek arm's `ORDER BY`,
where it is a constant, or the ordering stops matching the index for the same
reason.

An absent range bound means that end of the collection, so the cap is read from
the bound that exists - capped from the start instead, a range asking about the
end of a library answers with the beginning of it.

#### 19.5.4 Expand all stacks

**Expand all stacks** is a setting on the grid's control row, beside the filters
and the sort. It is not "open every band": there is no stack in the grid to open.
The *listing itself* is uncollapsed, so every frame of every stack is a row of the
collection, in one stream, and the view looks like a library that never had a
stack in it.

It is `representativeFilter` left off - the same absence the viewer's two
endpoints are (§19.5.3) - which is why an expanded listing costs less than a
collapsed one rather than more. Three other things move with it, and all three are
the same statement about what a row now is:

- `total` is `COUNT(*)` rather than `COUNT(DISTINCT COALESCE(stack_id, id))`;
- `stack_size` is 1 on every row, so no tile draws a badge, takes a disclosure
  click, or opens a band;
- `idsAt` loses the arm that expands a chosen row to its stack. Picking one frame
  of a burst out of an expanded grid and binning it must bin that frame.

The flag therefore travels with the filters, in the query string and in the
`filters` of a selection or a position lookup alike. It is part of what identifies
the listing, and a question asked without it is a question about a different one:
position 400 would mean one photograph to the client and another here (§19.5.1).

For the same reason nothing in the grid *renders* from it. The rows in hand
already say what they are, so a click on a tile reads `stack_size`, not the
setting, and the two can never disagree mid-switch. Two things read the setting
deliberately, and both are cases a row of 1 cannot be told apart from a lone
survivor by: Unstack, since a single selected row is no longer a stack to unmake,
so the action is not offered; and the badge back into a band (§19.6.1), which every
member of every stack would otherwise wear.

**The switch keeps the reader's place and their selection**, which is most of the
work. Every position in the collection changes, so both are named by **key** -
`COALESCE(stack_id, id)`, exactly as an open band is (§19.6.1) - and re-resolved
through one `POST /api/photos/positions` against the listing being switched *to*.
That endpoint answers with the positions a key names rather than a position, which
is the whole of what makes one lookup enough: a stack id is one row collapsed and
every member of it expanded, so a selected stack becomes its frames going one way
and its frames become the stack coming back. A member picked out of an open band
is named by its own id instead, since uncollapsed it is a row like any other and
its siblings are not what the reader chose. A row answers under **both** keys when
both were asked for - naming a member must not subtract it from what its stack
names, and filed under one of the two the answer for a stack depended on whether a
sibling happened to land in the same `IN (…)` chunk.

Four deliberate limits:

- **Only rows this client holds** can be named, so a selection reaching further is
  dropped rather than guessed at - the same choice `rebase` makes, for the same
  reason (§18.3.3). "Everything" is exempt, being the one selection that is not
  about positions: it survives as everything.
- **The count is read before the switch**, alongside the positions, so the
  collection is already the right height when the reader's row is put back at the
  pixel it was on. Read after, the view springs there when the first block lands.
- **Masonry is block-granular, with no offset.** How far into a block the reader
  was is measured against that block's real height, and the re-list has measured
  none of them - carried over, a reader 2,500px into a block that laid out at
  3,200 lands 2,500px into one estimated at 900, two blocks past their own photos.
- **A row the other listing cannot place leaves the reader where they were**, at
  the pixel rather than at the top: the anchored stack may have been unstacked
  from under them, and `resetRows` puts the scroll to zero unless something puts
  it back.

**The flag is not set until both answers are in hand.** It is what every other
request reads too, so flipping it first meant a sync poll fetching blocks of one
listing into a grid numbered by the other; the two reads state the listing they
are about instead. Setting it, resetting the rows and putting the selection and
the scroll back are then one action, and `resetRows` inside it abandons whatever
the old listing had in flight - so there is no window in which the grid is
half-way between the two.

Staleness is checked against the **listing** - the collection, its filters, its
sort and the flag - and deliberately not against the generation counter, which a
plain re-read bumps too. A sync poll ticks once a second through an import and
renumbers nothing the answers depend on; measured against the generation, the
press was swallowed for as long as the library was indexing, with the toggle
springing back and nothing said. A read that fails, or a filter or a sort that
lands while one is out, does cost the press - and nothing else, since nothing has
been written by then.

### 19.6 The grid (`bands.ts`)

Clicking a stack tile opens a **band of fresh rows directly below the row that tile
sits in** - the tile stands for the stack, not for the one member it shows, so it
never opens that member's detail view, and a member is reached from the band. Its
band is therefore what the frame does, where every other tile's frame opens the
photo view (§18.3.1) - and it goes on doing it while a selection is up, since the
band is the only way to the members and closing it again would otherwise be
unreachable. The tile stays where it is and takes a dark overlay with an up chevron,
which is also how the stack closes.

**A stack's tile is a disclosure, not a selection.** A click on it opens or
closes its band and leaves the selection exactly as it was: looking inside a stack
must not throw away whatever the reader had already chosen. Its tick box selects the
row, which is also how Unstack is reached, and cmd-click does the same; either
leaves the band as it found it. What *does* leave the selection is
closing a band: its members go with it, since a closed stack would leave them acted
on with nothing on screen saying so, and the collapsed row that replaces them is
not the same thing as three of its frames (§19.6.1).

**The tile and its band are drawn as one shape**, joined across the gap between
them: the tile leaves its bottom edge open, the band leaves the tile's own width
out of its top edge, and two stubs carry the sides over the gap. So the band reads
as belonging to that tile rather than to the row, which is the whole question a
reader asks of it. Only **one band per row** is joined - the one immediately below
it, which is the lowest position of that row's open stacks; the rest are separated
from their tiles by another band and keep a ring of their own, where the colour is
what pairs them. Masonry is the same rule per **line**, decided where the lines are
replayed rather than in the store.

Four details, each of which was wrong first:

- The gap is a **mask over the ring** rather than a redrawn edge, so the ring keeps
  its exact geometry. Where it is cut depends on what the corner there is: a fillet
  needs a radius of room to curve into, and a corner that runs straight through
  keeps a ring's width of cap - cut at the tile's inner edge instead, the line
  stopped short of the corner and read as broken.
- The two **interior corners are filleted**, since every other corner of the shape
  is rounded and a hard notch between them read as a mistake. They are concave, so
  neither box can round them with a `border-radius` of its own: each is a quarter of
  a ring whose centre sits out in the notch, drawn as a box of radius+ring with two
  borders and the corner facing the notch fully rounded - the radius equals the box,
  so nothing straight is left over. A fillet reaches a whole radius above the band,
  which is more than the row gap, so it crosses the tile's own bottom corner and
  replaces the stub that would otherwise bridge the gap on that side.
- A gap that reaches an end of the band **squares that corner off** and has no
  fillet: the tile's own edge runs straight down into it, and against the 4px arc
  that left a nick on one side and a broken corner on the other. Both ends at once
  is the single-column case, where the top edge disappears entirely and the two
  boxes are one.
- The stubs set `box-sizing` themselves: the reset's `*` does not match
  pseudo-elements, so their two borders were added outside the width and the right
  one landed a ring's width past the tile's edge.

Where the tile is comes from arithmetic where there is a row model - a column
index, and CSS works the width out from `--cols` - and from a **measurement** in
masonry, which is the one place it cannot be computed: a line grows its tiles from
their own shapes or hands the slack to a spacer depending on what follows it, so a
tile's place on one is not arithmetic the way a column is. The joined tile reports
its own offset and width (`fusedTileBoxes`), which is at most one tile per line and
the same exception, for the same reason, as a masonry block reporting its height
(§18.3.2). Until it lands the band is drawn whole for a frame.

The members live alone in that band and never share a row with photos outside
the stack, so no tile ever changes which neighbours it sits beside: the grid
below is displaced downwards and otherwise untouched. Band rows are ordinary tile
rows at the same cell geometry, marked by their background rather than their size.

**A member is the tile the collection would have drawn**: the same size, in the same
column, so its edges line up with the rows above and below. A band's outline is at the
**cell edge on every side**, so it is exactly the display rows it covers - which keeps
the scroll's pitch uniform, and a row of members the same height as a row of the
collection.

It needs no inset of its own, because **every tile holds its photograph inside its
cell** (`TILE_PAD`), and that one piece is what makes the rest of it work:

- A **ring at the cell's edge frames the photograph instead of cropping it.** The
  selection's ring did sit on the picture, which is what made a band's ring landing
  on its outermost members look like a mistake rather than an outline.
- A band's ring can therefore be **at the cell edge**, which is where the ring of the
  tile it is joined to is: one straight line down the two of them. A band inset from
  its own outline was tried, first by taking it off the cells - which drew the same
  photograph at two sizes - and then by making the band wider than the grid, which put
  a kink in the one line the eye actually follows.
- The **gap between two photographs is the gap plus two insets** (`GRID_GAP` plus
  twice `TILE_PAD`), which is where the air between frames comes from. `GRID_GAP`
  itself stays small, because it is what separates two *rings*, and two rings a
  photograph's width apart do not read as a pair.
- A tile has **no backdrop of its own**: the photograph's is the hit overlay's,
  clipped to the inset, so what shows between two frames is the bed the grid sits on.
  On the tile it showed in the inset as a dark border round every cell.

The 3:2 therefore belongs to the photograph rather than the cell, and `gridRowHeight`
says so: a cell is the 3:2 picture plus its inset, or every frame in the collection
would carry a hairline bar.

One scroll correction covers the bands, not two. Opening or closing one above the
reader, and re-placing every band at once, are both "keep the reader's row where it
was", and how far that row moved describes all of it - including a band at or below it,
which moves it not at all.

The member fills its column and states the grid's **3:2** itself, which is what
gives it the grid's height - the ratio rather than the row, because `.grid--grid
.tile` turns the ratio off (a grid cell has the shape already) and a member sized
from the row alone would be a photograph letterboxed inside a cell of another shape.
`align-self` places it in the row rather than `stretch`, which is the default:
stretch against an aspect ratio is a corner the engines read differently, and
Firefox took neither axis as definite and laid every member out at no height at all.
That, and the capped flex line below, is why one E2E file runs in both engines
(`grid/bands.spec.ts`).

**Masonry's band is not in the row model at all** - the block it sits in reports the
height it laid out to (§18.3.2) - so its inset costs its members nothing, and its
rows are **capped** instead: a band is a full-width flex
line, so two portrait frames alone on one stretched to the width of the grid and
drew the stack several times the size of the collection around it. The cap is
`BAND_LINE_CAP` times the stack's own tile, which is the size the reader is already
looking at, and it is applied to the width - the ratio carries it to the height, and
flex leaves the space it no longer wants to the right of them. A masonry line's
tiles all share one height by construction, so capping one caps the line.

**Masonry** has no row model to hang a band off, so an open stack's members break
the line themselves: the band is a full-width item on the block's own flex line.
It waits for the **end of the line its tile sits on** rather than following that
tile straight away - a band in the middle of a line cuts the line short, and the
tiles left on it grow into the space the band walked off with, which stretched a
stack opened at the start of a line across the whole grid and pushed its
neighbours below the band. Which tile ends a line is the one thing the photos'
shapes decide rather than the row arithmetic, so `masonryLineStarts` replays the
wrap from the same flex bases the container packs from; nothing is measured. A
band flushed after the block's *last* line takes the `::after` that eats that
line's free space with it, so that line is given an end of its own.

A block's height is measured rather than computed, so the scroll learns the band
is there without being told, and the scroll correction opening one usually needs
is not owed at all.

Any number of stacks may be open. Expansions are a list of `(position, member
count)` sorted by position; `rowCount` is the base rows plus each band's
`ceil(members / columns)`, and mapping a display row to a collection position is
a prefix-sum walk over that list.

An open stack's tile and its band are ringed in **the same colour**, numbered
down the collection and wrapping after three. Several stacks open on one row put
several bands beneath it in a run, and the colour is the only thing saying which
band came from which tile. **None of the three is the house blue or the
sea-glass**, which belong to the selection and the keyboard cursor (§18.3.1): a
band ring in either, beside a genuinely selected photo, reads as two photographs
chosen when only one is.

#### 19.6.1 Keeping bands and the scroll put

A row's identity is `COALESCE(stack_id, id)` - the key the collapsing partitions
on. That is what the store holds for an open band, and positions are derived from
it rather than stored, so ordering changes, filters and syncs move where a band
is drawn without closing it. A band closes when its stack leaves the collection,
and when the listing stops collapsing it: a cull that leaves one member inside the
filter makes that row an ordinary photograph, and a band hanging off a tile which
is not a stack tile is joined to nothing. Such a tile carries a small stack badge
beside its name, which is then the way back into the band - and a band opened from
there is the reader asking for exactly that state, so it survives the re-reads that
would otherwise close it. Not in an album, whose band is scoped to the album as
well (§19.5.3), so a lone member's would hold only itself.

On any refresh, each open band's position is re-resolved through
`POST /api/photos/positions`, which numbers rows **once** and reads every wanted
key out of that one numbering. Ten open bands must not mean ten ordered passes
over the collection, which is the lesson `idsAt` already records. A key answers
with the positions it names rather than one position: in a collapsed listing a
stack has exactly one row, and in an uncollapsed one it is every member of it
(§19.5.4), which is what lets the same lookup carry a selection between the two.

Opening a band above the viewport displaces everything below it, so the action
moves the view the band's height further down the collection and nothing appears
to move. That goes to `rail.anchor` rather than moving the scroller (§18.3.2), so
nothing the reader is doing to it is interrupted; only what the anchor cannot
absorb reaches `rail.top`. Every input is a number the store already holds, so the
correction is exact rather than a measurement - but it has to be taken from
*before* the band changed, because the band is also what changed the collection's
height.

That correction is owed by a **re-read** as much as by a click, and for a while it
was not paid: a refresh re-places every band and closes the ones whose stack has
left, as often as not above the reader, and it happens on a bin, a restore, a
verdict under a filter or a sync poll. It is answered the same way, off how far
the reader's own row moved rather than off any one band's height, which is the only
form that describes several bands changing at once.

**Band members have no position of their own**, in any mode: the listing is
collapsed, so the server numbers one row per stack and members are not in that
numbering at all. They are selected **by id**, in a set held beside the position
ranges. This stays inside the rule the virtual grid enforces rather than bending
it - what must never happen is an id standing in for an *unloaded* row, and a
band's members are loaded, on screen, and few.

**The two halves are one selection.** They were separate, with the bulk bar acting
on whichever was live, on the grounds that "everything in this library" and "these
three frames of this burst" are different intentions - but a stack opened out is
part of the collection being worked through, and picking a frame out of it *and* a
frame beside it is an ordinary thing to want. So a wire selection carries
`members` alongside `ranges` (§18.3.3), the count is the sum of the two, and every
action reaches both. Each photo is acted on once: a run naming a stack's row
resolves to every member of it, so the server takes the union.

A member behaves as a tile does (§18.3.1): its frame opens it in the viewer, its
tick box picks it out, cmd-click adds it to what is already chosen, and with a
selection up a plain click toggles. An action that consumes the selection drops the
members with the positions (§18.3.1).

The bulk bar counts **entries**, where a stack counts as one, because the client
cannot know the sizes of stacks in a selection covering rows it has never held.

| action | shown when |
|---|---|
| Stack | two or more entries selected |
| Unstack | a selected row this client is holding is a stack |
| Remove from stack | band members are selected, of one stack or several |
| Merge photos | always, its two rows individually refused or greyed by name (below) |

Stacking a selection that already contains stacked photos moves those photos into
the new stack; any stack left with fewer than two members is deleted, because a
stack of one is a photograph.

**Merge photos sits in its own section beside Stack and Unstack, not among them.** `bulk_bar.tsx`'s
`OverflowMenu` renders a section's own content above its options, and the ordering that keeps Stack and
Unstack adjacent stays deliberate rather than getting a third row wedged between them. It opens a `Submenu`
of two rows, **To panorama** and **Take best parts** - joining frames that point in different directions
into one wider picture, or frames that point at the same thing and disagree about what was in it. The two
are not refused the same way: **To panorama** has no page of its own to navigate to, so a click issues the
merge directly and the service is what refuses a bad selection - fewer than two entries, entries from more
than one library, or an entry that is itself a composite. **Take best parts** is a route, so its four
refusals - the same three plus, for it alone, more than twelve frames, since carving tiles out of a burst is
what stops being quick past that - are checked client-side first: a failing selection greys the row rather
than letting a click navigate anywhere, named in its title. The service refuses the same four again when a
request reaches it without the page.

## 20. Stack Triage

A stack (§19) is several takes of one scene, and picking the keepers means
comparing every take against every other: N² judgements, which reads as work
rather than as photography. **Stack triage** replaces that with a run of binary
questions. Two photos, one question, until the pool is a set of photographs
nothing has beaten.

Terms, used exactly and only this way: a **round** is one pair put to the
photographer; the **pool** is the photos still in contention; **decisive** means
*Pick A* or *Pick B*, where exactly one photo leaves; a **draw** is *Both*.
**A** and **B** are the two slots on screen, never photo names.

### 20.1 The tournament

`web/src/features/photos/stack_triage.ts`, pure, and where the correctness of the
feature lives.

```ts
interface Session { alive: readonly string[]; seen: ReadonlySet<string>; stopped: boolean }
```

`seen` holds every pair already judged, keyed by the two ids sorted and joined
with `|`. **Decisive pairs go in as well**, though a decisive pair can never recur
on its own, because it makes "a pair is never offered twice" a local property of
`nextRound` rather than a consequence of removed photos never returning, and
because it makes "this photo has been judged" derivable rather than a second set
to carry.

`nextRound` is one scan: the first pair in index order over the pool, `(0,1)`,
`(0,2)`, … then `(1,2)`, whose key is not in `seen`. That is the whole rule.

| verdict | the pool |
|---|---|
| Pick A | B removed, A moved to the **front** |
| Pick B | A removed, B moved to the front |
| Both | A then B moved to the back, in that order |
| Neither | both removed |

`a` and `b` are the round's slots throughout this section. What the *photographer*
calls A and B is a side of the screen, which §20.4 draws and the presenter maps
back to a slot.

**The winner to the front is what holds it over.** The next round is then `(0,1)`:
the winner against the first photo it has not met. When it has met everyone left,
every `(0,k)` is judged and the scan walks on to a pair that cannot contain it, so
the stand-down needs no branch. An earlier draft carried a `champion` field to
express this, with a branch, an invariant tying it to the pool, and an argument
about when a stale one is cleared; the queue order produces the identical schedule
with none of that.

The drawn pair to the back is what spreads the work: without it the same two
photos sit at the front and every later round pairs one of them with someone new.

**Neither may empty the pool.** A stack where every frame is soft has no keeper.

**What it guarantees.** Every round either removes a photo or adds a pair, both
monotone and bounded, so a session terminates and no round repeats. A session that
ends by *exhaustion* returns a keep set that is a **clique of mutual draws**: every
pair of survivors was judged, and any decisive judgement would have removed one of
them. No photo is kept without having been held up against every other kept photo.
Keep the rest forfeits that knowingly, for the rounds never asked.

N−1 rounds when every verdict is decisive, which is optimal for finding a maximum;
N(N−1)/2 when every one is a draw, and the bound is tight. The alternative, treat
draws as transitive, so `p`≈`q` and `q`≈`r` skips `p` against `r`, was rejected
because it is not true, and because it would spend the guarantee silently on every
session where Keep the rest spends it only on request.

### 20.2 What is written

Elimination is the only final verdict, so it is the only one written during the
session.

- A loser is `PATCH`ed to `triage: 'rejected'` as the verdict lands; `Neither`
  writes both.
- **A win writes nothing**: the winner can still be eliminated two rounds later.
- When the session ends, each survivor **that appears in some judged pair** is
  written `picked`. One in no pair has never been on screen, which Keep the rest
  can leave, and `Neither` can leave by emptying the pool around it; and is left
  exactly as it was, rather than claimed as a considered keeper.

Every value a session writes is `rejected`, `picked`, or the photo's triage when
the session opened. That baseline is captured once, stored, and is what every undo
restores against, so an entry records only *which* photos it wrote. It is never
re-read from the member rows, which after a reload carry the session's own
rejections.

Writes go through `PhotosPresenter.setTriage`, which returns whether the write
landed and takes `quiet` to suppress its toast for a caller that reports failures
itself. **A failure is reported, not compensated**: both directions are already
safe, where rewinding would discard every verdict after the failed round to make
up for a write that under-applied, along a path that is itself failing.

Two root-cause fixes in `PhotosPresenter` fall out of this and are not triage's
alone: writes are **serialised** through one promise chain, since `api.updatePhoto`
is a bare fetch and a verdict followed quickly by an undo could otherwise land the
restore first; and `refresh()` **coalesces** rather than queueing a full re-read per
call, which the grid already hit by holding a cull key on the Active filter.

### 20.3 History, undo, and the queue

Every action pushes `{ session (as it was before), showing, choice, changed }`.
`choice` is stored because Completed has to show it and it is otherwise only
recoverable by diffing against the following entry, which the newest one lacks.

**Rewinding to entry `i`** restores that session and slot, re-writes every id in
`changed` from `i` onward; deduplicated, so one write per photo, to a value that
does not depend on which entry named it, and **truncates the history to `i`**.
Truncating is not bookkeeping: without it the abandoned branch stays reachable, and
a later undo restores a pool with photos missing from it that no write ever
rejected. Undo is a rewind to the last entry; the queue is a rewind to any.

Ending the session belongs to the action that ended it, so the closing `picked`
writes join that entry rather than making one of their own: a separate entry would
restore a state for which there is still no round, which is a session that ends
again the moment it is undone to. Ids are appended when a write is **issued**, not
when it lands, so a rewind racing one still in flight takes that one back too.

The **queue** lists **Completed** (newest first, each round's thumbnails and its
verdict; selecting one rewinds to it) and **Upcoming**, read-only. Upcoming assumes
**every remaining round draws**, which is the run the pure functions produce for
`Both` repeated, and the only assumption under which the list *only shrinks*.
Assuming the winner keeps winning would make it grow whenever the winner lost.
Capped at 20, with the overflow counted from `remainingPairs`.

`status` is computed, never assigned, for the same reason `stopped` lives inside
the session: undo restores a session and nothing else, so a `status` field would
leave the screen reporting a tournament that had just resumed under it.

### 20.4 The two presentations

**Flip** is one `PhotoStage` holding both frames of the round under a single
`photoKey`, so zoom and pan survive the toggle, both frames at 100% over the same
detail, alternating, which is the gesture the mode exists for. That needed the
stage to hold several frames at once (§18.6): a frame per source, each owning its
own decode. A mounted-but-hidden frame gets its own compositor layer, because an
`opacity: 0` element is never rasterised and revealing one would otherwise stall
for the frame or two a raster takes to build.

A peek suppresses the verdict keys while held, and clears on release, on
`pointercancel` and on the window losing focus: Shift-then-arrow is an easy
accident that casts the exact inverse of what is on screen, and a modifier held
across a `Cmd+Tab` never delivers its keyup.

The showing side is kept whenever a photograph carried over, and reset to A when
none did. The winner keeps its side, so the reader looking at it keeps looking at
it, and the one looking at the loser's half is shown the challenger that replaced
it, the one photo of the two not yet seen.

**Each side has a colour**, `--rose` and `--satin`, worn by the frame the
photograph is drawn in, the letter on it, the key beside that letter and the
button that casts its verdict. It is a `PhotoStage` prop (`frameColor`), so split
draws it on each half and flip draws it on the one stage, in the colour of
whichever frame is actually up - peek included, which is the only thing on that
screen saying which of the two is showing. An outline rather than a border, since
`outline` takes no space and the two halves must keep the equal area the
arrangement gave them. The palette's own red and blue rather than a pair beside
them, since two reds a shade apart read as one colour used carelessly - which does
mean red is also the reject verdict and the destructive one, and blue is also the
selection. Never alone in any case: the letter and the arrow carry the pairing for
a reader who cannot separate the two.

**Both presentations put the photograph in a box its own shape**, which is what
lets that hairline run parallel to the picture on all four sides: split's two come
from `arrangement`, flip's one from `fitted` - the largest box of that aspect in
the space, `min(W, H·a)` by that over `a`. Before an aspect is knowable the box is
the whole space rather than nothing, since a stage of no extent never paints, so
never decodes, so the aspect it was waiting for never arrives. Flip sizes to the
frame that is *up*, not to the round: the frame wears the colour, so a box the
shape of the other one would put that colour a letterbox away from the picture it
names.

**A and B are the screen's own sides**, not the round's slots: A is the first half
drawn, so `←`/`↑` is always the first picture. `StackTriageStore.sides` is the
round in drawn order and `swapped` is the flag behind it; the presenter maps a
verdict back to a slot before the tournament sees it, and it is the only writer of
either.

**A photograph carried into the next round keeps the side it is on.** The winner
goes to the pool's front, so drawing slots in order would slide it across the
screen on every `Pick B` and put the challenger where it had been - two halves
changing at once, when the one that did not change is the only cue for the one
that did. A pair is never offered twice, so at most one photo can carry over and
the rule cannot be asked to hold two. Nothing carried means the tournament's own
order, and the half that changed **fades** rather than cutting: `PhotoStage`'s step
with no direction to express (§18.6), since neither photograph moved through a
collection.

**Split** draws both at once, each at the **same displayed area**, in whichever of
row or column makes that area largest. With aspect `a`, area `S`, `s = √S`, and
`gap` the gutter:

- row: `s = min( max(0, W − gap) / (√aA + √aB),  H · min(√aA, √aB) )`
- column: `s = min( max(0, H − gap) / (1/√aA + 1/√aB),  W / max(√aA, √aB) )`

Each constraint is a linear upper bound on `s`, so the smaller is the maximum. The
larger `s` wins; a tie goes to the row. The clamp is *inside* the expression
because `s²` squares away a negative sign, so a box narrower than the gutter would
otherwise render two photos in a container of negative width.

Equal area rather than a common extent, which hands the two photos areas in the
ratio `aA/aB` exactly, 2.25× on a 3:2 beside a 2:3, and size is persuasive in a
tool whose job is a fair comparison. It is not even reliably the smaller picture:
where width binds it uses *more* of the screen than a common height. `W` and `H`
are observables the presenter writes from a `ResizeObserver`, which is the one
input that cannot come from a store already held.

Aspects come from `PhotoSummary.width`/`.height`, display-upright and on the list
row, so the arrangement is known before a pixel decodes - and are **replaced by
the frame's own shape once it has decoded** (`frames`). The two disagree: a
rendition is resized to a longest edge and rounded to whole pixels, so a 2:3
photograph arrives as 1080x1616, a sixth of a percent off. Sized from the
catalogue, `object-fit: contain` then letterboxes the picture inside its own half
by about a pixel on one axis and none on the other - invisible until the half
wears an edge, where it reads as a border that does not run parallel to the
photograph.

Flip does **not** equalise area, and is priced as a limit: stack members are takes
of one scene and almost always share an aspect, and forcing it would mean a second
layout system inside the mode whose appeal is that both frames occupy the same
pixels.

### 20.5 The screen

One header holds everything the session is steered with, so the frames get the
rest of the window: Back, Undo and Keep the rest anchored left, the four verdicts
across the middle, and the flip/split switch and *Queue (n)* anchored right. Under
the frames, in flip only, Show A / peek / Show B. The verdicts sit deliberately
apart from both ends, because a misclick here rejects a photograph.

**Pick A and Pick B are centred on the photograph, not the verdict row.** The
picks, Show A / Show B and the picture itself all share one centre line, which is
the page's. Two nested rules put them there, and each is only half of it: the two
end groups claim equal width, so the middle's centre is the bar's rather than half
their difference off it; and Both and Neither sit in flanks of equal width, so the
picks' centre is the middle's rather than all four buttons'.

Equal *claims*, not equal sizes. An end whose buttons need more than its share
keeps them and wraps, which is what a phone does with this bar - three rows, and
the centring correctly lost, because at that width there is no line to share. The
alternative considered and rejected was laying the verdict row over the whole bar,
absolutely positioned, so it is centred on the bar whatever the ends do: exact at
every width that fits, and on a phone it comes down on top of them.

**The bar is one line, and that is what decides where the counter lives.** Spelled
out in the header, *n left (out of N) · up to k rounds* is wide enough that the
left group wraps, costing a line of the height this arrangement exists to give the
photographs. So the pool count rides on the queue's own trigger - `Queue (3)`,
which is where somebody wondering what is left would look anyway - and the full
line, projection included, is the first thing inside the queue. `up to` marks an
upper bound that only falls: a draw lowers it while the pool stays the same size,
which alone would read as a counter that had stalled.

**Both, Pick A, Pick B, Neither**, in that order: the two picks together in the
middle, so the pair being chosen between reads as a pair rather than as two of
four options, with the two verdicts that name no photograph either side.

Keys: `←`/`↑` Pick A, `→`/`↓` Pick B, `Space` Both, hold `Shift` to peek, `⌘Z`
or `Backspace` undo, `V` to switch presentation, `Esc` to leave. `⌘Z` is the only
modified chord accepted; every other modifier is ignored, because `Cmd+←` is the
browser's Back and casting a verdict on the way out is not a verdict anybody made.
`Neither` stays click-only: every key that could carry it now names a photograph
rather than a fate. It reports through the bin's report-with-an-undo pattern
rather than confirming.

**Both arrows of both axes are bound, and Both keeps only `Space`.** Split lays
the pair out in a row or a column depending on which gives the larger area
(§20.4), so a binding that followed the arrangement would change meaning under a
resize - and `←`/`→` on a pair stacked top and bottom point at nothing. Binding
`↑` and `↓` as well costs `↓` its Both, which had `Space` anyway, and leaves every
key meaning one fixed thing: `→` and `↓` are both *the second photograph*,
whatever is on screen. Only the *hint* follows the arrangement (`sideKeys`), on
the verdict buttons and on the halves themselves.

`V` rather than `Tab`, which an earlier draft used: swallowing `Tab` took keyboard
navigation away from the whole page, and once focus was inside it there was no way
out. A key handler that hijacks a browsing key has to be worth more than the
browsing, and a presentation toggle is not. For the same reason the handler
ignores keys from inside a popup, where `Space` on a queue row would otherwise
cast a verdict rather than select the round under it.

The verdict bar is disabled until both frames of *this* round have decoded, and
what counts as decoded is cleared per round - kept, a round returned to by undo or
through the queue would read as ready before the stage had painted anything for
it.

**Prefetch** is the first ten survivors, and it only fetches. The frames are
mounted clipped to nothing, and a clipped element is never painted and so never
decoded; drawing them at stage size instead would cost a full-resolution raster
each, and ten of those is hundreds of megabytes. The bytes are in cache when the
round asks for them, which is what the cap was asked for. It waits for the round's
own two frames to be up before starting, or it competes with them for the
connection.

The session is judged at **one rendition throughout**, resolved by the triage store
from a member's own `library_id` against `LibrariesStore` and `AppSettingsStore`.
Not `PhotosStore`: `showing` is a function of `openPhoto`, which on this
route is either the entry photo; pinning one photo's remembered choice onto every
member, or nothing, where the library lookup misses and every session silently
becomes the camera's JPEG.

The session **ends by leaving**. With no round left there is nothing to decide, so
once the closing writes have landed the screen returns to the viewer on a survivor
(§20.6). Nothing is on screen afterwards to report against, so a write that never
reached the server is raised as a toast offering the retry, that being the one
thing here which outlives the route - and it is why `setTriage` is asked to stay
quiet per verdict rather than reporting each failure where it happens.

### 20.6 Entering, leaving, surviving a reload

`DetailNav`'s menu gains a **Stack** section when the photo has `stack_id != null`,
not the grid tile's `stack_id != null && stack_size > 1`. `stack_size` is a property
of a collapsed listing row: `toDetail` and the band-member listing both hardcode it
to 1, so the tile's condition would hide the way in on every route that actually
reaches the viewer from a stack. A stack has two or more members by construction.

Leaving mid-session is an explicit route to the entry photo, falling back to its
library; not `navigate(-1)`, which nothing in the app uses and which strands
anyone who refreshed. A *finished* session leaves by itself, to the survivor that
sorts **first** in the collection's order: the frame the judging was towards, and
one the viewer can place, where the photo the session was entered from has usually
been rejected and so left the gallery's filter with both its arrows dead. That one
is asked for rather than worked out here: `POST /api/photos/range` is handed the
photographs the stack lies between, and the first row still carrying its stack id
is the answer, in the collection's own ordering. The bounds come off the viewer's
run when the session opens, since a reload has no other way to know them.

The session is stored under `bowerbird.triage.<stackId>` in `sessionStorage` with
its history, baseline, entry photo, those bounds, and failed writes. **A finished
session is dropped**, key and all: there is nothing to come back to, and one
restored would send the reader straight back out to the viewer, which is a stack
that can never be opened again. A stored session with no round left is treated as
none for that reason - which is what a reload caught between the closing writes
and the drop leaves behind - and opening the stack then begins a new tournament,
against the members' verdicts as they now stand.

`seen` is stored as an **array**: `JSON.stringify` renders a `Set` as `{}`, which
would return every session to a blank draw history and break §20.1's guarantee
where nothing would notice. History is capped at 50 entries, since each snapshots
a whole session.

On open the stored session is **pruned, never re-derived**: an id that is no longer
a live member is dropped from the pool, and `seen` is deliberately left alone,
because a pair naming a departed photo can never be offered again and dropping it
would demote a considered keeper out of the closing write. Re-deriving the pool
would return every eliminated photo to contention having already lost.

### 20.7 Tests

`stack_triage.ts` takes the unit tests: the N−1 decisive run, the 6-round all-draw
over four, a randomised sweep asserting no repeated round and that every keep set
is a clique of mutual draws, the worked case where two drawn photos still meet the
winner, `Neither` emptying the pool, the `upcomingRounds` cap and shrinkage, and
`arrangement` by aspect number rather than by adjective, a 3:1 panorama beside a
portrait chooses the *row*, and only turns over past about 4.5:1.

`PhotoStage`'s existing behaviour was pinned by e2e before the refactor: zoom
survives a rendition change and resets on a photo change. The screen takes an e2e
of its own over a three-frame fixture stack, in its own library because a session
writes over every member it judges.

`listStackPhotos` (§19.5.3) supplies the members and
`PATCH /api/photos/:id` records the verdicts.
