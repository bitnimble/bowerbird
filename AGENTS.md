# Bowerbird

## The design spec is DESIGN.md plus the chapters in docs/design/

`DESIGN.md` is the base every reader needs - the overview, the stack, the tree - and the index
to the chapters in `docs/design/`, which are numbered with it as one document. `DESIGN §10.7`
anywhere in this repo is §10.7 of whichever chapter the index puts §10 in; open that chapter, not
all of them.

## Vulkan is required. Full stop.

**There is no non-Vulkan host.** Every stage that produces a picture is a shader - the
conditioning, GALOSH, the dust removal, RCD, the coding, the defringe, the lens gather, the
grade - and the editor runs those same shaders in a browser through WebGPU. A second
implementation in Rust is the one thing this pipeline is built to not have (DESIGN 21.1 records
what it cost twice), so a CPU arm is not a fallback, it is a second answer waiting to drift from
the first.

So: **never add a CPU path for a stage that has a shader**, and never soften a refusal into one.
A host with no adapter fails, loudly, naming what it needs. Do not write `if let Some(gpu)` with
an `else` that computes the same thing differently.

The rule reaches past the arms that shadow a shader, to **any host loop that walks a picture's
pixels**: a resampler, a histogram walk, a grid the stacking descriptor is ranked from, an
illuminant search. Those had no shader because nobody had written one, not because they wanted a
host - and a stage measured on one machine has to measure the same on the next.

This is not a hardware requirement. `gpu::device` asks for a software adapter where there is no
hardware one, so a machine with no GPU runs on a CPU Vulkan driver - slowly, and correctly. What is
refused is a host with no Vulkan at all, which is an install rather than a class of machine.

**The CPU driver is SwiftShader, not lavapipe.** Mesa's lavapipe binds at most 128MiB of storage
buffer, the least Vulkan allows, and a 24MP frame is 144MB, so it cannot open a real photograph.
SwiftShader binds 1GiB. `gpu::device` falls back to SwiftShader and never to lavapipe, and only
where no hardware adapter answers. `bun run get:swiftshader` downloads the pinned one - 4MB, from
Android's emulator prebuilts, checked against a hash, because SwiftShader publishes no binaries and
every other Google build wraps it in a product - `bun run test:native --swiftshader ...` runs a
suite on it and nothing else, and any other process reaches it through
`VK_ADD_DRIVER_FILES=native/rawshim/.swiftshader/vk_swiftshader_icd.json`. The Docker image fetches
and installs it, and deletes lavapipe's manifest.

CPU code is still right where it is *the only* implementation - the solvers the fits are built on
(`fit.rs`, `hdr_fit.rs`, `tca.rs`: least squares, golden section), the tables the host fills for a
shader to read, and the flood fill the dust search grows its blobs with (`dust.rs`, everything
either side of it being `slang/dust_find.slang`). The rule is about arithmetic over pixels, not
about arithmetic.

**Those solvers are on the host because they are small, not because they are f64.** Measured: the
camera match's 150k-pair 3x3 weighted least squares moves by 0.0001 codes of 255 when both its
accumulation and its solve are done in f32, the lattice's 7x7 Catmull-Rom normal matrix is
conditioned at ~2.6 and moves by 1e-7 on nodes of order 1, and the falloff's 2x2 - whose `r^2`,
`r^4` basis makes its determinant a seventeenth of its own terms, the worst conditioning here -
moves the corner gain by 0.0002 codes. What is actually large is the *accumulation* over pairs, and
that already runs on the device; a 3x3 solve dispatched would be all round trip and no work. So
f64 here is harmless and cheap, but it is not load-bearing, and no argument for keeping a stage on
the CPU may rest on it. The one precision claim that **is** measured is the coding table's:
evaluating ST 2084 in the shader instead of reading what `tone::pq` tabulated put a fifth of a real
frame one count out (`base.rs`, `the_coding_is_st_2084_exactly`).

## HDR is what a photograph is here

`rendition_hdr` defaults to 1, so a library built with nothing configured serves `full` and `max`
HDR, and the viewer and the editor show them that way. SDR is what someone opts into. The grid tile
is the one exception, deliberately, and `renditions.ts` says why.

So HDR is the first instinct, not the second pass: reproduce a picture bug against an HDR rendition
before anything else, and design a new stage against HDR and check SDR after. The other order is
how a feature ships correct in eight bits and wrong in the range the default actually uses - and
that is the failure that reaches a user, since almost nobody is on the SDR path.

## A distance is a `Px` and a light is a `Light`. Both hosts. No exceptions.

**`px.rs`/`px.slang` and `light.rs`/`light.slang` are not a style. They are the two type systems
this pipeline's worst bugs are made of, and using them is unconditional.**

Both have already been paid for, in bugs that shipped:

- A colour footprint written as four pixels covered **two and a half times** as much of a rendition
  as of the same photograph at 1:1, because the frame a grade writes has pixels as large as the
  rendition is small.
- The render harness that graded sRGB at the HDR peak wrote five stops of highlight into eight bits
  and came out flat; a pyramid averaged PQ **codes** and so averaged a curve rather than a light.
- `§3.1`'s corner check compared a reading in the align's search-plane pixels against a bound in the
  analysis plane's. The same `0.6` meant 1.12 of one and 2.25 of the other, so a burst nobody should
  assemble passed the check that exists to refuse it.

So, in Rust and in Slang alike:

- **A number that is a distance gets a space.** `Span`/`Extent` in the space it is a distance on. If
  the space's pixels are one fixed size it is `Absolute` and takes a constant; if its size is a
  caller's choice - an output, a render, the align's search plane - it is **not**, there is no
  constant for it, and a distance there is a `Share` of the long edge until a frame resolves it.
- **A number that is a light gets a domain**, and a *ratio* of two lights gets `Stops` or `Gain`,
  which belong to no domain because they left with the units. Decode before you weigh: a weighted
  sum of coded values is a number no photograph has.
- **Two planes meet through a `Share`, never through whichever ratio is in scope.** That is the
  whole of the third bug above, and it is the one that keeps recurring.
- **A shared constant is written down once.** `prelude::LUMA` and `LUMA709` are the luma weights;
  a fourth copy inline is how the wrong one reaches a grade.

**The trap to know about, because it is how this gets skipped without anyone noticing.** Both
modules are opt-in: nothing fails to compile when a new subsystem simply never imports them. The
whole `assembly_*` family - ten Rust modules and eight shaders - was written without one typed value
in it, and no build ever complained, because every function at its edges took `(usize, usize)` and
`f32` too. **So the check is not "did it compile", it is "did I name the space and the domain".** A
new file with no `px`/`light` import is the thing to look at twice, not the thing that is fine.

`px.slang`'s header carries a five-way classification of every spatial constant - a share of the
picture, absolute on the mosaic, scale-exact on a fixed working plane, a pixel of whatever is drawn
on purpose, or a unit that is not pixels at all. **A new constant belongs in a row there before it belongs in a shader.** The same goes for a
light: name its domain at the declaration, and if the honest answer is "a ratio", say `Stops`.

## The shaders are Slang

`slang/` is the source; the WGSL every host compiles is a build artefact. `native/rawshim/build.rs`
runs `slangc` over every `.slang` that is not a `module` and writes the result to
`$OUT_DIR/wgsl/<name>.wgsl`, which is where every `include_str!` and every test that reads a shader
at runtime looks. Nothing generated is committed, and there is no `wgsl/` directory to edit.

**The browser's viewer stage is compiled a second time, and not by cargo.** `$OUT_DIR` is cargo's
and Vite has no path into it, and the web app is built on machines that never run cargo - so
`scripts/build-web-shaders.ts` runs the same pinned compiler over the shaders the browser draws
with, into `web/src/features/photos/generated/`, which the app imports with `?raw`. A Vite plugin
calls it from `buildStart`, so `dev` and `build` both get it and neither can be the one that
forgets. That directory is gitignored like every other emitted WGSL.

`bun run get:slangc` fetches the pinned compiler into `native/rawshim/.slangc`; `BOWERBIRD_SLANGC`
points the build at another one. A build with neither fails naming both, rather than quietly
leaving a stage out.

## The codecs are pinned too, through vcpkg, and linked statically

`bun run get:codecs` builds libavif and libjxl, and aom, dav1d, sharpyuv, highway, brotli and
lcms2 under them, into `native/rawshim/.codecs`, and a build without it fails naming the command.
It is vcpkg at one commit, which fixes every library's version on every machine that builds this
application, so the aom that encodes a rendition is the same wherever the app was built (DESIGN
§23.7). Same reasoning as the compiler above, and one extra: **the distributions' libavif cannot
read a gain map at all.** The API arrived in 1.1 behind a compile flag and settled in 1.2, where
Ubuntu 24.04 ships 1.0.4 and Debian trixie 1.1.1 with the flag off - so an HDR AVIF would open at
its standard range on one machine and its full range on another. libjxl's ship 0.7, which predates
its encoder API settling in 0.10.

Everything links **statically**, so `librawshim` asks a reader's machine for nothing but its C and
C++ runtimes. `native/rawshim/vcpkg/` is the manifest and the two things vcpkg's defaults get
wrong for us: an overlay libavif built against sharpyuv rather than libyuv, and triplets that skip
the debug builds and pin macOS's deployment target. **Moving the vcpkg commit moves the encoder**,
so it re-records the `encode` rows of `bench.budget.json` (`BOWERBIRD_WRITE_BUDGET=1`) in the same
commit; no committed fixture holds an AVIF, the snapshots all being PNG.

On Linux and macOS vcpkg wants a compiler, git, pkg-config, python3, zip and unzip installed, and
nasm on x86, and the getter names whichever is missing before it starts. It fetches its own cmake
and ninja, and on Windows everything.

**All three getters replace a tree made from an older recipe.** Each records what it was made from
(`scripts/pinned.ts`) - the vcpkg commit and every file under `native/rawshim/vcpkg/` for the
codecs, the asset name for the compiler, the file hashes for the driver - and reuses what is there
only when that still matches, so bumping a version or adding a flag rebuilds rather than leaving
the old tree where the build will find it. That is not hypothetical: a libavif built without
sharpyuv compiles the stub, which answers `NOT_IMPLEMENTED` to every 4:2:0 encode, which is every
grid tile in a library. `get:codecs` refuses that tree by name as well.

**None of the three trees is in the checkout.** Each lives under `~/.cache/bowerbird/<name>/`, in a
directory named for its recipe, and `native/rawshim/.<name>` is a symlink into it - so the
worktrees on a machine share one build of the codecs, and two of them on different pins coexist
instead of taking turns deleting each other's. A worktree still runs the getter, which is then a
symlink rather than a compile. `XDG_CACHE_HOME` moves the cache; `BOWERBIRD_SLANGC` still points a
build at a compiler of its own.

Two things about the emitted WGSL a reader will meet:

- **A `static const` is folded into its use sites**, so the declaration is not in the output. Every
  test that pins a shader constant against the host reads the `.slang`.
- **Names are mangled** - a uniform block becomes `Params_std140_0`, a specialisation constant
  `FROM_FRAME_0`. `wgsl_layout.rs` matches a block by prefix, and the draw keys its constant by the
  id `[vk::constant_id(0)]` fixes rather than by name.

## Running the suites

The e2e suite takes about nine minutes, `test:bench` about five with a release build under it,
and the tests that decode real RAWs (`--features fixtures`) about a minute; `test:native`, `test`,
`typecheck` and `lint` take seconds. A whole e2e run far past nine minutes is broken, not slow:
every test waiting out its timeout on a page that never loads looks exactly like a long run. Start a long run in the background and then **do something
else or wait for the completion notification**.

**`test:native` will not run without being told what to run.** It takes a name filter, or a
`--test <file>`, or `--lib`; with nothing it prints how to narrow it and exits 2. The tests that
decode a real RAW are not even compiled without `--features fixtures`.

**It is also `native/rawshim` only.** Two crates beside it carry their own tests, and each takes a
second: the supervisor, `bun run scripts/cargo.ts test --manifest-path native/launcher/Cargo.toml`,
and the lens database, the same with `native/lensdb/Cargo.toml`. `lensdb`'s suite is what holds its
scored search to the answers the C library gives (DESIGN §10.8), so a change to that crate is
covered by nothing `test:native` runs.

**Run e2e once, at the end.** It is the final check before handing work back, not a step between
edits: nine minutes an iteration is most of an afternoon spent watching a browser start. The fast
suites - `bun run test:native <name>`, `bun run test`, `bun run --cwd web test`, `bun run typecheck`,
`bun run lint` - answer
almost everything and answer it in seconds, so iterate against those and let e2e confirm the
finished thing. The exception is a change *to* an e2e spec or to the machinery it drives, where
the suite is the only thing that can say whether the change works; even then, run the one spec
(`bun run --cwd web test:e2e -- <name>`) rather than all of them.

**Anything touching replication runs 3000 convergence seeds before it is handed back.**

```
bun run converge 3000
```

That runs the suite a few hundred seeds at a time, in a process each, because libSQL never frees a
prepared statement and one process therefore cannot reach 3000 (`scripts/converge.ts` says what it
costs). `BOWERBIRD_CONVERGE_SEEDS=40 bun run test <path>` is still the inner loop.

The default of 40 is for the inner loop and is not evidence of anything. This is measured, not
cautious: a change to the collapse stamp that read as obviously correct, and that 40 seeds and
1000 seeds both passed, diverged at 2 seeds in 1500 - a stack alive on one peer and buried on
another (docs/replication.md §5.4). Convergence failures are rare interleavings by nature, so a
small green run says only that the common orders work.

Treat it like e2e: minutes, once, at the end, alongside the other final checks. Same rule about
scope - a change nowhere near `src/services/replication` does not need it.

**A stage over budget is a failing test.** `bun run test:bench` runs `scripts/bench.ts` inside the
runner, and it fails the way an assertion fails: a render is a thing this repo promises about, and
a promise nobody fails on is a promise nobody keeps. Run it with the other final checks after a
change that could move what a render costs - a shader, a kernel, the fit, the decode, a stage
added to the chain.

It judges only what it can. A different adapter, or a machine busy enough that every stage moves
together, reports the table and passes, because a millisecond does not carry across either. So a
red run on the machine the budget names is real, and the two answers to one are: make it faster,
or decide the cost is worth what it bought and re-record the budget in the same commit
(`BOWERBIRD_WRITE_BUDGET=1 bun run bench`, on an idle machine). What is not an answer is leaving
it red - the ratchet stops meaning anything the moment a failure is something to step over.

**Run what the change could have moved, and nothing else.** The set to cover is what has changed
since the last green run, not everything touched this session, and the suites do not overlap:
Rust is `test:native`, `src` is `bun run test` and `web/src` is `bun run --cwd web test`, both with
`typecheck` and `lint`, and a
markdown file is none of them. A doc edit cannot move a Rust assertion, so running the native
suite after one is a minute spent proving something that was already known - and the habit is
worse than the minute, because a check that is run reflexively stops being read. If you only edit
comments, documentation, or other non-functional or non-code files, you do not need to run any
tests, checks, compile checks, etc. 

**Scope to the test, not the suite, when the change is specific.** Both runners take a filter -
`bun run test:native <name>` and `bun test <path>` - so a change to one kernel is answered by the
test that pins that kernel, in seconds. Widen only as far as the change reaches.

**The whole set is for a sweeping change**, and those are recognisable: a shared type, a shader
both hosts read, a constant crossing the FFI, a rename through several modules, or a rebase.
There the point is precisely that you cannot predict what moved, which is the one case where
running everything is reasoning rather than habit - and it is still named: `bun run test:native
--lib`, plus a `--test <file>` for each integration test the change reaches.

**A sweeping change needs `bun run build:wasm` too, and no cargo suite is a substitute.** `wasm.rs`
is `#[cfg(target_arch = "wasm32")]`, so nothing built for this machine compiles a line of it -
including `--all-targets`, whose "targets" are the lib, the bins, the tests, the benches and the
examples, all of them for the host triple. It is the browser that runs the editor, so a field added
to a type `wasm.rs` constructs - `gpu::Grade`, `tone::Levels`, `PreparedHeader` - passes every
runner above and fails the arm a reader actually uses.

**Never poll a background job's output file.** Re-reading it in a loop tells you nothing the
notification would not, and the output is piped through `tail` in any case, so the file stays
empty until the run ends - every read of it returns the same nothing. If there is genuinely
nothing to do until a run finishes, wait for it rather than checking on it.

**Reach cargo through `scripts/cargo.ts`.** It runs cargo and then drops the artefacts that run
superseded, which cargo itself never does - `target/` reached 2.5GB in a day of rebuilding before
this existed. Bare `cargo` still works and still leaves the litter behind.

## Which suite a test belongs in

Six runners, and the rule is what a claim *needs*, not which layer it happens to live in.

| Runner | Command | For |
|---|---|---|
| `cargo test` | `bun run test:native <name>` | The native pipeline: decode, fit, warp, the grade, and the WGSL held against it |
| `bun test` (root) | `bun run test` | The server and the schemas (`src`, `scripts`) |
| `bun test` (web) | `bun run --cwd web test` | Everything in `web/src` that is not a browser |
| `bun test` + jsdom | the web one, via `registerDom()` | React components: what a control does when it is used |
| `bun test` + the budget | `bun run test:bench` | What a render costs, stage by stage, against `test/fixtures/bench.budget.json` |
| Playwright | `bun run --cwd web test:e2e` | Only what a real browser or a real GPU can answer |

### A test finds what a user can perceive

Every suite locates elements and asserts state through what a user perceives: role and
accessible name, text, label, aria state (`aria-selected`, `aria-pressed`, `aria-current`,
`aria-busy`, `aria-expanded`), or computed style (`toHaveCSS`). **No `data-testid`, and no
selector on a styling class** - StyleX's classes are hashed atoms shared across unrelated
elements, so there is nothing stable to select on anyway. An element a test cannot find is an
element missing its semantics: give it the correct role and name, which fixes accessibility and
the test at once.

The one exception is `raw-edit-diagnostics`, a hidden element in `raw_edit_stage.tsx` carrying
what no user sees - the GPU adapter, the prepared and canvas sizes, whether the camera match ran -
read by e2e through `editDiagnostics` in `web/e2e/helpers.ts`. A new hook needs the same reason.

A Playwright `has:` filter resolves its inner locator relative to the outer one, so a helper that
starts from the page's own region (`photoStage(page).getByRole(...)`) inside `has:` looks for a
region inside the region and never matches. Build the inner one from `page.getByRole(...)`.

### An edit producing a picture is not an end-to-end question

**Do not write a Playwright test that moves a control and waits for the canvas to change.** Call
the presenter method the control is wired to, and assert the result:

```ts
presenter.settleExposure(1.25);
expect(decoder.exposure).toBeCloseTo(1.25);
```

The reason this works is the split: the module owns every rule about the picture, and what the
page decides is what to tell it - a region, an exposure, an `Adjust`, a `Geometry`. Every mutation
is on a presenter (see the architecture rules), so "does this slider change the picture" is
answerable in milliseconds, against the value the module would actually be handed.

A canvas comparison is also a *worse* test. It says something changed; it cannot say the value
was right, which is the failure that actually happens - a slider wired to its neighbour, a scale
applied twice, a pair transposed. `raw_edit_presenter.test.ts` is the pattern: a store, a
recording decoder, and assertions on what it was told.

### What stays in Playwright

Only claims that need the real thing:

- **A GPU was acquired and drew** - `grades on the GPU`, and the camera match crossing to it.
  That a frame *arrived*, not what it looks like: see below for looking at it.
- **A pointer gesture on a real element** - the crop rectangle taking a drag, touch targets on a
  phone. These need hit-testing and a layout engine.
- **The browser itself** - history entries, routing, reload, `?edit` handling.
- **The whole chain, once** - an edit surviving a save and a reload.

If a Playwright test's assertion could be written against a presenter, a store or a pure
function, it belongs in `bun test` instead. Opening a RAW costs a native decode; the same claim
usually costs a millisecond one layer down.

### One spec file, one domain, one library root

`web/e2e/` is a folder per domain - `library/`, `catalogue/`, `grid/`, `viewer/`, `editor/`,
`stack_triage/`, `mobile/`, `decode/`, `shell/` - and a new claim goes in the file that already
owns its subject rather than at the end of the longest one.

**No two spec files share a library root.** The whole run shares one API and one DB, so a file
that rates a photo, bins one, or re-points its library at a different rendition source writes
state the next file would read - and which file that is depends only on the order Playwright
walks them in. A root of its own is what lets a file be run alone
(`bun run --cwd web test:e2e -- viewer/zoom`) and lets a failure stay where it happened.

`useLibrary` in a `beforeAll` is how a file gets one, against a root declared in
`fixture_library.ts`. A file whose subject *is* the arrival of a library does the add inside the
test instead - `library/indexing.spec.ts` is watching the scan, and `library/add_library.spec.ts`
never submits the dialog at all.

Anything a spec reads out of the shell rather than out of its own library is not covered by any
of this: the home page opens the first library by root path, which is whichever spec's root sorts
first, so a spec that measures photographs opens its own before measuring.

What a root does not isolate is **the viewer's own settings**, which are global. Which rendition
it opens at follows whatever was last chosen anywhere, and it hides the sidebar while a photo is
open - so the stage is the window less its margins rather than less the sidebar, which moves where
the filmstrip sits and whether a magnified frame overhangs at all. A spec that reads what the
viewer is showing passes `viewerRendition` to `useLibrary`; one that measures the shape it is
shown in passes `hideSidebarInViewer: false`, or calls `setHideSidebarInViewer` in the test.

### Looking at a picture never needs a browser

**Do not open the editor in Playwright and screenshot the canvas.** Both the editor's view and a
rendition are render specifications - a decode, a set of edits, a size - and both render natively:

```
bun run scripts/cargo.ts run --release --manifest-path native/rawshim/Cargo.toml --example renders -- \
  <raw> <out-dir> --detail 40 --crop 3060,2254,480
```

It writes `render-*.avif` for the frame coordinates asked for at 1:1, with the luma roughness of
each, in about five seconds. The screenshot route costs a Playwright run, a zoom to 100% and a pan
for every region.

What makes it possible is that nothing about the flow is the browser's:

- `hdr::graded_as` is the rendition, exactly as `job::Base::build` assembles it.
- `gpu.rs` is what the editor ticks through - the browser's tick is `wasm.rs` calling
  `gpu::present`, over the same frame and the same passes - so `gpu.encode(frame, grade)` is that
  tick. Note it takes a frame that is *already* coded and warped; `graded_as` codes for itself,
  and handing it a prepared frame codes it twice and gives a flat, lifted picture.
- The denoise is `galosh.rs`, on the mosaic, and it is the only one.

### Component tests

`registerDom()` (`web/src/test_dom.ts`) installs jsdom, then the testing library is imported
dynamically - it reaches for `document` as it loads. Not a preload: the server's suites share
this runner, and a DOM makes `sessionStorage` read-only, which one of them assigns to.

Two things that will waste an afternoon if they are not known:

- **Base UI's slider cannot be driven headlessly.** Keyboard, `change` and pointer sequences all
  do nothing to it - with or without a layout box and a live `ResizeObserver` - while a plain
  React input in the same document answers all three. Assert what a slider does through the
  presenter; leave the control itself to Playwright.
- **Never deep-compare a value a React handler was passed.** A handler wired as a bare method
  reference receives the synthetic event, and `toEqual` on one of those walks the DOM through
  its circular references and never returns. Assert on the call's name, or on a field of it.

## Rendering must agree between the editor and a rendition

The same [photo, edits, rendition settings] has to produce the same pixels whether the browser
drew them or a render job did. **The browser runs this crate**: the editor's tick is `wasm.rs`
calling `gpu::present`, over the same WGSL and the same passes a rendition records, so the two are
one implementation rather than two held in agreement. What the page decides is *what* to draw.

Where a rule does still exist twice, a test pins the two together rather than trusting them:

- `the_draw_places_a_pixel_where_the_gather_does` - the geometry mapping, over every output
  pixel of a set of geometries, `image::Plan::at` against `geometry.slang`.
- `module-json.json` - the three shapes a tick crosses the worker boundary as, deserialised by
  `module_json.rs` and rebuilt by `module_json.test.ts`. A field renamed on one side is `missing
  field` at the first tick, which is a black stage.
- `display-size.txt` - what a geometry does to a frame's shape, `hdr::cropped_size` against
  `schemas/display_size.ts`, which the grid lays tiles out with.
- `gpu_fixture.rs`, `edit-words.txt`, `detail-passes.txt`, `reduction-words.txt` - the graded
  frame's snapshots and the tables behind it, pinned so that moving one is deliberate.

The tables live in `test/fixtures/tables/`. Adding a rule to one side and not the other is the
failure mode these exist for. If something has to be computed in two places, pin it in the same
commit.

Regenerate the fixtures deliberately, and only the ones that moved:
`BOWERBIRD_WRITE_FIXTURES=1 bun run test:native --test gpu_fixture`. The snapshots are compared
with a tolerance, so rewriting them wholesale replaces the committed answer with whatever this
machine's GPU produced.

## Styles are StyleX, and each component owns its own

There is no application stylesheet. Every component declares its styles with `stylex.create` in
its own file, and a value two components share is a token imported from a `*.stylex.ts` file -
`web/src/ui/tokens.stylex.ts` for colour, type and the control metrics - never a global custom
property. Token names are hashed, so plain CSS cannot reach them, which is the point: a value is
used through an import or not at all.

- **A repeated markup pattern is a `ui/` component, not a shared class.** `Page`, `Panel`, `Row`,
  `List`, `Field`, `Strip` and the rest take a `style` prop (`stylex.StyleXStyles`), passed last
  so the caller wins per property. No component takes a `className` string.
- **No descendant selectors.** A child's look is a style on the child, chosen from React state, or
  `stylex.when.ancestor(...)` for pure-CSS parent state. The focus ring is `focusRing.ring`
  (`ui/focus_ring.ts`), applied to every focusable element: there is no global `:focus-visible`.
- **`web/src/app/global.css` is document-level only** - `color-scheme`, box sizing, the html/body
  height, the element resets, reduced motion, react-day-picker's own sheet - and holds no value
  that is also a token. Nothing component-shaped goes there.
- **Components compile before they run, in tests too.** `bun test` preloads
  `web/src/test_stylex.ts` (both bunfigs name it), so an uncompiled `stylex.create` throwing at
  runtime means the preload was skipped, not that the component is wrong.
- **`@stylexjs/stylex` stays out of Vite's dependency pre-bundling** (`optimizeDeps.exclude` in both
  Vite configs). Pre-bundled, the dev server deadlocks and no page ever loads.
- **The landing site draws with the app's own `ui/` components and tokens**, imported across the
  package boundary from `web/src`. The two packages are separate installs, so `landing/vite.config.ts`
  dedupes `react`, `react-dom` and `@stylexjs/stylex`: without it the page runs two Reacts and every
  hook in a ui component throws. Keep the shared dependencies at the same versions in both.

## A picture is pinned as a picture

**A new fixture whose answer is a picture is a snapshot** (`snapshot.rs`): a PNG under
`test/fixtures/snapshots/`, in Git LFS, that opens as a photograph - PQ Rec.2020 at sixteen bits
with its `cICP` chunk, so a PR's image diff shows it in HDR, or sRGB where the claim is SDR. Pick
the framing the claim needs:

- `Snapshot::whole` - the frame downscaled on the device, for a global claim: a tone, a grade, a
  colour.
- `Snapshot::crops` - rectangles at 1:1, one under the next, for detail: a denoise, a demosaic, a
  sharpen.
- `Frame::Coded` for a frame past the coding, `Frame::Scene` for one before it (coded on the way in
  so it can be looked at), `Snapshot::mosaic` for photosites in their filters' colours.
- A frame already on the host, whole: `Snapshot::pq` for PQ codes, `Snapshot::signal` for the
  grade's rolled arm, `Snapshot::srgb` for an SDR render.

`.check(name, tolerance)` compares in the stored codes and, on a miss, writes what it got and a
side-by-side under `$TMPDIR/bowerbird-snapshots/`. **Look before regenerating:**
`bun run snapshots` draws every snapshot that differs from HEAD (or `--against <rev>`, or named ones)
in an SDR PNG an agent can read: columns before | after | difference, a row per crop, and the whole
grid twice - exposed for diffuse white above, for the HDR peak below.

**Whenever a fixture is regenerated or added - a snapshot or a table - you MUST show the user its
diff before calling the work done.** Every changed snapshot's `bun run snapshots` PNG - three
columns: before is the committed version, after is the regenerated one, then the difference - and
`git diff` for a table. A new snapshot has no committed version, so it draws blank | after | after:
the whole picture is the difference. One whose size changed - a crop - draws before | after alone.
The numbers alone do not say whether the move was the point.

## Text the user reads lives beside the component, not in it

Every component in `web/src` has a `foo.strings.ts` next to it exporting a `FooStrings`
object of functions, and the component calls those rather than writing the words:

```ts
export const ExportsPageStrings = {
  exportActions: () => 'Export actions',
  goToPhoto: (sourcePath: string) => `Go to ${sourcePath}`,
};
```

**Functions returning whole sentences**, not constants joined at the call site: a
translation cannot be assembled from fragments that inflect independently, so a string
takes what it needs and returns the finished line. Where a sentence is genuinely
interrupted - a folder path in a `<code>` - name the halves as a pair and say so.

**One message is stated once**, next to whichever component says it most, and imported
by the rest: the sidebar reads a link's name off the page it leads to. Identical text that
is a *different* message stays apart, with a line saying why, or the next reader merges
them - "Colour" the denoise slider is not "Colour" the panel of vibrance and saturation.

**What is data is not copy.** The default bin folder name, the white balance modes that
round-trip through XMP, and the single letters naming physical keys stay as literals.

`bun run lint` enforces it, through the oxlint plugin in `scripts/oxlint-plugin-strings.ts`.
`no-jsx-text` covers JSX: a text node, a literal a brace only wraps, and one reached
through a ternary, a `&&`, a `+`, a template or a cast. `no-literal-props` covers the props
named in `.oxlintrc.json` - `aria-label` is text where `className` is not, so they are
listed rather than assumed - including a name spread in as `{...{ 'aria-label': '…' }}`.
`no-literal-text` reaches the third of the app's text that is never JSX: an `Option`'s
`label`, a class field, a destructuring default, a toast, a `confirm`.

**A guard against habit, not a proof, and worth knowing where it stops.** It matches a
literal where it stands, so text bound to a `const` and rendered by name, returned from a
helper, or assembled at runtime all pass. So do the error messages the server sends, which
reach the reader through a toast unchanged and were never part of this. And a literal with
no *word* in it is a separator rather than a sentence - the `/` between path segments, the
`·` between counts, the `★` a rating is drawn with, the `x` in `1920x1080` - so one letter
never reports, which is why there is no allowlist to keep.

## How that text reads is `COPYWRITING.md`

The section above is where a string lives. `COPYWRITING.md` is how it reads, and it governs
every word a reader sees - a button, a heading, an error, a toast, a tooltip, alt text, the
landing site's prose, a feature list. **Hold every string you write against its checklist.**
It is not a polish pass for later: a string ships in the shape it was first written in, and
the review that would have caught it never happens.

Imported here rather than cited, so it is in context whether or not anyone thought to open
it - which is the failure this guards against, a guide nobody reads governing nothing:

@COPYWRITING.md

Nothing here fails a build. `bun run lint` checks where a string lives and never how it reads.

Five that get skipped, because each reads as ordinary writing rather than as a rule:

- **Sentence case everywhere**, headings and buttons included, with capitals for proper nouns
  and the named features the glossary marks with one, and nothing else.
- **The glossary's word for every concept.** "Photograph", "group", "peer", "preview" and
  "cull" each have a term that displaces them, and two words for one thing on one screen read
  as two features.
- **The banned structures stay banned however good they sound.** Correction framing ("X, never
  Y"), stacked fragments, caption fragments ("Similar photos, grouped into 1 thumbnail"),
  question-then-answer. They are how a feature list comes out reading like a template.
- **A sublabel is unjustified until argued for.** Writing copy makes it tempting to explain,
  and the explanation lands under the control: what the field is for, what ticking it does.
  Each line reads as helpful alone, and a screen of them reads as a form that does not trust
  the reader. Write the label, then ask what a reader gets wrong with no sublabel at all.
- **No dash as punctuation, no exclamation mark, British spelling, numerals for every number.**
  This file's own prose uses the first of those freely, and so does every doc in the repo;
  copy does not, so a sentence moved from a doc into the app is rewritten on the way.

A feature's description starts with a present-tense verb and no subject ("Groups similar
photos into 1 thumbnail"), an error says what happened then what to do with no blame, and an
obvious label gets no sublabel. The rest is in the file.

## The rawler fork (`native/vendor/dnglab`)

A **fork we intend to keep rebasing onto upstream**, not a copy we have taken ownership of. That
one fact decides everything below: every commit we add is a commit that has to replay cleanly over
someone else's changes, possibly years of them, and a conflict in a decoder is resolved by someone
who did not write either side.

**The shape to keep.** Full upstream history, our commits linear on top, on `main`, no merge
commits. Check it with `git log --oneline --graph origin/main..main` - anything that is not a
straight line is a rebase someone will have to unpick. If the checkout ever comes back shallow, a
rebase has nothing to sit on: `git fetch --unshallow origin` before anything else.

**Add; do not rewrite.** A new function, a new file, a new trait method with a default
implementation costs nothing to replay - upstream's diff and ours touch different lines. Editing an
upstream function body is what conflicts, so it needs a reason better than tidiness. Where a change
genuinely has to reach into upstream code, keep it to the fewest lines that work:
`imgop/sensor/bayer/ppg.rs` is the pattern to copy, where a wasm clock shim touches exactly one
upstream line - the `use` - and adds a block beside it.

**Extraction is the exception, and it is a real trade.** `decoders/arw.rs` pulls the black and
white level construction out of `raw_image` into `raw_image_from` so the region decode can share
it. That deletes 22 upstream lines and will conflict if upstream ever edits them. It stays
extracted on purpose: the alternative is a second copy of the black-level arithmetic that upstream
can fix without us noticing, and a silent divergence in what a sensor's black level is beats a
loud conflict every time. Prefer the conflict you can see.

**Mark local patches so a rebase can find them.** `LOCAL PATCH (bowerbird)` in a comment, with
what breaks without it - `crx/decoder.rs` and `ppg.rs` both carry one. A patch nobody can identify
is a patch that gets dropped in the first hard rebase.

**Nothing that is only scaffolding.** Benchmarks and one-off measurement examples belong in
`native/rawshim/examples/`, which is ours, not in the fork, where they are surface to carry
forever and to upstream around.

**Committing.** The submodule is its own repo: commit inside it first, then commit the parent's
pointer as a separate `chore(rawler):` commit naming what moved. `git submodule update --init` on
a fresh clone fails until the fork's commits are pushed, which is a real trap - the error names a
missing object, not a missing push.
