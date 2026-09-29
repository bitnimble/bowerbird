# Take best parts: a photograph assembled from a burst

A second composite recipe: combine burst frames aimed at the _same_ scene, replacing unwanted
parts of a preferred base frame - a blink, passing car or moving branch - with parts from other frames.

Two use cases decide every choice below:

- A group photo shot five times. Take each person from whichever frame they were looking at the
  camera in.
- A landscape shot twice while a car drove past. Take each half from the frame the car was not in,
  so the picture has no car.

A **tile** here is a polygon assigned a frame. Disambiguate `composite_tile.rs` render windows as
_canvas windows_, and `grid` renditions as _grid tiles_.

## 1. What this costs

Reuse panorama rendering with a different `composite_gather` `weight`, prepared sources on one
canvas, and alignment with held focal. **Everything between is new:** `slang/`,
`native/rawshim/src/`, `src/`, `packages/` contain no distance transform, min cut, boundary trace,
polygon simplification or band split. §3 and §5.2 need new pins and design-chapter edits.

What genuinely carries over:

| Piece                                                       | What it already does                                                                                                                                    | Used here for                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `slang/composite_features.slang`, `composite_align::paired` | Harris corners, descriptors, Lowe's ratio test                                                                                                          | Alignment, unchanged                                                             |
| `composite_pairs.rs`                                        | Coarse translation correlation and a dense refine                                                                                                       | Alignment, unchanged                                                             |
| `composite_solve.rs`                                        | One rotation per source, one focal for all                                                                                                              | Alignment, with the focal leashed (§3.1)                                         |
| `composite_align::assumed_focal`                            | 55-degree HFOV fallback where EXIF is silent                                                                                                            | The same fallback here (§3.1)                                                    |
| `composite_tile::prepared`, `From::Original`                | A source prepared with `Strengths { sharpen: 0, defringe: 0 }`, `Detail::at(0, 0)`, `Known::Off`, and the lens applied from the _recipe_ at gather time | The analysis planes (§3.0)                                                       |
| `slang/composite_gather.slang`                              | A source into a canvas window, `Through::Lens`, plus a weight                                                                                           | Gathering planes and rendering, with the weight read rather than computed (§5.2) |
| `slang/composite_blend.slang`                               | Layers accumulated in light, resolved to codes                                                                                                          | The coverage mix, unchanged (§5.2)                                               |
| `base.rs::light_of_code`, `base::pyramid_of`                | The inverse-PQ table; a box-mean pyramid                                                                                                                | Every measurement's space (§3.0); the base of the lowpass (§5.2)                 |
| `galosh::NoiseModel`                                        | Noise as a function of level, fitted per frame                                                                                                          | The tint's noise floor (§3.3)                                                    |
| `dust.rs` / `slang/dust_find.slang`                         | A shader finds; the host walks a **shrunk** mask; a bounded list crosses back                                                                           | The precedent, and its limit, for §3.4-§3.7                                      |
| `stage_gpu.ts::paintExtended`                               | A `VideoFrame` drawn through a render pipeline onto an `rgba16float` canvas                                                                             | The page's canvas, in HDR (§4.1)                                                 |
| `ui/submenu.tsx`                                            | A nested menu section, already used in `bulk_bar.tsx`                                                                                                   | The menu change (§2.1)                                                           |
| `triage_storage.ts`                                         | The **pattern** for session state that survives a reload                                                                                                | Modelled, not imported - it swallows a quota failure and this must not (§4.4)    |

Explicitly **not** reuse:

- `fit_lattice.rs` is the camera match's 4-D chroma lattice moments. There is no 2D offset lattice
  in this repo (§3.2).
- `job::Base::build` is not a chain with stages to switch off: the denoise runs inside the decode,
  the warp and the encode run after the grade in `run`, and the warp is entangled per frame with the
  colour fit. The analysis does not go through it (§3.0).
- `build-web-shaders.ts` compiles `stage.slang` and `stage_import.slang`; there is no compute
  pipeline in `web/src` and no AVIF decoder in an editor wasm build. §4.1 works inside those limits.
- `insertComposite` is typed `Composition` and hardcodes `kind: 'panorama'`; `framingEdits` is
  typed `Composition`. Both widen.

## 2. The reader's path

### 2.1 Getting there

`bulk_bar.tsx`'s `stackOptions` offers `Merge to panorama` as a flat row today. That row moves into
a `Submenu` labelled **Merge photos**, holding **To panorama** and **Take best parts**, in a section
of its own - `OverflowMenu` renders a section's `content` above its `options`, and the stack section's
ordering that keeps Stack and Unstack adjacent is deliberate.

Refused **before navigating**, each by name, with the strings in `merge_page.strings.ts`: fewer than
two photographs; photographs from more than one library; a photograph that is itself a composite;
more than **twelve** frames. The service refuses the same four again, since a request can arrive
without the page.

### 2.2 The page

`photos/merge/:jobId`, and `photos/:photoId/merge` for a finished one (§2.7), registered under
**every collection prefix** exactly as `stacks/:stackId/triage` is in `app/app.tsx`, plus the bare
fallback beside it - otherwise Cancel has nowhere to return to.

Navigated to **immediately**, before the analysis runs, with progress and a **Cancel** on the page.
Cancel aborts the request; the service's one-at-a-time queue (§3.9) drops the analysis at its next
frame boundary and releases the device.

Modelled on `stack_triage_page.tsx`. The split, per the architecture rules:

- **`merge_store.ts`** - one decorated class, observables and computeds only: `recipe`, `picks`
  (source index per tile), `base`, the held seam solves, `hoveredTile`, `hoveredSwatch`,
  `openTile`, `readOnly`, `showingLines`, and the computeds `drawnSeams`, `pieces`, `swatches` and
  `drawing` - what the canvas shows (`merge_layers.ts`).
- **`merge_presenter.ts`** - the only writer. `openJob`, `openExisting`, `seed`, `openTile`,
  `stepTile`, `hoverTile`, `pick`, `stepSwatch`, `hoverSwatch`, `undo`, `redo`, `setFeather`,
  `settleFeather`, `toggleLines`, `commit`, `commitExisting`, `discard`, `cancel`, `finish`. Owns
  the stage, the in-flight `AbortController`s, and reactions that draw a changed `drawing`, ask for
  it as a render once it settles (§4.1), solve newly wanted seams and save the session of §4.4.
- The page component constructs both and passes them down, as `photo_detail_page.tsx` does with
  `RawEditStore` / `RawEditPresenter`.

One canvas, the composite at the analysis scale, with the viewer's zoom and pan.

**The reader makes every tile** (§2.4). The analysis finds none; it leaves the seam field they grow
over (§3.7b), so the page opens as the base frame under a crosshair.

Each grown piece is an **SVG path**, stroked in the accent colour at low opacity, no fill. Hover
fills it white at 8% and sets `cursor: pointer`. SVG does the hit-testing and scales with the zoom.
Only grown pieces are ever drawn: a pick not yet solved leaves the picture as it stands.

A **tile-lines toggle** hides the outlines. `[` and `]` step between tiles, and the arrow keys between a
popup's swatches.

### 2.3 Choosing

Clicking a piece opens its tile's popup: a spinner until every frame's growth of the tile is solved
or refused, then one swatch per frame, each **clipped to the tile as that frame grows it** (the
largest growth another frame found where its own was refused, the tile itself where every one was),
in **capture order always** - a swatch that stays put is what a reader flicking
between two of them needs. The current pick is marked.

**Each swatch is a crop of that frame's layer**, the one the page already holds (§4.3), over the
tile's bounding box and scaled to fill the swatch, so a small tile is shown larger than the canvas
shows it. Nothing is fetched for a popup, so every swatch opens with it.

**Hovering a swatch composites it into the main canvas, in place.** Clicking picks it.

### 2.4 Seeding a tile

A click on the picture, off any piece, seeds a tile there: a square a hundredth of the long edge
across, on the base, **on top of** whatever it overlaps - tiles are a painter's stack in the order
they were made. Its popup opens at once, and opening it solves every frame's growth of it (§3.7b), so
the swatches show each frame grown before the reader has chosen. A seed whose popup closes with
nothing picked is dropped again; a press that closes a popup is not also a seed.

A seed outline is the minimum its pick takes. The seam solve grows beyond it; once solved, draw
that growth instead of the square.

### 2.4a Removing a thing

**Remove objects** on the bar is a mode, held pressed until pressed again. A click while it is down
seeds a tile that asks its pick for the **ground** rather than the **subject**: the frame is read
where the tile stands, so what comes back is whatever stood there instead of the thing clicked on.
Everything after the seed - the popup, the swatches, the solve, the settled render, undo, Save - is
§2.3 to §2.5 unchanged.

Only shift differs (§3.7a): subject tiles track the subject into the picked frame; ground tiles
never track, which would bring the unwanted object back. Refuse swatches whose frame still
shows that object over the seed (§3.7b).

What a tile asks for is fixed when it is seeded, like its outline, and the recipe carries it as
`takes` beside `pick`. The list is absent while every tile asks for its subject, so a merge that
never removes anything stores the recipe it always did.

### 2.5 The rest of the page

- **Base frame** - the source every pixel outside every tile comes from: the align's reference, as
  the analysis answers it (§3.8).
- **Undo** and **Redo**, over the sequence of seeds and picks.
- **Blend**, the feather of §5.2 as a share of the long edge.
- **Save**, which writes the photograph and renders it (§5.3). **Cancel**, which drops the session
  of §4.4 and leaves.

Every seed starts on the base frame. **Nothing is auto-picked.**

### 2.6 The photograph that comes out

Date and shoot follow the base frame, as a panorama's follow its reference - `referenceOf` answers
the base for an assembly. Rating does not carry; `insertComposite` copies `shoot_id`, `date_taken`
and `date_taken_offset` and nothing else, and this does not change that. The frames' own edit
documents do **not** carry - the composite gets the framing of §3.8 and nothing else. The canvas is
the **intersection** of the frames, so the result is slightly smaller than any input.

### 2.7 Opening a finished assembly again

Reopen from recipe tiles, picks and base (§5.1), rebuilding layers without analysis. Viewer
**Edit merge** (`photo_detail_page.tsx`) restores the page; Save **updates the recipe in place**
and rebuilds renditions, without a second photograph.

The layers are rebuilt from the recipe's own geometry over the frames as §3.0 prepares them. That
preparation takes no grade, so a frame re-edited since the merge looks the same on this page; its
edit reaches the saved render (§4.2).

A source that has been deleted or binned since is what stops this: the page opens read-only and
names the frame.

### 2.8 Keyboard, and a phone

`1`-`9` pick, arrows move between swatches, `Esc` closes, `[` and `]` step between tiles.

On a coarse pointer none of that exists, and a tile at the analysis scale on a 390pt screen is a
few points across. **Press-and-hold** a swatch previews and **release** picks it. Held to the touch-target floors `mobile.spec.ts` already tests.

## 3. The analysis

### 3.0 What it runs on

**Use panorama sources gathered onto one canvas.** Existing `composite_tile` camera-picture
preparation sets sharpen/defringe to zero, GALOSH fit-only, dust off; `composite_gather` applies
the _recipe's_ lens ratio table. This yields demosaiced PQ in corrected geometry without stages
that hide or invent differences, reusing the panorama grid-tile path.

What that means for each stage the render has:

| Stage                                             | In the plane       | Why                                                                                                                                                                                                      |
| ------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| decode, linearise                                 | yes                | decoded **whole**, not at the decoder's halved size - a halved decode collapses quads and skips RCD, and a residual over a mosaic measures the mosaic                                                    |
| GALOSH                                            | fit only           | its noise model is measured (§3.3 reads it); it corrects nothing, because a denoise would hide what this is looking for                                                                                  |
| demosaic (RCD)                                    | yes                |                                                                                                                                                                                                          |
| lens                                              | at gather          | the recipe is stated in the camera's corrected geometry and the solve's rotations live there; `composite_gather` applies the recipe's lens per source, so **every frame on a lens takes the same table** |
| the colour fit                                    | **no**             | never runs here; the lens the gather applies comes from the recipe, which §3.0's last paragraph fills                                                                                                    |
| grade, tone, defringe, sharpen, dust, chroma leak | **no**             | a burst takes one grade and it cancels out of a difference; the rest hide or invent edges                                                                                                                |
| downsample                                        | after the demosaic | to `ANALYSIS_LONG = 3000`, through `base::resize`                                                                                                                                                        |

**Fit unmeasured lenses once per lens and store in recipe.** `CompositesService.aligned` fits
one photograph per lens; `shared_lenses` distributes the table, avoiding per-frame fits and
doubled seams. Reuse `shared_lenses` unchanged, including libraries with no stored render analysis.

**The planes are the photographs, on every library, whatever it serves.** §3.3's tint floor is
`galosh`'s noise model, and that model is fitted on a mosaic: a camera's JPEG has none, so a set of
them carries `NoiseModel::default()` into every plane and the floor stops being a measurement. So `assembly_planes` asks for `From::Original` outright rather than following
`rendition_source`, and it is the one place on this feature that does.

**Analysis and render sources deliberately differ.** Embedded JPEG libraries analyse RAW mosaics
and draw RAW draft layers (§4.3), but Save composites camera JPEGs through `renditions::sourceFor`.
Library settings cannot supply the analysis noise model; forcing `From::Original` into render
would violate the library's served-picture contract.

**3000 on the long edge is a quarter of a 24MP frame, not a hundredth.** Twelve frames of
levels at 6MP is 288MB, which is the reason for the scale: memory, not speed. It leaves a
thirty-person group photo a 190px face and 45px eyes, which is the size a blink has to show at
(§3.3).

**Every measurement below is taken in light**, through `base.rs::light_of_code`, and where it is a
ratio, in **log2 of light** - the space where an exposure difference is an offset. PQ is not
logarithmic (`tone.rs`'s `gain_in_y` exists because a gain in light is a multiply in PQ's own
domain, not an add), and gamma codes are worse. A threshold tuned in the wrong space means
something different in the shadows.

The planes are HDR, being this pipeline's own PQ, so a highlight that clips in one frame and not
another is a disagreement rather than two whites.

### 3.1 Align, with the focal leashed

Corners, descriptors, Lowe-ratio pairs, `composite_solve::solve` - with the focal **leashed**, which is
the one change to the solve: `told: bool` becomes `Leash::{Told, Assumed, Free}`. `Told` is today's
`FOCAL_HELD` of 2%, whose recorded reasoning is about an EXIF focal rounded and a lens breathing.
`Assumed` is **`FOCAL_ASSUMED = 15%`**, for the case where nobody told us and `assumed_focal`'s
55-degree guess did. `Free` is today's `told: false`.

Why hold it at all: a burst points every frame at the same place, so the focal is nearly
unobservable. In the small-rotation expansion, `Dx = -tz*y + ty*f*(1 + x^2/f^2) - tx*x*y/f`, the
`f * ty` term is exactly degenerate - any `(f, ty)` of constant product explains a pure shift - and
the focal is visible only through the quadratic and cross terms, each of which moves by `2*df/f`
when the fit compensates. At `x/f = 0.5`, 3.5 mrad of rotation and `f = 5000`, each term is 4.4px
at the corner, so a ten percent focal error leaves **about 1.75px** of residual there across both
axes. An assumed focal off by half - a 24mm lens against a 55-degree guess - leaves about 9px, which
§5.2's feather hides at a sharp edge and which is invisible in flat ground.

**Those are the terms' own sizes, not what survives the fit**, and the difference is why the check
below is not derived from them. The rotation is fitted against the same correspondences, so most of
a focal error is absorbed as a turn: measured on the solve's fixture at exactly that geometry, ten
percent leaves **0.10px** of radial pattern rather than 1.75, and a focal off by _half_ leaves
0.86px. The separation is the other half of it - at 10 mrad, where a real hand-held pair sits
(§3.10's is 14), that same off-by-half reads 2.46px. A bound sized off the expansion refuses
nothing.

A held focal has to be checked, and the solve's rms cannot do it: matched corners sit where there is
texture, mostly not at the extreme corner, and a focal error is a **radial** pattern. So `analyse`
checks how much worse the outer fifth of the field registers **than the field's own middle** - the
median inlier residual over the outer fifth, less the median over every inlier - against
**`NEAR_IDENTITY: Extent<Analysis> = 1.15` analysis pixels**. A set that fails is still analysed and
answers `unaligned`, which the page shows as a warning in its bar: the camera moved, what that moved
is parallax no whole-frame fit removes, and each seed's own tracking (§3.7b) is what is left to
absorb it - a seam near the corners may still cross an edge the frames disagree on.

**Type the distance.** Bound uses fixed analysis pixels; reading uses chosen search pixels
(`Kind::plane_long`: burst 808, panorama 1616). Bare 0.6 search pixels meant 1.12 or 2.25 analysis
pixels, spending §3.3's whole budget instead of half and accepting bad bursts. `px.rs` requires
conversion through a `Share` of the measured plane before comparison.

**A difference of two medians, not a statistic of one population.** Each of the three words is load
bearing:

- **Median**, because the bound measures a systematic term. The worst of a few hundred inliers is
  the tail of the inlier distribution instead - it grows with the number of matches and with how
  loose the outlier round was, and on the real burst §3.10 is written from it is 4.14px against a
  median of 1.04px, so a bound of any useful size read off it refuses a set whose registration
  §3.10 measures as holding to about a pixel.
- **A difference**, because the outer median still carries the frame's own texture floor: 1.04px of
  it on that burst, where the whole field reads 0.97px. A bound spent on the floor refuses a
  well-matched frame for being well matched. The difference is what the word radial means - the
  pattern the corners have and the middle does not - and it has a floor of zero by construction,
  which is what makes an absolute bound mean the same thing on two different sets.
- **1.15 analysis pixels**, out of a registration budget of 2.25 rather than out of the lens: the
  field already spends its median 1.10 of it (§3.10), and the 1.15 left is what the corners may add.
  The real burst reads **0.72px** of it (§3.10).

**The check catches incorrect file focal, not assumed focal.** A 15% assumed leash either lets
observable focal recover or leaves no observable residual: §3.1 fixture, 15% error, under a
hundredth pixel at either end. _Told_ focal stays within 2% of file metadata; half-wrong remains
wrong and reads 2.46px against the bound.

**The solve reports it, not the align's caller**, because the align keeps no matches past its own
last fit - `Solved::radial_px` is measured in the same pass that writes the per-pair errors, over
the inliers that survived the outlier rounds.

### 3.2 No lattice

A coarse per-frame offset lattice, to absorb the parallax a rotation cannot model, is **not in v1**:

- Parallax is inverse depth, piecewise smooth with a **step at every occlusion boundary** - a subject
  at 2m displaced 50px against a background at 20m displaced 5px is a 45px discontinuity across a
  silhouette in one pixel, and a C1 lattice cannot represent a step of any width.
- A face that moved 100px contributes a cluster of outliers; any that survive bend the nearest node by
  tens of pixels and smear that over a thousand pixels of surrounding picture. Coarseness causes that
  rather than preventing it.
- `Reach::across(3000)` gives a search half-width of about 7px against a parallax of about 30px at
  that scale.

Rotation-only, and the cost is **degradation, not error**: more disagreement along depth edges,
which a seam then has to route around.

### 3.3 What differs, per frame

Gather every frame onto the analysis canvas through its rotation and the recipe's lens, then read
each pixel's **level**: log2 of its luma light, with chroma at half weight so that what differs in
colour alone still counts (`assembly_levels.slang`). The consensus `M` is the median of the frames'
levels, stated only where every frame reached the pixel and none clipped it - gain-matching a
clipped highlight against an unclipped one would disagree at every specular.

The recipe's **per-source scalar gain is not applied here at all**: `composite_tile::taken` codes
each source against the reference's white divided by that source's gain, which is a multiplication
of its light for the cost of one divide, so a plane arrives at the analysis already matched.

**Measure pairwise disagreement, not spread.** For sorted `a <= b <= c`,
`MAD = min(b-a, c-b)` measures the agreeing pair's noise: one car in three reads zero. §3.7b
compares pick/base per cell. Median identifies an odd frame only when fewer than half disagree;
`M` only judges seams along picture steps (`assembly_seam::along_an_edge`).

The **tint**'s noise floor (§3.5) is GALOSH's model for the frame, carried into the plane's units:
the fit is stated in the mosaic's normalisation and the plane in light against PQ's ceiling, the
balance reaches a luma by `w^2` where it reached the fit averaged over the CFA, and a resized plane
averages `n / (0.94 + 0.67 ln n)` independent samples rather than `n`
(`assembly_planes::correlated_samples`, measured through the real demosaic and resize).

### 3.4 The shrunk grid

Everything after §3.3 works on the field **shrunk by four** (`assembly_seam::SHRINK`) - 750 cells on
the long edge, where a seam is a `W`-scale object and a cell is one analysis-pixel-per-side of
accuracy the solve does not need. That is the `dust.rs` precedent exactly: a shader produces the
field, a bounded one crosses back, and the host walks it.

`W`, `W_low`, `W_high`, and every other spatial constant here are **shares of the long
edge** (or of the canvas area, where they are areas), never pixel counts, because they cross from
the analysis canvas into a 9000px render.

### 3.5 The seam field

Over §3.3's planes, `assembly_levels::seam_field` leaves per shrunk cell:

- **the level**: the consensus's mean log2 light over the cell's block, then each frame's, or
  `NOT_REACHED` where there was none: §3.3's levels, averaged. This is what §3.7b's solve
  reads.
- **the tint**: each frame's colour over the block, log2 of red over green and of blue over green,
  taken of the block's mean light with the mean's own noise added to each channel so a dark cell's
  grain reads as grey. The level cannot tell a white belly from the snow behind it; this can.

The solve is 16-connected, with the Boykov-Kolmogorov weights `kappa_k = delta_phi_k / (2 |e_k|)`:
axis 0.232, diagonal 0.114, knight 0.088. Dividing by the length is what makes a cut's cost the
contour's Euclidean length (Cauchy-Crofton); multiplying instead is anisotropic - about 6% toward the
diagonal at sixteen neighbours, and at four the 41% that draws the staircase the neighbourhood was
widened to remove. This is Interactive Digital Photomontage (Agarwala et al., 2004), which is worth
naming rather than rediscovering worse.

### 3.6 Tidy

- A picked frame's cells are first **split into their 4-connected components**, each a piece of its
  own. The solve is 16-connected and pays about half as much for a diagonal arc as an axis one
  (§3.5), so a region that pinches at a diagonal is a shape it returns, and §3.7 traces one loop a
  piece: the lobe not traced would become base with nothing said. A piece with a **hole** in it
  stays out of scope - a piece is one loop, and it could not carry one; §3.7b draws an enclosed piece
  after its encloser instead.
- A piece whose loop **simplified to fewer than three vertices** is dropped at the emit. A thin
  region straightens under its own tolerance into a line, which encloses nothing, and §5.2's render
  would skip it anyway.

### 3.7 Tracing the pieces

Trace each piece's mask at the shrunk scale, upsample, and simplify with Douglas-Peucker to a
tolerance **derived from the room the seam has** (`tolerance_for`): `tolerance = corridor / 4`, and
never so much that the feather beyond it reaches past that room: **`tolerance + W_low <=
corridor`**, floored at a quarter of a shrunk pixel where a corridor narrower than its own feather
asks for less than the traced staircase's own step. A piece is traced as though its corridor were
`2 * W_MAX` (a fiftieth of the long edge) of open ground (§3.7b).

**The corridor is a clearance from the contour, not a width across it**, which is what makes the two
constraints one statement: §5.2's `W_low` is half of it, so the quarter this asks for is left
untouched and the seam has a quarter of the corridor to spare. The second bound is what answers a
caller feathering wider than §5.2 does. It must not swallow the first: a tolerance driven down to
the floor keeps a vertex per staircase step, which is what `MOST_VERTICES` exists to stop.

**Upsampling is onto block centres.** A shrunk cell covers a `SHRINK`-sided block of canvas, so a
shrunk coordinate `s` lands at `SHRINK * s + (SHRINK - 1) / 2`; the block's corner is half a block
up and left of the seam that was measured, and leaves the mask's last block partly in no tile at
all.

**Share cut-boundary vertices.** Independent simplification creates gaps/overlaps up to twice
tolerance: rejected base fills gaps, last rasterised tile wins overlaps. Shared vertices still
allow crossing arcs, such as thin fingers. Re-simplify every crossing arc at half tolerance until
none cross; zero tolerance returns the original trace, guaranteeing termination.

Bounded by **`MOST_TILES = 256`** and **`MOST_VERTICES = 8192`**. `photos.recipe` is one replicated
cell re-parsed by a SQL trigger on every write, capped only by `MAX_CELL_CHARS` of four million;
these serialise to about 200KB. The schema refuses a recipe past either by name.

### 3.7a The per-piece warp and exposure a recipe carries

A recipe's seams carry, per piece, **an affine over the canvas** (`warp`) and **a gain**
(`exposure`), and the render reads that piece's frame through both: the warp is the offset §3.7b
tracked its content by, the gain the balance §3.7b measured across its seams.

**Six parameters.** Gather maps canvas `p` through `[a b; c d] p + t`. Translation/isotropic
scale can model camera turn/breathing; anisotropic scale/shear cannot. Apply in
`composite_gather.slang` between canvas coordinate and ray, mirrored by `composition::warped_canvas`.
`the_gather_places_a_pixel_where_the_recipe_does` pins every window pixel, three projections,
both lens paths, with shear on one of three sources; identity-only recipes would miss this.

A piece's warp is carried across planes by a **conjugation** and not a scaling: under `P = S p` the
affine becomes `S A S⁻¹` and only the translation is `S t`. Scaling all six would leave a shear
describing a different shear on any canvas whose two axis ratios differ, which a real burst's do by
0.05%.

**Read through the weight mask**, which is what keeps §5.2 out of it: the mask already names the
piece that owns a pixel, so it carries that piece's warp and gain beside its slot
(`assembly_weight::warps_of`), and the gather, the weight field and the two-band blend are the ones
that were already there. A source's footprint is the union of what its pieces' warps reach, so a
moved piece decodes no more than it reads.

### 3.7b Seams for the picks

A seed is where a reader pointed, not where a seam belongs. Once its pick is known the question is
where _those_ frames agree, so the seams are solved per pick set (`assembly_seams.rs`): an
alpha-expansion over the picked frames on the shrunk grid, with the tiles as the data term and the
picked frames' own disagreement as the smoothness.

- **Data.** A cell costs nothing on the frame its tile picks where that pick changes something,
  and up to `GROW` where it changes nothing, so a picked tile gives quiet ground back to the base. On
  the base's ground - no tile, or a tile left on the base - any other frame costs `GROW` (0.001)
  however far it disagrees, so where a picked tile ends is the seam's own cost. Taking a cell off a
  pick other than the base costs `KEEP` (0.25) times how far the two frames are apart there, and
  never less than `GROW`: at a flat price, the base everywhere with no seam at all undercut every
  pick whose outline crossed a disagreement. `GROW` is not zero because a seam on quiet ground costs
  the same at any distance, and a free ring was taken whole.
- **Apart.** A difference under `NOISE` (0.5 stops) is none, and one of `SIGNIFICANT` (1.5 stops)
  is fully apart, linearly between. Without the floor, noise and sub-cell texture on plain rock read
  as disagreeing as a moved penguin, every seam cost the same, and the shortest won - across the
  penguin's neck. Colour counts as well, the larger of the two: a tint distance under `TINT_NOISE`
  (0.15 stops) is none and one of `TINT_SIGNIFICANT` (0.6) fully apart. On the penguin pair plain
  rock and snow read 0.03-0.08 apart in tint, the standing bird's legs 0.3 and its feet 0.64, where
  in light the legs sat under `NOISE` and a seed on the head left them behind.
- **Smoothness.** Between the two frames either side: their disagreement in value, at its worst over
  each cell's 3x3 so a seam keeps a cell off a mover, plus their disagreement in step, discounted by
  `along_an_edge` and charged `TIE` besides. Nearly a metric, as the expansion needs: the noise floor
  breaks the triangle inequality by up to the floor, which the expansion's construction clamps. A cut
  through a figure that stood still costs nothing, which is right: a neck that did not move is a fine
  seam. Two different figures of the same brightness and colour - two white bellies - also read as
  agreeing, and a seam may run between them.
- **Region.** Only cells within `RING` (three fortieths of the long edge) of a tile off the base take
  part, and a frame only within `RING` of the tiles picking it. Connected groups solve independently.
- **Tracked.** A person in a group shot steps a head aside between frames, and read in place the
  other frame shows a shirt where the base shows the face; no seam within reach does better than
  replacing the face with it. So each seed's pick is read where the seed's content went
  (`patch_search::tracked`): a patch around the seed, three two-hundredths of the long edge in radius and
  weighted towards its centre, compared on light less its mean and on tint against the frame at every
  whole-cell offset within a sixteenth of the long edge, the best refined to a fraction of a cell
  through a parabola. An offset is taken only where it matches at least twice as well as staying put,
  staying put does not already match, and tracking back from where it landed returns to the seed:
  a crowd is full of lookalikes, and on the penguin pair a seed on one bird's tail matched the next
  bird along, which tracks back to itself. Host arithmetic over the shrunk field, a few milliseconds
  a frame. Within the seed's ring its pick is read through that offset - a cell two seeds reach,
  through the nearer's - and a frame's cells are split into pieces by the seed they were read
  through, each answering its warp (`Seams::warp`): the offset as a translation over the canvas,
  which the render gathers the piece under and the preview draws its layer shifted by.
- **Ground.** A tile asking for the ground (§2.4a) is never tracked: it is read in place, and its
  pieces' warps are the identity. Nothing else in the solve changes, because the data term already
  earns where the pick differs from the base, and over a thing being removed that is the thing.
  Before any of it, a ground tile whose pick does not clear the seed is refused by name
  (`patch_search::clears`): the difference is walked out from the seed to where the two frames agree
  again, and the seed must read at least `CLEARED` (a tenth) changed on average. A difference grown
  past `RING` squared cells is no object leaving but a frame that changed everywhere - moved, or
  relit - and clears nothing. What this cannot tell apart is ground from something else of the same
  size standing where the thing stood: a field of light and colour has no notion of background, and
  that is the reader's to see in the swatch.
- **Seeds.** A seeded tile (§2.4) is the least its pick takes: every cell its square touches is
  held to that pick. Within `DRAWN_RING` (three tenths of the long edge), the cells joined to the
  seed through what its pick changes earn `TAKE` (a quarter) a cell times that change, and every
  other cell costs `GROW`. The change is judged in place; for a tracked seed it is also weighed by
  how well the shifted frame matches, or the subject's new place - background, read shifted - would
  earn too. Merely free, a seed on a crowd that moved everywhere kept its own square: every seam in
  reach crossed a change, and the shortest was around the seed.
- **Anchored.** A region taking a frame goes back to the base unless it reaches a cell of a tile
  picking that frame: a strip the base does not reach, or another figure in the ring, is a piece
  nobody pointed at.
- **Balanced.** A header's exposure is not what a frame came out at, so a taken piece meets the
  base a little brighter or darker all along its seam. Each frame's cells, split as the pieces are,
  get a gain (`Seams::exposure`) that brings both frames to one light over the band §5.2 blends them
  in: every cell within the recipe's `feather` of a seam, on either side, weighted by the other
  frame's share of the blend there - one at the seam, none at the feather's edge. Least squares
  over every seam at once, so two taken pieces that meet agree as well, the base held at one. Both
  frames are read at the same cell, which leaves texture out of it; a reading whose colours differ
  past `TINT_SIGNIFICANT` is not the same thing and counts for nothing, and one far off the answer
  (Cauchy's weight at a quarter stop) counts for less, so what moved across a seam is outvoted. The
  cells on the seam itself are solved first: the cut put the frames in agreement there, where a
  piece further in is mostly what its frame changes, and a band left to start from nothing can
  settle on that instead. At most two stops either way.
- **Layout and balance.** The balance hangs on the feather and nothing else the cut reads, so the
  worker holds each pick set's layout - its labels, its tracked shifts, its pieces - for the volume
  it last solved over (`composite_job::layout_for`). Letting go of the page's blend slider asks
  for every pick set again at the new feather; each is a balance over a held layout, milliseconds
  rather than a cut. While the slider moves, the preview's blend follows it and the gains stay
  those of the last feather let go.
- **Pieces.** Each picked frame's cells, split into components and traced by §3.7's `subdivide`.
  A piece is under the tile it mostly overlaps among those picking its frame (`zone`), which is the
  tile a click on it opens, and is gathered under its own warp and its balance times that tile's
  exposure (§3.7a) - under its balance alone on ground no tile covers. A seed's piece reports a
  corridor bounded only by its own depth, which the render caps at the recipe's feather (§5.2).
- **Order.** Largest first, and a pixel goes to the last piece over it, the base's own pieces
  included: a piece is an outer loop, so one enclosed by another is drawn after it. The preview's
  masks follow the same order, each layer cut back wherever a later piece of another frame covers it.

Measured on the penguin pair, one seed on a head grown over the whole bird and the nest below it:
under a fifth of a second. The seed's ring is what the solve walks, so a burst of twelve frames
opening one seed asks for eleven of those.

Cache visit answers by tile outlines, base and pick set. Opening a tile requests all frame
variants together; server solves them from one volume read, so swatches and hover seams arrive
together. Unsolved picks draw current-pick seams, else latest solved seams, never unsolved tiles.
Pieces solved for other tile sets still draw but open nothing.

Use Boykov and Kolmogorov max flow, retaining search trees across over a hundred augmentations
per seed ring. Rebuilding trees dominates solve cost. Skip a frame expansion starting from its
previous starting labelling: it would return the same answer.

The analysis leaves what this reads as a **volume** beside its layers: the cost, each frame's mean
log2 light and tint a cell in source order, and which tile owns each cell - none, the analysis having made
no tiles. The recipe names it (`seamVolume`, the layer key it was written under) and carries the
answer (`seams`, stated for the `pick` and `base` it was solved for). The server solves again on
every Save and re-edit rather than trusting the page's answer; where the volume has been
reaped it keeps seams solved for the same picks and drops any others, and the page draws the tiles
as they are.

### 3.8 What the analysis emits

The recipe's geometry (sources, rotations, the shared lens, gains, focal, canvas, projection,
centre, `radiansPerPixel`, and a crop that is the frames' intersection), with no tiles and the
reference as its base; §3.5's field as the volume; and the **layers** - each frame's plane, encoded
4:4:4 PQ (the repo's own record of 4:2:0 chroma leak on saturated HDR colour is reason enough) at the
analysis scale, about 1.7MB each.

Beside the recipe, and not part of it, `Analysed` carries §3.1's radial reading and the warnings.

### 3.9 What it costs

**The decodes dominate, and they are cheap.** `assemble` times `analyse` whole and then
re-runs its two halves over the same recipe:

| burst                    | frames | whole | the plane gather | §3.3 to §3.5 |
| ------------------------ | ------ | ----- | ---------------- | ------------ |
| `DSC09468/69`, 7008x4672 | 2      | 0.4s  | 0.3s             | under 0.05s  |

So a whole decode, GALOSH's fit, RCD, the lens gather and the resize together are about 0.15s a
frame on 33MP, and twelve frames of them is a second or two. Behind that, Lowe-ratio matching is
still pairwise, 66 descriptor matches for twelve frames. What a reader waits on after the page opens
is §3.7b's solves, one a frame a seed.

One analysis at a time behind a promise, as `CompositesService` does and for its reason: two would
hold the device against each other. Cancel drops the queued one at its next frame.

### 3.10 What a burst actually measures

The numbers the rest of this chapter rests on, measured by swapping a hand-specified rectangle
between two aligned planes; the last part of this section is `native/rawshim/examples/assemble.rs`
running `analyse` end to end. Two bursts, both at `ANALYSIS_LONG = 3000`:

- **The real one**, two hand-held frames of penguins behind glass seconds apart, `DSC09468.ARW` and
  `DSC09469.ARW`, 7008x4672 on one body at 1/125 f/2.8 ISO 320 - so **one analysis pixel is 2.34
  source pixels**. Aligned rectilinear onto a 7106x4763 canvas, focal 7942px, rms 0.97 preview px.
- **A synthetic one**, three `synth_raw` DNGs of one scene from a camera translated 17 and 11 pixels,
  with a flat dark square moved between them. **No parallax at all**, so what it measures is the
  pipeline: where the two bursts agree, the answer is the pipeline's own floor rather than the
  scene's depth.

**The rectangle's edge lands within about one analysis pixel, and what is left is not parallax.**
Over a 600x450 rectangle of static rock the picked frame sits `+0.77, -0.13` analysis pixels from
the base, and the four border bands run `-0.13` to `+1.12` across and `-0.74` to `+0.22` down. Over a
6x4 grid of the whole frame the displacement's median is 1.10 analysis pixels, its p75 1.96 and its
p90 2.23; the three cells past that are the ones a penguin walked across, where there is no
displacement to find. The synthetic burst, with no depth in it whatever, reports `-1.09, -0.43` on
every one of the four bands and a grid median of 1.06 - **the same number**, so the residual is the
rotation model's own perspective error and the solve's, not the parallax a lattice would absorb.
§3.2's lattice stays out of v1 on that evidence rather than on the argument alone.

What it costs is stated rather than dismissed: ~1 analysis pixel is ~2.3 source pixels, which is a
doubled edge a reader can see at 1:1, and §5.2's feather is what hides it.

**There is a brightness step, and the per-source gain does not touch it.** On the real burst the
picked frame is 0.045 stops darker than the base over the band just inside the rectangle and 0.048
stops darker just outside it, both on flat ground - and over a different rectangle on snow in the
middle of the frame, 0.105 and 0.085. So 3% to 7%, varying across the frame, between two frames of
one burst **shot at identical settings**. The synthetic burst's is 0.005 stops, which is the
pipeline's own contribution: nothing. Nothing has fitted that lens, so the falloff is uncorrected and
a small turn across it makes a frame-varying step by itself; the run says so, and the figure is an
upper bound for an uncorrected-lens burst rather than a reading of the camera's metering.

`composite_align::align` passes **no measured ratios** to
`composite_solve::gains(&exposures, &[], reference)`: header-only burst gains stay 1.0 despite
light changes. Require §3.7b per-piece balance and §5.2 two-band mix: a feather hiding 1-pixel
doubling cannot also hide a 7% brightness step.

#### What the whole chain needed, which is the part no argument predicted

`assemble` runs `analyse` end to end. Two things had to be repaired before either burst
reached §3.3 at all, and both were this chapter being wrong rather than the code being wrong.

**A lens that is the identity read as no lens at all.** `composite_align::shared_lenses` takes the
knot-by-knot median of a group's fits, and it took the knot _count_ through a `?`: a fit whose lens
has no distortion term has no knots, so the group came back unfitted and §3.1 refused the set by
name. A synthetic camera is exactly that case, and so is any body whose fit found nothing to
correct. `None` there now means nobody measured the lens, which is the thing the refusal is about.

**§3.1's corner check measures the bend, not the texture, and that is what makes its bound
spendable.** The statistic is the outer fifth's median inlier residual **less the whole field's**
(§3.1). Read as the _worst_ inlier in the outer fifth instead, it is a draw from the tail of the
inlier population rather than a radial pattern: on the real burst, 519 outer matches with a median of
1.04px, a p90 of 1.98px and a maximum of **4.14px**; the synthetic's are 1389 matches, median 1.27px,
maximum 4.11px. Both maxima are what the outlier round's own tolerance permits and both grow with the
number of matches, so a check read off one measures a frame's texture. The median alone does not
escape it either - 1.04px of that burst's 1.04px _is_ its whole field, which reads 0.97px - and it is
the difference that has no floor. As a difference, and with the frames both bursts actually hold:

The synthetic burst these are from is three `synth_raw` DNGs at the default 3000x2000, the second
shifted `17,11` and the third `-11,17`, each carrying a 240-pixel square at `1200,900`, `1500,900`
and `1350,1150` - stated so that every figure in this section can be produced again.

|                                                                                                                | real, 2 frames               | synthetic, 3 frames          |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| §3.1's radial check, on the 1616px plane it was measured on: 0.72 and 0.45 analysis px against a bound of 1.15 | **0.385px**                  | **0.241px**                  |
| the focal it was checked against                                                                               | the file's, on `Leash::Told` | assumed, on `Leash::Assumed` |

**A seed on the real burst grows to its bird.** `assemble --pick 0 --draw 800,730,820,750`
seeds a 20-pixel square on the head of the standing penguin and solves it: the piece takes the
head, the back and the nest below, and its seam runs out over rock and snow around them.

## 4. The preview

### 4.1 Two previews, both HDR, and neither a second render

**The canvas is the stage's own render pipeline, once per source, with a mask.**
`paintExtended` already draws a `VideoFrame` through `stage.slang` onto an `rgba16float` canvas -
the one path a browser has to an HDR picture, since `createImageBitmap` tone-maps to SDR white
before any canvas sees it. This page draws the base layer that way, then each picked source's
layer over it with an **alpha mask** sampled in the fragment: the solved pieces rasterised to an
8-bit mask on an offscreen 2D canvas, which is fine for a mask where it would not be for a picture,
and each layer read through its pieces' shift and gain. The pictures never leave the
extended-range path. A hover substitutes the swatch's frame for the open tile's pick in the same
drawing, so it is instant and local, and a click keeps it.

**The settled picture is the render itself**, asked for once the drawing has stood still for
`SETTLES_AFTER_MS` (400ms) and drawn in place of the mask when it arrives. `POST
/api/assemblies/preview` answers where it is, `previewOf` builds it under the layer key and a hash
of what it draws - the picks, the base, the feather and the seams - so a reader stepping back to a
pick they have seen is handed the file, and the seven-day reap that takes the layers takes these
too. Measured on a hand-held pair at 3840: about 0.3s of lowpass and 0.5s of blend, which is why
the mask is what a hover and a click show and this is what follows them.

**No browser composite through wasm:** editor builds link no C/AVIF decoder, requiring ~36MB raw
samples per layer. A page-side render would duplicate DESIGN 21.1's pipeline failure. Masked
drawing only blurs masks, without bands or weights; the real render replaces it half a second later.

### 4.2 What each preview is

The masked draw feathers each layer's mask over twice its `W` - half the narrowest corridor among
its pieces, capped at the recipe's feather, and never under `FEATHER_FLOOR_PX` - and draws it under
its pieces' gain, but in one band: where the render crosses only the lowpass over that width, the
mask cross-fades the whole picture, and is not pinned to anything. The settled picture is the render
at the layers' size through the same code a rendition takes, so a reader who wants to know what Save
produces has already seen it. Both are ungraded (§3.0), as the swatches are, so the saved photograph
is where the grade shows.

### 4.3 Layers

The analysis planes of §3.8, decoded on the page through `ImageDecoder` to `VideoFrame`s, as every
HDR rendition is. Rebuildable from the recipe alone (§2.7).

### 4.4 Where the draft lives

**Two keys, named apart.** The **session key** is the analysis job's id, or the photograph's for a
finished one (§2.7); it names the session and the route. The **layer key** (`layerKeyOf`) covers
what the layers' pixels are a function of - the library's rendition setting and the geometry every
layer is drawn in - and names the layer files. A frame's _edit_ does not enter it, because §3.0's
planes take no grade.

**Save posts the full recipe**, kilobytes of geometry, loops, picks and base. Cache eviction
loses no work, reload needs no hit, and each tab posts its own recipe.

The analysis output and the picks live in `sessionStorage`, on `triage_storage.ts`'s pattern -
prefixed key, validating parse, malformed state discarded - **with a quota failure surfaced**,
which that module swallows and this must not, because here it is the reader's work.

The layers are server-side under **`drafts/<layerKey>/`**, beside §3.7b's `seams.bin` and §4.1's
rendered previews, which is a directory of its own because
`PruneService` sweeps `renditions/` and `hdr/` for names that are not a live photo id and a layer
key is never one. They are reaped through `src/utils/deletions.ts`, the one place that deletes,
when **older than seven days** - a TTL, since a draft has no row to be live by.

Save re-checks that every source still exists and is not binned, and fails by name. Re-entering an
unfinished merge is its job's route; re-entering a finished one is §2.7 and needs no job.

## 5. Rendering

### 5.1 The recipe, and the two predicates that must not name it

A new arm of `RecipeSchema`, `kind: 'assembly'`: the panorama's geometry, plus `vertices`, `tiles`,
`pick`, `base`, and `feather`, the most §5.2's `W` may be as a share of the long edge.

`vertices` are the recipe's **own canvas pixels**, so everything that rasterises them - the render,
the page's SVG, the swatch's clip - needs no scale of its own.

Optional beside them, `seams` and `seamVolume` (§3.7b). The seams are pieces, each with its own
`source`, the `zone` (tile) it grew from, its `corridor` - the room its seam has as a **share of
the long edge**, which is what §5.2 sizes `W(x)` from - and the `warp` and `exposure` of §3.7a. A
render with `seams` draws the pieces as its tiles, and refuses seams stated for other picks than
the recipe's; without them the tiles are the pieces, under the identity and one.

**Two places key on the literal `'panorama'`, and they need opposite answers.**

- `apply.ts`'s `composed()` is `isComposite(recipeOf(...))`, which on a peer running an older build
  reads an `assembly` as `unreadable`, so `isComposite` is false, so `insert()` writes
  `is_missing = 1` - and nothing in `src/services/replication` ever clears it. **Here the predicate
  becomes "not a `file`"**: what is true of every row that is not a file is that it has no bytes of
  its own to be missing, as true of a kind this build has never heard of as of one it has.
- `photoInputTriggers` gates the `photo_sources` insert on the kind. **This stays an allowlist**,
  gaining `'assembly'` and nothing else. `triggers.ts` says why: a recipe arrives from a peer
  byte-verbatim, so a crafted row with a `sources` array bolted on would index edges naming any
  photograph, and `NOT_A_FRAME` hides a photograph any live row claims as a frame - "a paired peer
  emptying someone's grid one crafted row at a time". Widening it hands that to every kind this build
  cannot read. A test carries the cost: **every kind in `RecipeSchema`'s union except `file` must
  appear in the trigger's allowlist.**

  Because the trigger is registered `CREATE TRIGGER IF NOT EXISTS` and re-run after migrations, an
  existing library keeps the old body: a drizzle `.sql` migration drops `photos_index_inputs_ins` and
  `photos_index_inputs_upd` by name, and without one the failure is silent.

`sourcesOf` is typed over `StoredRecipe`, whose `unreadable` arm has no `sources`; it excludes both
`file` and `unreadable`. `insertComposite` and `framingEdits` widen off `Composition`; about
twenty-five kind-switching lines across a dozen files take the arm, and `photo_grid.tsx`'s
`panoramaName` and its icon get an assembly counterpart.

### 5.2 The weight, and the bands

**Weights are per source, not per tile.** `composite_add` takes one layer and one weight buffer a
dispatch, so a source needs the signed distance to the boundary of the **union** of the tiles that
picked it - one jump flood per source, sign flipped inside. Normalising per tile and summing
double-counts every seam between same-pick neighbours; the union removes those seams entirely.

The flood is over the window, in the render's own pixels, which the polygons are divided into so
that one coordinate system holds them both. A seam outside the window and within `W(x)` of it is
never seeded, so a pixel that far from every seam saturates - harmlessly, the sign still being right
and `smoothstep` being 1 by then, and a render's windows being full-width strips.

```
weight_s(x) = smoothstep(-W(x), W(x), signed distance to the union s owns)
```

- **`W` is a field, not a constant, and the same on both sides of every seam.** Two unions meeting
  have distances that are exact negatives, and `smoothstep` is symmetric, so the pair sums to one
  and the seam sits at 0.5/0.5 - only if `W` agrees. So `W(x)` is the minimum over nearby seams of
  half the corridor each measured - §3.7's clearance from the contour - read off the same distance
  transform, capped by the recipe's **`feather`** share of the long edge (`FEATHER = 0.0025` where it
  names none, and the reader's slider on the page otherwise, up to `0.015`) and **by the owning tile's own maximum
  interior distance**, so a thin tile still reaches full weight rather than the reader's pick being
  applied at sixty percent: at the tile's deepest point the signed distance _is_ that inradius, and
  `smoothstep(-W, W, inradius)` is 1 only where `W <= inradius`. Floored at `W_high`, which a render
  small enough for the feather to fall under the high band reaches - anti-aliasing a staircase still has
  to happen. The cap is folded in at the emit, `Assembly::corridor[t]` being
  `min(corridor, 2 * inradius)` over the shrunk long edge, because that is where the cell masks are.
- Where three unions meet the sum is 1.5 and the normalisation `composite_blend` already does restores
  it. That is a third each over a disc of radius `W` in ground where by construction every frame
  agrees, so it is invisible; `composite_gather`'s `FEATHER_POWER = 16` exists because a panorama's
  overlap is a third of a frame with parallax in it, which this is not.

**Two bands, split in log2 light**, over `assembly_blend.slang` - `composite_blend` accumulates one
weighted light and resolves once, and cannot carry two accumulators in another space, so the
coverage average stays there and the band mix is its own kernel:

```
out = mix( lowpass(layer),          W_low  )
    + mix( layer - lowpass(layer),  W_high )
```

- **In log2 light, because an exposure difference is a ratio.** There it is a constant offset the
  low band removes uniformly. In light the residual grows with luminance, invisible in shadow and
  large in highlight; in PQ a gain is a multiply in `(Y/10000)^m1`, not an offset either. The high
  band in a linear space is signal-proportional too, which is a dark halo on the bright side of a
  luminance step.
- **The split is a share of the canvas**, `LAMBDA_SPLIT = 1/64` of the long edge, so a render at any size
  splits at the same place in the picture. `W_high` is **two render pixels** - its job is
  anti-aliasing the seam's staircase, a pixel-scale thing - and `W_low = W(x)`, so
  `W_high << lambda << W_low` holds wherever a corridor is wide enough; where `W(x)` falls below the
  split wavelength the tile takes the high band alone.
- **The lowpass is built over the whole crop once**, a coarse decode a source area-averaged onto a
  grid of the split's own wavelength, and every window samples it. A truncated halo per window gives
  a different truncation each side of a window boundary, which is a visible _window_ seam unrelated
  to any image seam. The crop rather than the canvas, because a box mean reaching past the frames'
  intersection averages in the black outside one source's own frame; an area average rather than the
  5-tap binomial, because a box's sidelobes are identical on both sides of every seam and cancel out
  of `layer - lowpass` exactly. The same decode measures the white every window is coded against, a
  strip left to measure its own being a band across the finished picture.
- **The artifact this leaves** is on wavelengths longer than `2 * W_low`: an illumination difference
  over a quarter of the frame shows as a ramp of width `2 * W_low` along the seam. §3.7b's
  per-piece balance removes what is constant across a piece; the band split is for what varies
  within it.

The panorama's own `feather` is untouched. An absent `pick` means the existing path, and a
**`gpu_fixture` case for a panorama window is added and pinned before this lands**, because nothing
pins a panorama's pixels today and "bit-identical" is otherwise a claim.

### 5.3 What Save builds

`insertComposite` with the assembly recipe, the framing to the row's edits, `owedOf` for what the
library owes, each rendition on the merge's own worker, `markBuilt`, and the `unqueue` of the
unbuilt `full` - the sequence `CompositesService.build` runs, through a `Job.assembly` beside
`Job.panorama` in the one `bb_run_job` symbol. Progress is an `assembly` SSE event beside
`panorama`'s.

**On a library serving the cameras' pictures, what Save owes is the tile, and the picture is
composited at the first open.** `owedOf` answers `grid` alone there for either composite kind, so
the merge is over in seconds and a burst nobody opens costs nothing; the canvas's `embedded`
rendition - its frames' JPEGs composited into one, filed like any other copy - is built when a
reader opens it, through `PhotoDetail.rendition_to_build` and `POST
/api/photos/:id/renditions/embedded`. That copy is framed to `full_rendition_size` like the viewer
copy beside it, not to the canvas's own native resolution: `target()`'s `wide` branch is about a
panorama's several-frame canvas and an assembly's is one frame across.

A canvas is the one row that has to _ask_ for its camera view, because it is the one row that has
no file to lift one out of - which is why `resolveRenditionToBuild` names `embedded` for a
composite and for nothing else.

### 5.4 A failed merge leaves nothing behind

`CompositesService.mergeNow` inserts between align and rendition; picture-phase failure leaves
an empty photograph. Fix that shared failure path for both merge kinds.

**Keep insert-first:** `photo_edits.photo_id` and `renditions.photo_id` reference `photos.id`
under `PRAGMA foreign_keys = ON`; `build()` needs the framing stamp before renditions to avoid
immediate rebuild debt. In `catch`, **delete row, edits, rendition rows and files** through
`deletions.ts`, then report `failed`. Land separately first, testing with **foreign keys on**:
`:memory:` disables them, letting an insert-last draft pass tests but fail production.

## 6. Testing

**`test:native`:**

- A seed grows as far as its ring to take a whole figure and no further; a picked tile gives the
  ground it changes nothing on back to the base; a seam through a moving figure moves onto the
  ground beside it.
- A noiseless synthetic does not divide by zero; a cell clipped in any frame has no consensus; the
  tint tells a colour from a grey of the same light.
- The analysis hands back no tiles and the field they are seeded on, naming frames by their own
  index.
- A loop that straightened into a line is dropped.
- The subdivision is watertight - every cut edge is shared - and every loop is simple.
- An absent `pick` renders a panorama window to its new pin.
- The bands remove a known exposure _ratio_ without doubling detail, and the seam reads the two
  frames' _geometric_ mean, each asserted against the single-feather alternative rather than a bare
  constant. **Not a halo across a luminance step**: with a gain between two frames the detail is
  proportional and the ratio cancels out of `l - low` exactly, so light and log2 draw the same
  picture and no mutation can make such a test fail.
- A tile takes the frame it picked and the ground outside every tile takes the base; a thin tile
  reaches full weight in its middle; a source no tile picked is never decoded; a canvas taken in
  strips is the canvas taken whole.
- The analysis plane is `composite_tile`'s `From::Original` preparation, pinned against a fixture.
- `wgsl_layout.rs` gains a case for each new uniform block.
- `gpu_fixture`: a panorama window, then an assembly of three synthetic frames with fixed picks.

**`bun test`:**

- `merge_presenter_*.test.ts`: a pick tells the compositor that tile and source; a hover previews
  without committing; a click seeds a tile last in the stack and opens it, solving every frame; a
  seed closed with nothing picked is dropped; only solved pieces are drawn; an undo across a seed
  fits today's tiles; discard clears the session; a reload restores the seeds; a quota failure is
  surfaced.
- The recipe schema round-trips, enforces both bounds, and refuses a tile naming no vertex.
- An unknown composite kind from a peer is not marked missing, and indexes no sources.
- Every composite kind in the union is in the trigger allowlist.
- A library at the old schema takes the new trigger body through the migration - tested against the
  migration, not through `runMigrations`, which re-applies triggers regardless.
- A replication test mirroring `replication/tests/panorama.test.ts`.
- A finished assembly reopens off its recipe alone and updates in place on Save; opens read-only
  when a source has gone.
- The four refusals, on the page and in the service.
- **A panorama merge failed in the picture phase leaves no row and no files, under foreign keys on.**

**Playwright**, one spec in `web/e2e/merge/`, its own library root, a burst made with
`examples/synth_raw.rs`: the page opens, a click on the picture seeds a tile and opens its popup, a
pick grows a piece that opens it again, Save produces a photograph that survives a reload.

**Final checks:** `bun run converge 3000`; `bun run build:wasm`, because `composite_tile` and the solve
compile for wasm32 and no host runner compiles them for that target; `--features fixtures --lib`,
because §5.2 changes `composite_gather` and the tile-against-rendition agreement tests live in the lib.

**Not `test:bench`.** `bench.budget.json` is the fourteen single-photo chain stages per RAW fixture;
no composite render is benched, the panorama's included. The assembly render is outside the
ratchet, and saying so beats claiming a line it cannot have.

## 7. Design chapters

Edited in the commit that lands the code: `catalogue.md` §4.2.1 (which today says there are two
kinds), `processing.md` §10.1 (what a composite owes), and a screen in `web.md`.

## 8. What is deliberately not here

- **The offset lattice.** §3.2, with the two numbers that say when.
- **Auto-picking a best frame.** §2.5.
- **Seam descriptors.** §3.3 measures each frame against the consensus, so the `N^2` comparison they
  avoid never happens.
- **A full tessellation of the canvas.** §2.2.
- **A bench budget line.** §6.
- **More than twelve frames.** §2.1, for §3.9's reason.
- **A browser composite through wasm.** §4.1.
- **The grade, the denoise, the sharpen and the colour fit, in the analysis.** §3.0.
- **A measured per-_source_ exposure gain.** `composite_solve::gains` can compute one from pairwise
  overlap ratios; its one caller passes none, so a burst's per-source gain is always the header
  arithmetic. What an assembly needs is measured **per piece** rather than per source (§3.7a),
  because what a swapped patch has to match is the ground it lands in and that is a different
  number in different parts of the canvas. A pairwise source ratio remains a real feature for a
  genuinely bracketed panorama, which is not this.
- **A sentinel for dark-subject coverage.** §3.3's `level_at` infers "unreached" from a luma floor
  (`UNCOVERED_UNDER`), which cannot tell a genuinely dark subject from a pixel no source reached;
  a dark subject reads as ground no frame reached. The fix
  is a coverage flag the gather writes explicitly rather than a luma test - the same shape
  `composite_gather.slang`'s own `NOT_REACHED` sentinel already takes for the render - and it needs a
  real dark-content burst to measure against, which is its own piece of work.
