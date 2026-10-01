# Bowerbird

## The design spec is DESIGN.md plus the chapters in docs/design/

Read `DESIGN.md` for overview, stack, tree and chapter index. Chapters in `docs/design/`
share its numbering: `DESIGN §10.7` means §10.7 in the chapter indexed under §10.
Open only the relevant chapter.

## Vulkan is required. Full stop.

**Vulkan required.** Conditioning, GALOSH, dust removal, RCD, coding, defringe, lens gather
and grade are shaders, shared with the browser editor through WebGPU. No second Rust
implementation: it would drift (DESIGN 21.1).

**Never add a CPU path for a shader stage.** No adapter means fail, naming requirements.
Never write `if let Some(gpu)` with an `else` computing the same thing differently.
This bans **any host loop over picture pixels**: resampling, histograms, stacking-descriptor
grids, illuminant searches. Each stage must measure identically across machines.

Hardware GPU optional: `gpu::device` requests software Vulkan when hardware is absent.
**Software driver: SwiftShader only.** lavapipe's 128MiB storage-buffer limit cannot hold a
144MB 24MP frame; SwiftShader allows 1GiB. Fallback happens only when no hardware adapter answers.
`bun run get:swiftshader` downloads a pinned, hash-checked 4MB Android emulator prebuilt;
SwiftShader publishes no standalone binaries. `bun run test:native --swiftshader ...`
forces it for tests; other processes use
`VK_ADD_DRIVER_FILES=native/rawshim/.swiftshader/vk_swiftshader_icd.json`. Docker installs it
and deletes lavapipe's manifest.

CPU-only algorithms remain valid: solvers (`fit.rs`, `hdr_fit.rs`, `tca.rs`: least squares,
golden section), shader input tables, dust blob flood fill (`dust.rs`, surrounded by
`slang/dust_find.slang`). Restriction covers pixel arithmetic.

**Host solvers are small; f64 is not required.** In f32, camera match's 150k-pair 3x3 weighted
least squares shifts 0.0001 codes of 255; 7x7 Catmull-Rom normal matrix (condition ~2.6)
shifts 1e-7 on nodes of order 1; 2x2 falloff shifts corner gain 0.0002 codes despite its
`r^2`, `r^4` determinant being a seventeenth of its terms. Large pair accumulation already
runs on device; dispatching a 3x3 solve costs a round trip. Never justify CPU stages by f64.
Coding-table precision does matter: shader ST 2084 versus `tone::pq` puts a fifth of a real
frame one count out (`base.rs`, `the_coding_is_st_2084_exactly`).

## HDR is what a photograph is here

`rendition_hdr` defaults to 1: `full` and `max`, viewer and editor use HDR. SDR is opt-in;
grid tiles are the exception (`renditions.ts`). Reproduce picture bugs and design new stages
against HDR first, then check SDR. Eight-bit correctness alone misses the default path.

## A distance is a `Px` and a light is a `Light`. Both hosts. No exceptions.

**Always use `px.rs`/`px.slang` and `light.rs`/`light.slang`.** Hazards they prevent:

- Four-pixel colour footprint can cover **two and a half times** as much of a rendition
  as of the same photo at 1:1.
- Grading sRGB at HDR peak packs five highlight stops into eight bits; averaging PQ **codes**
  averages a curve, not light.
- `§3.1` corner bounds need matching spaces: `0.6` means 1.12 search-plane pixels versus 2.25
  analysis-plane pixels, enough to admit an invalid burst.

In Rust and Slang:

- **Distances need spaces.** Use `Span`/`Extent`. Fixed-size pixels use `Absolute` constants;
  caller-sized planes (output, render, align search) use a long-edge `Share` resolved by a frame.
- **Lights need domains.** Ratios use domain-free `Stops` or `Gain`. Decode before weighting;
  never sum coded values as light.
- **Cross planes through `Share`**, never an ad hoc ratio.
- **Declare shared constants once.** Use `prelude::LUMA` and `LUMA709` luma weights.

These modules are opt-in: `(usize, usize)` and `f32` boundaries compile without them.
Audit new files for `px`/`light` imports and named spaces/domains, including the `assembly_*`
family's ten Rust modules and eight shaders. Compilation does not prove unit safety.

Before adding a shader constant, classify it in `px.slang`'s header: picture share, absolute
mosaic distance, scale-exact fixed working plane, intentional output pixel, or non-pixel unit.
Declare each light's domain; ratios use `Stops`.

## The shaders are Slang

Edit `slang/`, never generated WGSL. `native/rawshim/build.rs` compiles every `.slang` except
a `module` with `slangc` into `$OUT_DIR/wgsl/<name>.wgsl`; `include_str!` and runtime shader
tests read there. No generated files are committed; no `wgsl/` source directory exists.

Browser builds cannot access cargo's `$OUT_DIR`. `scripts/build-web-shaders.ts` uses the same
pinned compiler, emits gitignored `web/src/features/photos/generated/`, imported with `?raw`.
Vite's `buildStart` invokes it for both `dev` and `build`, without requiring cargo.

`bun run get:slangc` installs into `native/rawshim/.slangc`; `BOWERBIRD_SLANGC` overrides it.
Missing both fails with installation instructions. Compiler and codecs share a vcpkg commit:
bumping it changes both and requires snapshot review, since Slang lowering can change last bits.

## Users run what `release.yml` builds

Shipped apps come from `.github/workflows/release.yml`, each desktop platform built natively on
its own runner (`windows-latest`, `macos-14`). `cross.Dockerfile` is only `release:check`'s local
cross-build check (DESIGN §23): Windows via cargo-xwin, macOS via osxcross, both without
`renditions`. Reason about a platform's shipped binary from the workflow, never the Dockerfile.
Host-only tools (Bun's `--windows-*` flags) are fine in release; the cross stages may skip them.

## The codecs are pinned too, through vcpkg, and linked statically

`bun run get:codecs` builds libavif, libjxl, aom, dav1d, sharpyuv, highway, brotli and lcms2
into `native/rawshim/.codecs`, pinned by one vcpkg commit (DESIGN §23.7). Missing tree fails
naming that command. Distribution codecs are unsuitable: libavif gain-map API arrived behind
a flag in 1.1, settled in 1.2; Ubuntu 24.04 ships 1.0.4, Debian trixie 1.1.1 with flag off.
Distributed libjxl 0.7 predates encoder API stability in 0.10.

All link **statically**; `librawshim` needs only C/C++ runtimes. `native/rawshim/vcpkg/` holds
manifest, libavif overlay using sharpyuv rather than libyuv, and triplets skipping debug builds
and pinning macOS deployment target. A vcpkg bump must re-record `encode` rows in
`bench.budget.json` (`BOWERBIRD_WRITE_BUDGET=1`) in the same commit. Snapshots are PNG, not AVIF.

Linux/macOS prerequisites: compiler, git, pkg-config, python3, zip, unzip, nasm on x86.
Getter names missing tools; vcpkg fetches cmake/ninja, and everything on Windows.

All five getters reuse trees only when recipes match (`scripts/pinned.ts`):
codecs/compiler record vcpkg commit, files under `native/rawshim/vcpkg/`, getter source;
driver/maps record file hashes; weights record checkpoint hash and getter source.
`get:environments` supplies print-preview HDR maps, `get:pmrid` denoiser weights;
`get:shell` runs both. `get:codecs` also rejects libavif without sharpyuv, whose stub returns
`NOT_IMPLEMENTED` for every 4:2:0 encode, including grid tiles.

Trees live in recipe-named directories under `~/.cache/bowerbird/<name>/`, reached through
`native/rawshim/.<name>` symlinks. Worktrees share matching builds; different pins coexist.
Run getters in each worktree to create symlinks. `XDG_CACHE_HOME` moves cache;
`BOWERBIRD_SLANGC` still selects an external compiler.

- `static const` folds into use sites; tests pinning shader constants read `.slang`.
- Names are mangled: `Params_std140_0`, `FROM_FRAME_0`. `wgsl_layout.rs` matches block prefixes;
  draw constants use `[vk::constant_id(0)]` IDs.

## Formatting

Use Prettier with `.prettierrc.json` for supported source and text files, and rustfmt with
`rustfmt.toml` for Rust. Install them with `bun install` and `rustup component add rustfmt`.

**Repository-wide formatting is deferred until the pending branches merge.** Keep formatting
limited to files deliberately selected for the task. Defer formatting hooks and CI enforcement
until the full formatting pass. Avoid unrelated formatting changes in feature diffs.

- Selected Prettier files: `bunx --no-install prettier --write path/to/file.ts`.
  Replace `--write` with `--check` to check without writing.
- Selected Rust files: `rustfmt --edition 2024 --config-path rustfmt.toml path/to/file.rs`.
  Use the edition declared in the crate's `Cargo.toml`; add `--check` to check without writing.
- One Rust crate: `bun run scripts/cargo.ts fmt --manifest-path native/heif/Cargo.toml`.
  Add `--check` to check without writing. Keep `--all` off, since it includes local vendored dependencies.
- Full formatting pass: `bun run format`; full check: `bun run format:check`.
  `format:prettier` and `format:rust` run each formatter separately; their `:check` variants only check.

`scripts/format-rust.ts` covers the owned Rust crates, including the desktop shell and local
`parking_lot` shim. `.prettierignore` excludes vendored code, generated files, migrations,
fixtures, and lockfiles. Keep formatter scope and exclusions current when adding crates or generators.

## Running the suites

Typical times: e2e four minutes, `test:bench` five with release build, real RAW tests
(`--features fixtures`) one minute; `test:native`, `test`, `typecheck`, `lint` seconds.
e2e far past four minutes suggests page-load timeouts. Start long runs in background,
then do other work or wait for completion. **Never poll output files**: output piped through
`tail` stays empty until completion.

`test:native` requires a name filter, `--test <file>`, or `--lib`; no selection exits 2.
Real RAW tests require `--features fixtures`. It covers **only `native/rawshim`**.
Run sibling crates through `bun run scripts/cargo.ts test --manifest-path native/updater/Cargo.toml`,
substituting `native/lensdb/Cargo.toml` or `native/heif/Cargo.toml` as needed.
`lensdb` tests pin scored search against C results (DESIGN §10.8).
`native/avif_planes` has no own tests: rawshim's
`the_browsers_decoder_hands_back_libavifs_planes` compares it to libavif; `build:wasm` builds it.

**Run only checks affected since the last green run.** Rust: `test:native`; `src`:
`bun run test`; `web/src`: `bun run --cwd web test`; TypeScript changes also need
`bun run typecheck` and `bun run lint`. Comments/docs/non-code-only changes need no tests,
builds or compile checks. Scope specific changes with `bun run test:native <name>` or
`bun test <path>`; widen only as far as the change reaches.

**Run e2e once, at the end**, for runtime changes needing it. Iterate on fast suites.
For e2e-spec or machinery changes, iterate on the affected spec:
`bun run --cwd web test:e2e -- <name>`.

**Replication changes require 3000 convergence seeds before handoff:**

```
bun run converge 3000
```

`scripts/converge.ts` uses batches of a few hundred seeds in separate processes because libSQL
never frees prepared statements. `BOWERBIRD_CONVERGE_SEEDS=40 bun run test <path>` is inner-loop
only: a collapse-stamp bug passed 40 and 1000, then diverged at 2 seeds in 1500
(docs/replication.md §5.4). Run 3000 once alongside final checks; changes away from
`src/services/replication` do not need it.

**Render-cost changes require `bun run test:bench`** (`scripts/bench.ts`): shaders, kernels,
fit, decode, added stages. A stage over budget fails. Different adapters or uniform machine
load shifts report and pass; failures on the budget's machine must be fixed or deliberately
re-recorded in the same commit (`BOWERBIRD_WRITE_BUDGET=1 bun run bench`, idle machine).
Never leave the budget red.

Sweeping changes (shared types/shaders, FFI constants, cross-module renames, rebases) require
`bun run test:native
--lib`, each affected `--test <file>`, and **`bun run build:wasm`**. Host cargo, even
`--all-targets`, cannot compile `wasm.rs` under `#[cfg(target_arch = "wasm32")]`.
Changes to `gpu::Grade`, `tone::Levels`, `PreparedHeader` can therefore pass host checks
and break the browser.

**Use `scripts/cargo.ts` for cargo.** It removes superseded artefacts; bare `cargo` leaves
them in `target/`, measured at 2.5GB after a day of rebuilding.

## Which suite a test belongs in

Choose by what the claim needs.

| Runner                  | Command                               | For                                                                                                                                                                                       |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test`            | `bun run test:native <name>`          | Native decode, fit, warp, grade, WGSL agreement                                                                                                                                           |
| `bun test` (root)       | `bun run test`                        | Server and schemas (`src`, `scripts`)                                                                                                                                                     |
| `bun test` (web)        | `bun run --cwd web test`              | `web/src` outside browser                                                                                                                                                                 |
| Platform tests          | `bun run test:platform [path filter]` | Single tests whose behaviour differs by OS or filesystem (watching, case-folding, links, permissions, rename semantics, processes, updater), split from their unit file; never librawshim |
| `bun test` + jsdom      | the web one, via `registerDom()`      | React control behaviour                                                                                                                                                                   |
| `bun test` + the budget | `bun run test:bench`                  | Stage costs against `test/fixtures/bench.budget.json`                                                                                                                                     |
| Playwright              | `bun run --cwd web test:e2e`          | Claims needing real browser or GPU                                                                                                                                                        |

### A test finds what a user can perceive

Locate/assert through role, accessible name, text, label, aria state (`aria-selected`,
`aria-pressed`, `aria-current`, `aria-busy`, `aria-expanded`), or computed style (`toHaveCSS`).
**No `data-testid` or styling-class selectors**: StyleX classes are shared hashed atoms.
If an element cannot be found, fix its semantics.

Exception: hidden `raw-edit-diagnostics` in `raw_edit_stage.tsx` exposes GPU adapter,
prepared/canvas sizes, camera-match status and tile level/fetch state through `editDiagnostics` in
`web/e2e/helpers.ts`. New hooks need equally non-user-visible data.

Playwright `has:` resolves relative to its outer locator. Inside it, use
`page.getByRole(...)`, not `photoStage(page).getByRole(...)`, which searches for a nested region.

### An edit producing a picture is not an end-to-end question

**Never test a control by waiting for canvas changes in Playwright.** Call its presenter
and assert the value sent to the module:

```ts
presenter.settleExposure(1.25);
expect(decoder.exposure).toBeCloseTo(1.25);
```

Presenters own mutations; the module owns picture rules. Assert region, exposure, `Adjust`,
`Geometry` through a recording decoder, following `raw_edit_presenter.test.ts`.
Canvas differences cannot detect a wrong value, neighbour control, doubled scale or transposed pair.

### What stays in Playwright

- GPU acquisition/draw: `grades on the GPU`, camera match crossing into GPU. Assert frame arrival.
- Real pointer gestures: crop drag, phone touch targets; these require hit-testing/layout.
- Browser behaviour: history, routing, reload, `/edit`.
- Whole chain once: edit survives save/reload.

Assertions answerable by presenter, store or pure function belong in `bun test`.

### One spec file, one domain, one library root

`web/e2e/` groups domains: `library/`, `catalogue/`, `grid/`, `viewer/`, `editor/`,
`stack_triage/`, `mobile/`, `decode/`, `shell/`. Add claims to their owning file.

`web/e2e/fixtures.ts` starts API, catalogue and Vite per worker (`fullyParallel`).
Dependent tests require `mode: 'serial'`. Import `test` from `../fixtures`, never
`@playwright/test`, to receive a server.

**Each spec file needs its own library root.** Catalogues are per-worker; disk roots are shared
across the run. Non-serial files must not move files on disk, since their tests can span workers.
Isolation also permits standalone runs (`bun run --cwd web test:e2e -- viewer/zoom`).
Use `useLibrary` in `beforeAll` with a root from `fixture_library.ts`. Tests about library
arrival add it inside the test: `library/indexing.spec.ts` observes scanning;
`library/add_library.spec.ts` never submits its dialog.

Open the target directly with `gotoLibrary`, `gotoShoot`, `gotoPhoto`; set up through API
(`addLibrary`, `setRenditionSource`, `setViewerRendition`). Only Settings tests open Settings.

Viewer settings are shared per worker catalogue. `freshViewer` in `fixtures.ts` resets before
each test: library-served rendition, sidebar hidden while viewing. This affects stage size,
filmstrip position and magnified overhang. Override with `setViewerRendition` or
`setHideSidebarInViewer` in the test or `beforeEach`, never `beforeAll`.

### Looking at a picture never needs a browser

**Use native renders, not Playwright canvas screenshots.** Editor and rendition share render
specifications (decode, edits, size):

```
bun run scripts/cargo.ts run --release --manifest-path native/rawshim/Cargo.toml --example renders -- \
  <raw> <out-dir> --detail 40 --crop 3060,2254,480
```

Writes `render-*.avif` at requested frame coordinates, 1:1 (100% zoom), with luma roughness,
in about five seconds.

- Examples showing what ships open with `support::Open` (AUTO denoise, dust, defringe before the
  fit, quantile 0.9) and grade with `support::graded` or `support::cut` (`job::Base::build`'s
  chain). Never `decode_frame`/`fit_hdr_for`, which skip all three and move the camera match, nor
  `hdr::graded_as`, which skips the defringe and sharpens at a fixed sigma with no noise table.
- `gpu.rs` supplies editor passes; `wasm.rs` calls `gpu::present`.
  `gpu.encode(frame, grade)` needs an **already coded and warped** frame.
  `graded_as` codes for itself: passing a prepared frame codes twice, lifting/flattening the image.
- Only denoise is `galosh.rs`, on the mosaic.

### Component tests

Call `registerDom()` (`web/src/test_dom.ts`) before dynamically importing testing library,
which reads `document` during import. Never preload DOM: shared server tests assign
`sessionStorage`, which DOM makes read-only.

- Base UI slider ignores headless keyboard, `change` and pointer sequences even with layout
  and `ResizeObserver`. Assert presenter behaviour; real control interaction belongs in Playwright.
- Never deep-compare React handler arguments: bare methods receive synthetic events, and
  `toEqual` can hang traversing circular DOM references. Assert call name or individual field.

## Rendering must agree between the editor and a rendition

Same [photo, edits, rendition settings] must produce identical pixels. Browser `wasm.rs`
calls `gpu::present`, sharing the rendition's WGSL and passes. Page chooses what to draw.
Where logic exists twice, pin agreement:

- `the_draw_places_a_pixel_where_the_gather_does`: every output pixel across geometries,
  `image::Plan::at` versus `geometry.slang`.
- `module-json.json`: three worker-boundary shapes, decoded by `module_json.rs`, rebuilt by
  `module_json.test.ts`. One-sided renames yield `missing
field` and a black stage.
- `display-size.txt`: `hdr::cropped_size` versus `schemas/display_size.ts`, used by grid layout.
- `gpu_fixture.rs`, `edit-words.txt`, `detail-passes.txt`, `reduction-words.txt`: grade snapshots/tables.

Tables live in `test/fixtures/tables/`. Pin duplicated rules in the same commit.
Regenerate only affected fixtures, deliberately:
`BOWERBIRD_WRITE_FIXTURES=1 bun run test:native --test gpu_fixture`.
Snapshots tolerate variation; wholesale regeneration would replace reference answers with this GPU's output.

## Styles are StyleX, and each component owns its own

Declare `stylex.create` in each component. Shared values come from `*.stylex.ts` tokens;
colour, type and control metrics from `web/src/ui/tokens.stylex.ts`. No global custom properties;
hashed tokens require imports.

- Repeated markup becomes a `ui/` component: `Page`, `Panel`, `Row`, `List`, `Field`, `Strip`.
  Pass `style` (`stylex.StyleXStyles`) last so callers win per property. No `className` prop.
- No descendant selectors. Style children from React state or `stylex.when.ancestor(...)`.
  Apply `focusRing.ring` (`ui/focus_ring.ts`) to every focusable element; no global `:focus-visible`.
- `web/src/app/global.css` holds only document rules: `color-scheme`, box sizing, html/body height,
  resets, reduced motion, react-day-picker sheet. No component rules or duplicate token values.
- `bun test` preloads `web/src/test_stylex.ts` through both bunfigs. Runtime `stylex.create`
  errors mean compilation preload was skipped.
- Exclude `@stylexjs/stylex` from dependency pre-bundling with `optimizeDeps.exclude` in both
  Vite configs; pre-bundling deadlocks dev server.
- Landing imports app `ui/` components/tokens from `web/src`. Separate installs require
  `landing/vite.config.ts` deduplication of `react`, `react-dom`, `@stylexjs/stylex`;
  duplicate React breaks hooks. Keep shared dependency versions equal.

## A picture is pinned as a picture

Picture fixtures are `snapshot.rs` PNGs in `test/fixtures/snapshots/`, stored in Git LFS.
HDR uses sixteen-bit PQ Rec.2020 with `cICP` for HDR PR diffs; SDR uses sRGB.

- `Snapshot::whole`: device-downscaled frame for tone, grade, colour.
- `Snapshot::crops`: stacked 1:1 rectangles for denoise, demosaic, sharpen.
- `Frame::Coded` after coding; `Frame::Scene` before coding (coded on entry);
  `Snapshot::mosaic` for photosites in filter colours.
- Host whole-frame data: `Snapshot::pq` for PQ codes, `Snapshot::signal` for grade's rolled arm,
  `Snapshot::srgb` for SDR.

`.check(name, tolerance)` compares stored codes; failures write output and side-by-side under
`$TMPDIR/bowerbird-snapshots/`. **Look before regenerating.** `bun run snapshots` renders
differences from HEAD (or `--against <rev>`, or named snapshots) as SDR PNGs: before | after |
difference, one row per crop, repeated at diffuse-white and HDR-peak exposures.

**Show user every added/regenerated fixture diff before handoff.** Snapshots: show each
`bun run snapshots` PNG. Tables: `git diff`. New snapshots show blank | after | after;
size changes show before | after. Numbers alone cannot establish whether visual changes are intended.

## Text the user reads lives beside the component, not in it

Each `web/src` component gets adjacent `foo.strings.ts`, exporting `FooStrings` functions:

```ts
export const ExportsPageStrings = {
  exportActions: () => 'Export actions',
  goToPhoto: (sourcePath: string) => `Go to ${sourcePath}`,
};
```

Return whole sentences, never join translated fragments. For genuinely interrupted sentences
(folder path in `<code>`), name and explain the paired halves.

Declare each message once beside its main component; others import it. Sidebar link names come
from destination pages. Identical text with different meanings stays separate with a reason:
"Colour" denoise slider differs from "Colour" vibrance/saturation panel.

Data stays literal: default bin folder, XMP white-balance modes, physical-key letters.

Prose pages use adjacent MDX (`hdr_page.mdx`), with figures in TypeScript and labels in strings.
Pass rendering `components`; landing copy lives under `landing/src/copy/`.
`bun run typecheck` uses `scripts/check-mdx.ts` to check tags/props. Injected components need
an `@import` of `MDXProvidedComponents`, as in `hdr_page.mdx`, or tags become `any`.
Lint skips MDX; review its prose against `COPYWRITING.md`.

`bun run lint` enforces placement via `scripts/oxlint-plugin-strings.ts`:
`no-jsx-text` covers JSX text, braces, ternaries, `&&`, `+`, templates, casts;
`no-literal-props` covers listed props in `.oxlintrc.json`, including spread
`{...{ 'aria-label': '…' }}` (`aria-label` is copy, `className` is not);
`no-literal-text` covers non-JSX text: `Option` `label`, fields, defaults, toasts, `confirm`.

Lint is incomplete: text through `const`, helpers, runtime assembly and server errors can pass.
Single-letter/non-word literals also pass: `/`, `·`, `★`, `x` in `1920x1080`; no allowlist needed.

## How that text reads is `COPYWRITING.md`

`COPYWRITING.md` governs every visible string: buttons, headings, errors, toasts, tooltips,
alt text, landing prose, feature lists. Apply its checklist when writing, not in a later polish pass.
Imported to keep it in context:

@COPYWRITING.md

`bun run lint` checks placement, never wording. Commonly missed rules:

- Sentence case everywhere, except proper nouns and glossary-capitalised feature names.
- Use glossary terms; "Photograph", "group", "peer", "preview", "cull" have preferred replacements.
- No correction framing ("X, never Y"), stacked/caption fragments, question-then-answer.
- Labels need no sublabel unless its absence causes a specific misunderstanding.
- No punctuation dashes or exclamation marks; British spelling, numerals for every number.
  Rewrite doc prose before moving it into UI copy.

Feature descriptions start with a present-tense verb, no subject ("Groups similar photos into 1
thumbnail"). Errors state what happened, then recovery, without blame.

## The rawler fork (`native/vendor/dnglab`)

Keep fork rebasable onto upstream: full history, linear local commits on `main`, no merges.
Check `git log --oneline --graph origin/main..main`. If shallow, run
`git fetch --unshallow origin` before rebasing.

Prefer additions: new functions/files, trait methods with defaults. Edit upstream bodies only
when necessary, using fewest lines. `imgop/sensor/bayer/ppg.rs` shows a wasm clock shim touching
one upstream `use` and adding a block beside it.

Extraction can justify conflict: `decoders/arw.rs` shares black/white-level construction between
`raw_image` and `raw_image_from` for region decode. Its 22-line upstream extraction avoids
duplicated arithmetic silently missing upstream fixes.

Mark local patches `LOCAL PATCH (bowerbird)` with the hazard of removal (`crx/decoder.rs`,
`ppg.rs`). Put benchmarks/one-off examples in our `native/rawshim/examples/`, never the fork.

Commit submodule first, then parent pointer in a separate `chore(rawler):` commit naming changes.
Fresh clones' `git submodule update --init` fails with missing objects until fork commits are pushed.
