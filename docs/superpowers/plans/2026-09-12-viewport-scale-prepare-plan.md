# Viewport-scale prepare: implementation plan

Against `docs/superpowers/specs/2026-09-12-viewport-scale-prepare-design.md`.

Two parts. **Part A is backend prepare at one level**, which is what makes a panorama open in the
editor at all. **Part B is the level ladder and the windowing** that turns one level into a
viewport-scale pyramid, written up here because the review that produced Part A's scope is what
makes Part B's cost knowable.

**Part A has landed.** It is kept below as the record of what it was and why, with the two places
it ended up differing from this plan marked in §2.1 and §4.1. Part B is what is left.

## 0. Why the split, and what decided it

The design's §5 and §6 describe a window of a canvas, fetched per viewport, cut into tiles, with
the level chosen per tick. Reviewing that against the code turned up eleven places where
**windowing** - not backend prepare - is the expensive and risky part.

This is the review as it stood, and what the split was decided on; §8 says what each of these
eleven turned out to cost and which of them are still open.

1. **`base::Gather::window` hardcodes `scale: (1.0, 1.0)`** (`base.rs:1748`, and its doc says why:
   "a tile is read at the frame's own resolution"). The only other reduction is `view::Scale`,
   which is `Full | Half` (`view.rs:25-31`). So the single-file window gather can produce level 0
   and level 1 and **no level below that** - and a phone opening an ordinary 6000px RAW at a 400px
   stage wants level 3. There is no arithmetic for it short of merging the two gather kernels.
2. **The draw's window-plus-canvas combination is exercised nowhere.** `Grade::windowed` is used
   only by two encodes (`job.rs:1251`, `fixture_tests.rs:1079`, both `canvas: None`), and
   `.onto(canvas)` only at `wasm.rs:661`, where `window` is `None`. `tile::Prepared::grade`
   deliberately applies no geometry (`gpu.rs:1717-1719`: "a loupe tile applies no geometry"), so
   reusing it for the stage would drop the reader's crop.
3. **`gpu::present` and `Uploaded::draw_into` take `&base::Pyramid`, not an `Option`**
   (`gpu.rs:1378-1383`, `:3299`), and `Drawing.pyramid` is non-optional (`wasm.rs:112`). A
   window either builds one or three signatures change.
4. **The loupe has no source on a backend arm.** `hold_tile` cuts its tile out of the held mosaic
   (`wasm.rs:347`, `Source::Held`), which a tab that downloaded no RAW does not have.
5. **The prepare worker is one job at a time.** `openComposite` chains them
   (`processing_service.ts:679-713`), so every reader's every zoom would queue behind every other,
   and an HTTP abort cannot cancel a synchronous `bb_prepare_window` already inside `bun:ffi`.
6. **A 20-110MB buffer has to be *transferred* across the worker boundary**, and
   `self.postMessage` is typed `(message: ProcessingResult) => void`
   (`processing_worker.ts:28`), whose union carries no bytes.
7. **`ensureOutputDirs` runs before the kind check** and maps `job.targets`
   (`processing_worker.ts:32,132`), so a targetless prepare job throws there.
8. **Per-window statistics walk.** `hold_drawing` measures the scene peak off whatever was
   uploaded (`wasm.rs:256`), and `wasm.rs:354` already states the rule a window would break:
   "**The photograph's peak, not this crop's**". `as_shot` and the defocus pair are set only where
   the reference is in the window (`composite_tile.rs:662,722`), and `TileRequest` has no `as_shot`
   field to hand them back through.
9. **A composite window has no halo.** `keep` is `[0, 0, width, height]` (`composite_tile.rs:766`), and
   `MARGIN = 3` is in the source's own pixels where the gather's four-tap stencil needs two
   *decoded* ones (`composite_tile.rs:457`), so two adjacent windows clamp differently over their
   shared boundary.
10. **A window no source covers is a hard error** (`composite_tile.rs:754`), where a render leaves it as
    the zeros it was allocated with (`composite_job.rs:647-656`). Panning into a hand-held pan's corner
    wedge would fail the panel.
11. **`region` is in the output's pixels, after geometry** (`raw_edit_store.ts:74-80`), while a
    window is in the canvas's - and for a panorama the row's `width`/`height` is *already*
    `displaySize(canvas, framingEdits(recipe))` (`photos_repository.ts:1492`), so a naive header
    frames the picture twice.

**Every one of those is a windowing problem. None of them is a backend-prepare problem.** Prepare
the whole canvas at one level and the frame the module holds *is* the photograph: the draw is the
path it already takes (`window: None`), the pyramid is `base::pyramid_of` over it, the peak is
measured once over the whole picture, `as_shot` and the levels and the match all come from a
prepare that by definition covers the reference, there are no seams because there is one window,
and the region keeps meaning exactly what it means today.

So Part A is the whole of the deliverable and about a quarter of the surface.

Part B then adds the rungs above it, for a composite: a window of a finer level, fetched when the
reader zooms past what they hold.

**Which is also why the gate is narrower than the design's.** The design flips the default to
backend prepare. It stays narrow while a *single file* has no levels: a 61MP one prepared at 4096
is visibly softer at 100% than the full-sensor open the editor does today, so flipping would make
the desktop app and the shell worse at the one thing they are best at. So the backend arm is taken
only where the frontend one *cannot* run - a composite, a canvas over the area ceiling, or a device
that cannot hold one - and the full flip waits on the gather merge (§8), which is what gives a
single photograph a ladder of its own.

## 1. Part A: Rust

### 1.1 `Panorama::of_one`, `placement`, `level_of`

Landed: `composition.rs`, committed as `feat(recipe): a single photograph is a recipe of one, and a
canvas has levels`, with the round-trip, placement and level tests.

`placement` is not read by Part A - nothing chooses a gather yet, because Part A does not merge the
orchestrations. It is Part B's, and it is committed because the arithmetic it pins (a one-source
recipe *is* the photograph) is what Part B's whole argument rests on.

### 1.2 The composite's own analysis, and its sharpen

Today `composite_job::base` reports `analysis: PhotoAnalysis::default()` (`composite_job.rs:702`), `stored:`
the reference's (`:687-692`, `:704`) and `wb_gains: [1, 1, 1]` (`:714`). Since `job::run` files
`analysis.filled_from(&stored)` (`job.rs:1326`), a composite's row is filed with the *reference
frame's* levels and match, and `sharpen_noise_table` (`job.rs:1191-1197`) gets no fit, so the
deconvolution runs undamped over every panorama.

- `analysis` becomes the composite's own: `from_raw.matched` the union match, `from_raw.noise` and
  `from_raw.capture_sigma` the reference's, `from_render.levels` the union levels with the
  quantile they were taken at, `from_render.defocus` the reference's pair.
- `stored` becomes `job.stored()`.
- `wb_gains` becomes the reference frame's, which `composite_tile::prepared` already has in hand where
  it keeps `as_shot` (`composite_tile.rs:662-663`) and reports alongside it.
- `union_levels` and `combined` return `Levels` rather than `Anchored`
  (`composite_job.rs:453-459`, `composite_tile.rs:530-557`), anchoring at the use site, because
  `MeasuredLevels.levels` is a `Levels` (`photo_analysis.rs:107`) and the store needs the
  pre-anchor value.
- The comment at `composite_job.rs:712-714` goes with the change it describes.

`From::Camera => None` for `Prepared::matched` (`composite_tile.rs:774-779`) **stays**: a match belongs
to a render of a RAW, and the measurement in that comment is what happens when one is applied to a
camera's own JPEG.

### 1.3 One measure, not three

`union_levels` (`composite_job.rs:451`) and `union_match` (`:486`) each call `stacked_sources`
independently, and `union_match` decodes an embedded preview per source on top (`:492`). For 26
frames that is three passes over the set where one would do. Hoisted to one `stacked_sources`
whose result both read, which is also what makes the first open of a merged panorama affordable.

### 1.4 The prepare entry point

`composite_tile::prepared(spec, request)` already answers exactly what Part A needs: a coded
`Resident` plus a `tile::Prepared`, for any rectangle of the canvas at any scale
(`composite_tile.rs:564`). Part A adds no orchestration. What it adds is the way out:

```rust
/// One picture of a recipe, coded and read back, as the bytes a client uploads.
pub fn prepared_bytes(recipe: &Recipe, sources: &[SourceFile<'_>], request: &CompositeRequest) -> Result<Framed, String>
```

`Framed` is the wire form: the `Prepared` numbers as a serialisable struct plus the `u16` samples.
`Prepared` itself cannot serialise - it derives nothing, `samples` would put the pixels in the
header, and `reference_nits` is `pub(crate)` (`tile.rs:102-123`) - so `Framed` is a new struct
naming the fields a client needs, and a test holds the two together.

The sharpen the composite wants runs here rather than at `Cut::from_base`, because a client gets
no cut: `sharpen_into` over the coded canvas, with `deconvolve_split(capture_sigma, sensor_long,
level_long)` where `sensor_long` is the canvas at scale 1, as `composite_job.rs:706-711` already argues,
and the noise table from §1.2's analysis. The dead per-source sigma at `composite_tile.rs:683-687`
goes: it is computed from the decoded region's size, so it varies with how much of a source a
window reaches, and it has only ever fed a `base::prepare` call whose sharpen is zero.

### 1.5 FFI

```rust
pub unsafe extern "C" fn bb_prepare_picture(
    command: *const u8, command_len: usize, out: *mut u8, out_cap: usize,
) -> isize
```

- The caller sizes `out` exactly: `width * height * 6 + PREPARE_HEADER_CAP`, both known before the
  call from the level. **No grow-and-retry** - `ffi.rs:23` returns the size needed and
  `rawshim_job.ts:284` reallocates and *calls again*, which here would prepare the picture twice.
  A short buffer is an error naming the size.
- `bb_prepare_header_cap()` reports `PREPARE_HEADER_CAP`, checked once on the TS side the way
  `bb_header_size` already is (`rawshim_ops.ts:74-76`).
- The body is framed: `u32` little-endian JSON length, that much JSON, padding to a multiple of
  four, then the samples. Four bytes, so the samples land on a word and the page can view them
  without a copy - the same framing and the same reason as `src-tauri/src/api.rs:239`.
- The command carries the recipe, the sources with their paths and analyses, the level, and the
  request. **The one-source recipe is built here, not in TypeScript**: `of_one` needs a
  `LensSpec`, which lives inside the `photo_analysis` blob that the server deliberately does not
  interpret (`image_api.ts:135`).

### 1.6 The composite's analysis reaches disk

`processing_worker.ts:133-137` returns from the panorama branch above the only
`writePhotoAnalysis` call (`:142`), and `toCompositeCommand` reads analysis per *source* (`:123`)
and never the composite's own. So no panorama has ever had an analysis row, and §1.2's numbers
would be computed and dropped.

- The panorama branch reads `readPhotoAnalysis(job.dataPath, job.photoId)` into the command and
  writes what comes back, as the rendition branch does.
- `JobComposite` gains the slot both ways (`rawshim_job.ts:185-203`), and `CompositeJob` in
  `processing_types.ts:175` with it.

## 2. Part A: the server

### 2.1 `GET /image/:photoId/prepare`

- A route on `ImageApi`, registered in its constructor beside the analysis pair. It needs no new
  mount, and the shell proxies it with no Rust change: `api.rs:264-269` forwards any path under
  `bowerbird://` with no allowlist.
- **Landed with no query at all, where this planned `level` and `detail`.** Which level to prepare
  is the server's: the canvas is the recipe's rather than the row's, so a client asking would be
  asking before it could know, and it would be a second implementation of the arithmetic that
  decides whether the picture fits a texture limit. As planned, the page asked for level 0 always,
  which routed the *largest* canvases to the arm that fetched them whole.
  `prepare-levels.txt` pins the one copy that remains, which is the size the buffer is allocated
  at.
- **And `no-store` rather than `immutable`.** The body is tens to a hundred megabytes, so a cache
  of it evicts everything a reader is browsing to hold the one they are editing - and it is a
  function of a library setting, the document and every source's analysis, so a `detail` hash the
  client could compute would not have covered it anyway. Part B's tile cache is page-side and
  keyed in memory, which is where that design belongs.
- `Content-Type: application/octet-stream` and `Timing-Allow-Origin` as its neighbours set it. The
  `Prepared` numbers are **in the body**, not a header: the shell keeps seven response headers and
  drops the rest (`src-tauri/src/api.rs:313`).
- `ImageApi` gains two constructor dependencies (the recipe resolver and the prepare runner), so
  `src/index.ts:237` and the four suites that construct it move with it:
  `src/api/image/tests/photo_analysis_route.test.ts`, `embedded_route.test.ts`,
  `share_route.test.ts`, `src/services/photos/tests/photos_service.test.ts`.

### 2.2 What `detail` has to hash

Everything that moves the prepared samples, which is more than the filters:

| In the hash | Because |
|---|---|
| denoise luminance and colour, sharpen, defringe, dust | they filter the mosaic and the frame |
| `grade.white_quantile` | it picks the levels the frame is coded against (`tile.rs:308-310`) |
| `grade.reference_white_nits` | it is the coding curve's own scale (`base.rs:1464-1479`) |
| a hash of the recipe | a re-align is a different picture |
| a hash of each source's analysis blob | the lens the gather uses and the spots the dust corrects come out of it, and an open before the analysis was written prepared without either |

The last two are what a settings change or a first-open measure would otherwise serve stale from a
URL cache. `tileRevision()` (`raw_edit_presenter.ts:771`) is the same hash one layer up and
becomes a shared function rather than a second spelling.

### 2.3 It runs off the API thread

A prepare is seconds of `bun:ffi`, and `ImageApi` is on the API thread. It goes through a worker,
and three things about the existing one have to change:

- `ensureOutputDirs` moves below the kind check, since a prepare job has no targets
  (`processing_worker.ts:32,132`).
- `ProcessingResult` widens to carry the framed bytes, and the worker **transfers** the buffer
  rather than letting it be structured-cloned.
- A prepare gets its own worker rather than sharing `openComposite`'s single chained one
  (`processing_service.ts:679-713`), so an open does not queue behind a library's renditions.

`renderable` (`composites_service.ts:187`) keeps its name and its null-for-not-a-composite
contract - three call sites depend on that null (`src/index.ts:110`,
`processing_service.ts:602`, `:1036`, `export_service.ts:94`) - and a `sourcesFor` beside it
answers for a `file` recipe as a one-source list.

## 3. Part A: the module

`wasm.rs` gains one export and one enum; nothing else about the tick moves.

```rust
enum Prepare {
    /// The tab's device, from a RAW it holds at the mosaic. Today's open, unchanged.
    Frontend { held: decode::Held, bytes: Vec<u8>, mosaic: bool, fit: Option<NoiseFit>, request: EditRequest },
    /// The server's device: a picture that arrived coded, at one level.
    Backend { canvas: (usize, usize), level: u32 },
}
```

`Frontend` carries all five of `HeldRaw`'s fields, not the two the design sketched: `mosaic` and
`fit` and `request` are read by `prepare`, `opened_as`, `band_request` and `hold_drawing`
(`wasm.rs:51-55`, `:196`, `:218`, `:522`, `:264`).

- `holdPicture(bytes, request) -> PreparedHeader` is the new entry point: it reads the framing,
  uploads the samples with `Resident::upload`, builds the pyramid with `base::pyramid_of` and the
  `Drawing` over it, and answers the header. The whole canvas at one level *is* the photograph, so
  `hold_drawing`'s own peak measurement is the picture's and `draw` takes the `window: None` arm
  it already takes.
- `bandInto`, `refreshDetail` and `prepare` stay `Frontend`-only and say so: they re-run a held
  mosaic, which a backend open does not have. On the backend arm a Detail move is a new `detail`
  hash, so a new URL.
- `holdTile` stays `Frontend`-only in Part A. **The loupe is not offered for a backend open**, and
  the page hides the control rather than failing it: a loupe claims to be the export's own pixels,
  and the coarsest level is not those pixels. Part B restores it as a level-0 window.
- `HeldRaw` keeps its name. Renaming it costs `local_open_worker.ts:2,17,112` plus six doc
  references, buys nothing Part A needs, and `Held` would collide with `decode::Held`, which this
  struct holds as a field.

## 4. Part A: the web

### 4.1 The gate

`web/src/features/raw_edit/prepare_choice.ts`:

```ts
export function preparesOnTheBackend(recipe: StoredRecipe, photo: { width: number; height: number }, client?: Client): boolean
```

True when the recipe is not a single file, or the photograph's area is over `10_000 * 10_000`, or
the device is mobile (`matchMedia('(pointer: coarse)')`, or `navigator.deviceMemory <= 4` where
defined). A tab and the shell are treated alike, because Part A's one level would make both softer
than they are today (§0).

**The recipe rather than a canvas, which this planned as a size, and the reason is not size at
all**: the local arm downloads the photograph's own bytes, and a recipe over several others has
none. A six-view pan of 1280x800 frames composes about five megapixels, nowhere near the ceiling,
and had nothing to download - the end-to-end run is what said so.

**And the presenter fetches the recipe itself rather than the page handing one down.** The page's
copy arrives from a parallel effect, so a first open read `null` and answered "an ordinary
photograph"; awaited alongside the document the open already waits for, it cannot.

`matchMedia` is only a React hook today (`device.ts:26-28`); the presenter needs a plain function
beside it. `navigator.deviceMemory` needs a `declare global`, not being in `lib.dom.d.ts`. The
shell predicate is `shellInvoke()` (`transport.ts:33`), not `assetUrl`.

### 4.2 The open

- `preparedHere` (`raw_edit_presenter.ts:1562`) forks behind `fetchPrepared` (`:1519`), which
  already returns `{ header, local }` and is the whole seam.
- The frontend route is today's, untouched.
- The backend route fetches `/image/:id/prepare` and calls `holdPicture`. It downloads no RAW.
  `getSettings()` and `storedPhotoAnalysis()` stay on both.
- **The gate reads the recipe, so the open has to have it.** `open(photoId, longEdge)` awaits the
  detail the page already fetches (`photos_presenter.openDetail`, landing in
  `photos_store.details`), or fetches it itself - it is one small row, and the open already awaits
  `api.getEdits` for the same reason (`:325-328`).
- The `maxTextureDimension2D` refusal moves ahead of the download. It fires in `hold_drawing`
  today (`wasm.rs:247-255`), i.e. after the RAW has been fetched and prepared, which is a late
  failure where the gate can be an early one.
- `LocalSource`'s doc at `:1514-1515` ("One path, under the shell as much as in a tab... There is
  no second arm either") is rewritten as a statement of what is now true, in the same commit.
- `local_open.ts:169`'s reference to a route `/image/:id/prepared` is stale; it goes.

### 4.3 The protocol

`local_open.ts` / `local_open_worker.ts` gain one tag, `holdPicture`, with the bytes transferred
rather than copied (`hold` at `:165` is the pattern), answering the header JSON as `prepare`
already does.

### 4.4 The page

- `photo_detail_page.tsx:261-267`: the `panorama` arm of the refusal goes, with the
  `editRefusesPanorama` string (`:35`) and the now-dead parameter at `:243-249`, `:416`.
- `hasOriginal: photo?.has_original ?? true` (`:415`) would still disable Edit for a composite,
  which has no original file. It reads the recipe: a composite is editable when its sources are
  present, which is what `renderable` already answers server-side.
- The loupe control is hidden on a backend open (§3).

## 5. Part A: tests

`bun run test:native`:

- The framing round trips, and `Framed` names every field of `Prepared` a client reads.
- The composite's analysis carries the union levels and match, and a second render handed it
  measures neither again.
- One `stacked_sources` feeds both union measures.

`bun run test:native --features fixtures`:

- `a_tile_is_graded_as_the_rendition_is` unchanged and still exact. Part A touches neither
  gather, so this is a regression check rather than a new claim.
- **A composite picture held against the composite rendition of the same size.** This is the pin
  Part A's pixels need, and the existing test's own reasoning is why it is against a rendition
  rather than against a second window: "every fault this has had was invisible to a comparison of
  two tiles" (`fixture_tests.rs:846-849`).
- The composite's sharpen is damped: the noise table for a panorama is not all zeroes.

`bun run test`:

- `canvasOf` for both recipe kinds, and that a panorama's is the unframed canvas.
- `preparesOnTheBackend` over the corners: a composite, 10000x10000 exactly, 12000x10000, a coarse
  pointer, the shell, a small file in a tab.
- The framing, read in TypeScript against a fixture the Rust test writes.
- The route: the body's length matches its header, a bad level is refused, a `detail` change is a
  different response, a photo with no analysis gets one written, and a second request for the same
  URL measures nothing.
- `raw_edit_presenter`: a backend open reaches `holdPicture` and never `downloadedRaw`; a
  frontend open still does the reverse; a grade slider on a backend open ticks without a fetch.

`bun run test:bench` after the sharpen moves, since a stage's cost is a thing this repo promises
about. Expected to move: nothing for a single file, because Part A does not touch that path; the
panorama rows are not in the budget today.

Playwright, once, at the end: `web/e2e/editor/panorama.spec.ts`, its own library root. Open a
panorama in the editor and assert a frame arrived on the GPU the way `grades on the GPU` does -
the adapter's name and the stage's dimensions, and no pixel, because "that a frame *arrived*, not
what it looks like" is the rule (CLAUDE.md).

## 6. Part A: the fixture panorama

No library fixture has a panorama and `web/e2e` has no panorama coverage at all. The views
`composite_align`'s tests align are synthetic and inside `#[cfg(test)] mod tests`
(`composite_align.rs:657-770`), so an example cannot see them.

- Move `scene`/`shot`/`written`/`rig` and their constants into a `pub` module of the crate, used
  by the existing tests unchanged, and add `examples/composite_views.rs <dir>` that writes the PNGs.
- **Commit the six views** rather than generating them in the e2e setup: a cargo build inside
  Playwright's `beforeAll` is minutes, and six 1280x800 PNGs of a synthetic scene compress small.
- The spec's own root, with `useLibrary` in `beforeAll`, then `POST /api/panoramas` over the six
  photo ids. That call aligns *and* builds the composite's grid and full renditions before it
  answers (`composites_service.ts:85-125`), and it serialises globally (`:74-83`) - seconds for
  1280x800 PNG sources, and the spec has to await the whole merge rather than just an align.
- `scripts/dev-panorama.ts` does the same against a dev server and prints the editor URL, which is
  how this gets checked by hand.

## 6.1 What Part A ended up being pinned by

Beyond the suites §5 names, three things hold the two hosts together:

- `web/e2e/fixtures/gpu/prepare-levels.txt` - which level a picture is prepared at, and what that
  level measures. `gpu_fixture.rs` writes it and asserts the ceiling it carries;
  `prepare_levels_parity.test.ts` reads the same table. The page sizes the buffer the library
  writes into, so a disagreement is a prepare thrown away at best.
- `ffi::framing` - the frame round trips, over header lengths either side of every alignment. The
  offset itself is `edit::samples_at`, stated once because the writer and the reader are in
  different builds.
- `every_level_of_a_prepared_picture_is_one_photograph` - two levels of one composite carry the
  same diffuse white and the same top end, which is what the stored analysis is for: a picture
  whose exposure changed as a reader zoomed would be the tile-banding fault one axis over.

## 7. Part A: order of work

1. Landed: `of_one`, `placement`, `level_of`; and the neighbourhood-reach fix beside them.
2. The composite's analysis and its one measure (§1.2, §1.3), with the worker write (§1.6).
3. `prepared_bytes`, `Framed`, the composite's sharpen (§1.4), and the framing's pins.
4. The FFI symbol (§1.5).
5. The route, its worker arm and its tests (§2).
6. `holdPicture` and `Prepare` (§3), then `bun run build:wasm`.
7. The page: the gate, the open's two routes, the refusal (§4).
8. The fixture panorama and the dev script (§6).
9. Every suite, named: `bun run test:native --lib`, `--features fixtures`, `bun run test`,
   `typecheck`, `lint`, `test:bench`, then the one e2e spec.

## 8. Part B: the level ladder

Landed for a composite, which is the recipe kind that has levels at all. A reader opens on the
coarsest whole level and, past what that resolves, is served the window of a finer one - down to
level 0, the canvas's own pixels.

What it took, against §0's findings:

- **Finding 9, the halo.** `MARGIN` was three pixels of the source's full-resolution frame where
  the stencil that needs them reads a decode reduced by the render's scale. It is scaled now, and
  `a_window_of_a_coarse_level_still_decodes_its_neighbourhood` measures the region against where
  the gather actually taps.
- **Finding 8, the per-window measurements.** `FromRaw::balance` files the reference frame's gains
  and illuminant, so a window away from the reference reads them instead of decoding it. Each half
  on its own: a source with no usable multipliers has gains and no illuminant.
- **Finding 10, the uncovered window.** Already answered by `covered`, which the render path uses
  to leave a tile as the zeros it was allocated with.
- **Findings 2 and 3, the draw.** No change to either. `geometry_at` already subtracts a window's
  origin before dividing by the level's shrink, so a pyramid of the window is indexed by exactly
  what it hands back, and `the_draw_places_a_pixel_where_the_gather_does` already covers the
  windowed mapping over ten geometries. What the module gained is where its buffer sits, and
  `takePicture` to replace a picture on an open whose stage has already been transferred.
- **The space a region is asked in**, which was not among the eleven and should have been. A region
  is in output pixels and a window is cut from the picture, with the reader's geometry between
  them. `HeldRaw::picture_part` maps one to the other through the same `image::geometry_at` the
  draw uses, so the page asks rather than deriving a second answer.
- **Finding 11, the double framing.** Two sizes for a picture, and the header carries both:
  `canvas` at the level served, which the draw indexes by, and `picture` at scale 1, which the page
  states the reader's own things against. `atTheLevel` is the one conversion. The grid's own
  instance of the same error - a composite's framing crop applied to a row already framed - is
  fixed in `displayed`.

**Still open, and each is a decision rather than an omission.**

- **The gather merge**, which is what a *single file* needs to have levels. Its arm reaches the
  sensor through a decode that offers the frame whole or halved and nothing between (§0 finding 1),
  so a window of one is refused by name. `Panorama::of_one` is the route. It brings with it a
  Jacobian out of `composite_gather.slang` - the sharpen's corner variation comes from
  `warp_lens_into`'s per-pixel one and the composite gather emits none - and `job::run`'s
  largest-first restructure, since under a gather that scales each target size would re-gather from
  the sources. `gpu_fixture`'s pins and the bench budget move in that commit, deliberately, and
  `a_tile_is_graded_as_the_rendition_is` stays exact because both sides move together.
- **The union measure reads the set ahead of each source's gain.** `stacked_sources` copies what
  each source decoded to; the gain lands in the coding. Close for the gains an alignment produces,
  and named where it happens. The fix is a gain per row of the stack inside `fit_source::levels`,
  which belongs beside the merge where the gains already flow through the gather.
- **A tile cache**, so a pan back to where the reader just was costs nothing. Today every window is
  fetched and the previous one is dropped.
- **The per-open prepare worker with cancellation** (findings 5, 6). One worker serves every
  reader, so two readers zooming queue behind each other, and an HTTP abort cannot cancel a
  synchronous call already inside `bun:ffi`.
- **The loupe as a level-0 window** (finding 4). The glass is closed for a backend open rather than
  shown something the export is not.
- **`Base::build` dispatching on the recipe** - the design's §2 row this leaves as two assemblers.
  It is the same restructure as the merge.

## 9. Deliberately not in either part

- Persisting prepared levels to disk. The stored analysis is the only thing written.
- The native overlay surface (`raw-edit-gpu.md` §10.2, option c).
- Aligning a panorama from the editor. The recipe arrives from `POST /api/panoramas`.
- Raising `composite_job::MAX_LONG_EDGE` (16384). Above it a panorama has no rendition of that size, so
  a level-0 window of a larger canvas is editor-only and the loupe's "the export's own pixels"
  claim does not hold there. A deliberate decision, not this one.
- What a temperature slider should *mean* for a blend of differently balanced frames. It is a
  grade input (`gpu::Adjust`), so it works at tick speed against the reference's as-shot; whether
  that is the right meaning is a question this does not open.
