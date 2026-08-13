# Bowerbird

## Running the suites

The e2e suite takes about five minutes; the native and unit suites take seconds. Start a long
run in the background and then **do something else or wait for the completion notification**.

**Run e2e once, at the end.** It is the final check before handing work back, not a step between
edits: five minutes an iteration is most of an afternoon spent watching a browser start. The fast
suites - `bun run test:native`, `bun run test`, `bun run typecheck`, `bun run lint` - answer
almost everything and answer it in seconds, so iterate against those and let e2e confirm the
finished thing. The exception is a change *to* an e2e spec or to the machinery it drives, where
the suite is the only thing that can say whether the change works; even then, run the one spec
(`bun run --cwd web test:e2e -- <name>`) rather than all of them.

**Never poll a background job's output file.** Re-reading it in a loop tells you nothing the
notification would not, and the output is piped through `tail` in any case, so the file stays
empty until the run ends - every read of it returns the same nothing. If there is genuinely
nothing to do until a run finishes, wait for it rather than checking on it.

**Reach cargo through `scripts/cargo.ts`.** It runs cargo and then drops the artefacts that run
superseded, which cargo itself never does - `target/` reached 2.5GB in a day of rebuilding before
this existed. Bare `cargo` still works and still leaves the litter behind.

## Which suite a test belongs in

Four runners, and the rule is what a claim *needs*, not which layer it happens to live in.

| Runner | Command | For |
|---|---|---|
| `cargo test` | `bun run test:native` | The native pipeline: decode, fit, warp, the grade, and the WGSL held against it |
| `bun test` (root) | `bun run test` | The server, the schemas, and everything in `web/src` that is not a browser |
| `bun test` + jsdom | same, via `registerDom()` | React components: what a control does when it is used |
| Playwright | `bun run --cwd web test:e2e` | Only what a real browser or a real GPU can answer |

### An edit producing a picture is not an end-to-end question

**Do not write a Playwright test that moves a control and waits for the canvas to change.** Call
the presenter method the control is wired to, and assert the result:

```ts
presenter.settleExposure(1.25);
expect(pipeline.uniform().floats[at.exposure]).toBeCloseTo(1.25);
```

The reason this works is the pipeline's own design: a tick's uniform is a pure function of the
document (`edits` in `web/src/features/raw_edit/gpu/shaders.ts`), and every mutation is on a
presenter (see the architecture rules). So "does this slider change the picture" is answerable in
milliseconds, against the number the shader would actually read.

A canvas comparison is also a *worse* test. It says something changed; it cannot say the value
was right, which is the failure that actually happens - a slider wired to its neighbour, a scale
applied twice, a pair transposed. `raw_edit_presenter.test.ts` is the pattern: a store, a
recording pipeline that can build the uniform, and assertions on slots.

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

### Looking at a picture never needs a browser

**Do not open the editor in Playwright and screenshot the canvas.** Both the editor's view and a
rendition are render specifications - a decode, a set of edits, a size - and both render natively:

```
bun run scripts/cargo.ts run --release --manifest-path native/rawshim/Cargo.toml --example renders -- \
  <raw> <out-dir> --detail 40 --crop 3060,2254,480
```

It writes `rendition-*.avif` and `editor-*.avif` for the same frame coordinates at 1:1, with the
luma roughness of each, in about ten seconds for the pair. The screenshot route costs a
Playwright run, a zoom to 100% and a pan for every region, and then compares two pictures that
were graded differently unless you were careful.

What makes it possible is that nothing about either flow is the browser's:

- `hdr::graded_as` is the rendition, exactly as `job::Base::build` assembles it.
- `gpu.rs` runs the **same grade WGSL** the client does - `tests/gpu_fixture.rs` is the pin - so
  `gpu.encode(frame, grade)` is the editor's tick. Note it takes a frame that is *already* coded
  and warped; `graded_as` codes for itself, and handing it a prepared frame codes it twice and
  gives a flat, lifted picture.
- `galosh_srgb.rs` runs the **same denoise kernels** as `denoise_chain.ts`, so the editor's Detail
  sliders are answerable here too.

The editor path in `renders.rs` mirrors `edit::open` step for step - fit, code, filter, warp,
sharpen, denoise - because skipping the warp compares two crops of two geometries, and that
looks exactly like a denoise difference.

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
drew them or a render job did. The WGSL is shared verbatim - `gpu.rs` `include_str!`s the files
the page imports - and where a rule genuinely exists twice, a test pins the two together rather
than trusting them:

- `the_draw_places_a_pixel_where_the_gather_does` - the geometry mapping, over every output
  pixel of a set of geometries, `image::Plan::at` against `geometry.wgsl`.
- `edit-words.txt` - which slot each field of the uniform lands in, on both hosts.
- `gpu_fixture.rs` and `gpu_parity.spec.ts` - the graded frame itself.

Adding a rule to one side and not the other is the failure mode these exist for. If something
has to be computed in two places, pin it in the same commit.

Regenerate the fixtures deliberately, and only the ones that moved:
`BOWERBIRD_WRITE_FIXTURES=1 bun run scripts/cargo.ts test --release --manifest-path native/rawshim/Cargo.toml --test gpu_fixture`.
The `.expected.bin` files are compared with a tolerance, so rewriting them wholesale replaces the
committed answer with whatever this machine's GPU produced - and the browser then cannot match it.
