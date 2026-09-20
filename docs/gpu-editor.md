# The editor, as it runs

The RAW editor in the browser. `docs/raw-edit-gpu.md` is the note that argued for this shape
against the wasm CPU tick it replaced, and reads as that argument rather than as this; DESIGN §21
is the same for the editor before it. This describes what a tick does now.

## 1. The browser runs this crate

**There is one implementation of the picture, and the page is not a second one.** The editor's
tick is `wasm.rs` calling `gpu::present`, over the same WGSL and the same passes a rendition job
records. What the page decides is *what* to draw - a region, an exposure, an `Adjust`, a
`Geometry` - and never how.

That is the whole reason the editor and a stored rendition agree. They are not two renderers held
in agreement by a test; they are one renderer asked two questions. Where a rule genuinely exists
twice it is pinned (§6).

**No WebGPU, no editor.** `wasm::needs_webgpu` asks for the adapter at the top and refuses by
name, because every stage that makes a picture is a shader - the conditioning, GALOSH, RCD, the
coding, the defringe, the gather, the grade. Left to fail further down, a reader is told their
file could not be read, which sends them looking at the photograph instead of at the browser.
There is no CPU arm to fall through to and adding one would be the second implementation this is
built to not have.

## 2. No pixels cross the boundary

The frame is decoded, denoised, demosaiced, warped, sharpened and graded on the device the worker
opened, and the canvases the page hands over are surfaces on that same device. What crosses is a
region and a set of edits; what comes back is a drawn frame.

**Except once, for a picture the tab cannot decode** (§8). There the samples cross coded, one
transfer at the open and never again - and what they are is the same normalised PQ Rec.2020 the
open above leaves on the device, so every tick after it is this same tick.

**The canvas comes to the frame because the frame cannot go to the canvas.** A `GPUDevice` does
not cross a worker boundary and neither does a texture, so a stage owned by the page could only be
drawn by sending it the samples - 366MB at 61MP, and a copy either side. Instead the page
transfers an `OffscreenCanvas` in (`attachStage`, `attachLoupe`) and the module makes a surface of
it on its own device.

**The device is the module's, and could not be anything else.** wgpu 30 has no `from_webgpu` to
adopt a JS `GPUDevice` - `wgpu-hal` has no WebGPU backend at all, WebGPU there being a backend
rather than a hal target - so the module requests its own (`gpu::page_device`) and the page borrows
*it* by handing over a canvas. A page wanting to run its own shaders over this frame could not be
given the device to do it on. One device, and nothing read back between the decode and the draw.

## 3. The open, and what it leaves on the device

`edit.rs` is everything before the first tick: decode, prepare, fit the camera match, materialise
the lens warp, denoise, sharpen. What comes out is `Opened` - the coded frame the grade reads
(`tone::encode_base`), left on the device, plus the numbers the grade needs and cannot re-derive
from pixels.

This half is where threads are worth having, measured at 3.2x between one and twelve. The tick
below is entirely the GPU's.

**Two things are held across ticks, at different lifetimes.**

`HeldRaw` keeps the photograph *at the mosaic*. The read, the black levels, the white balance and
the conditioning depend on the bytes alone and are the seconds of an open, so a Detail or dust
slider re-runs the denoise, the demosaic and the grade against a mosaic already on the device
rather than re-reading a file. The noise fit is measured once and handed back in, because Phase 0
reduces over everything it is shown - it describes the photograph, not an amount, so re-measuring
per slider position would buy sixteen reductions for nothing.

`hold_drawing` keeps the per-frame-and-size resources: the curves, the lattice and the pyramid.
All three are functions of the frame and its size rather than of any slider, so they are built at
prepare and read by every tick after it.

The blur the presence sliders read is the exception, and deliberately. `Uploaded::detail_for`
builds it the first time a grade whose `Adjust` reads the neighbourhood asks for it - texture,
clarity, dehaze, highlights or shadows away from zero - and holds it in a `OnceCell` from then on.
Until then a 1x1 placeholder stands in, so a reader who never touches those sliders never pays for
it, and `hold_drawing`'s own upload passes `Adjust::none()` precisely so that opening a photograph
does not.

## 4. The tick

`tick(ev, region)` writes the uniform, draws one pass and presents. Three calls deep, and it never
waits on the GPU - which is what lets it be a plain call rather than a promise, where every
readback on this path has to be awaited. Nothing comes back and nothing is read back.

**One pass, and no graded frame in between.** `frame.slang` takes sensor levels to what the canvas
takes without a compute pass writing `rgba32float` nits for the draw to read back. Materialising
every stage is the CPU's shape, where the next stage is a separate loop over 30M samples; on a GPU
the value is already in a register when the next stage wants it. The intermediate costs 158MB
written and 158MB read per tick, measured at 5.2ms of a 15ms tick with the arithmetic either side
of it barely visible. It also forces a PQ code on the way out and a decode on the way in, six
`pow` each way, because a rendition is a PQ file - and a display is not a file.

**It runs once per canvas pixel, and a canvas is the viewport.** A 61MP frame fitted to a
2560x1707 stage costs 4.4MP of colour transform rather than 60: 7ms rather than 100.

`region` absent draws the cropped picture whole, which is what a reader who has not panned is
looking at. It is worked out inside the module because the geometry it is cropped by is there
(`hdr::cropped_size`), not because the page could not.

The sliders and the geometry are *set* rather than passed per tick (`setAdjust`, `setGeometry`): a
drag moves one of them and the rest have to stay where the reader put them.

## 5. The two canvases

The stage is the picture. The loupe is a second canvas over it, drawn from the same frame at
`max_lod: 0` - a magnifier is only ever magnified, so it reads the frame's own buffer at whatever
ratio rather than a level averaged for a smaller canvas.

**The glass shows what the export ships.** A tick's frame is denoised and sharpened for a stage,
where `holdTile` builds one rendition tile through the rendition's own chain at 1:1 - and a loupe
is the one magnification where the difference is visible. The tile is held rather than drawn once,
because a pointer sweep inside one tile is dozens of draws from the same buffer; until it lands
the glass draws the editor's frame, a tile costing tens of milliseconds to build.

## 6. What is pinned, and why each one exists

The page and the module agree by construction almost everywhere. These are the places a rule is
stated twice, each with a fixture holding the two together:

| Pin | Holds |
|---|---|
| `test/fixtures/tables/module-json.json` | The three shapes a tick crosses as. `module_json.rs` deserialises into `gpu::Region`, `gpu::Adjust` and `image::Geometry`; `module_json.test.ts` rebuilds them from annotated TypeScript literals. A field renamed on one side is `missing field` at the first tick, which is a black stage. |
| `test/fixtures/tables/display-size.txt` | What a geometry does to a frame's shape: `hdr::cropped_size` against `schemas/display_size.ts`, which the grid lays tiles out with. |
| `the_draw_places_a_pixel_where_the_gather_does` | The geometry mapping, over every output pixel of a set of geometries: `image::Plan::at` against `geometry.slang`. |
| `gpu_fixture.rs`, `edit-words.txt`, `detail-passes.txt`, `reduction-words.txt` | The graded frame's snapshots and the tables behind it. `detail-passes.txt` is the guided filter's entry-point order, which no graded fixture can see because those are pinned at every slider zero. |

Adding a rule to one side and not the other is the failure these exist for. Pin it in the same
commit.

## 7. The page's half

`local_open_worker.ts` owns the module; `local_open.ts` is the protocol between it and the page, a
tagged `Ask`/`Answer` pair over `postMessage`. The RAW is transferred in once and kept, so a tile
costs neither a download nor a copy - and a picture the tab did not decode is transferred the same
way, once, for the reason in §8.

`stage_resolution.ts` is what the page still decides, and it is short on purpose. Two things
cannot move into the module because both are the page's to know: the header the open answers with,
which is what the panel reads, and how large a backing store the reader's box is worth, which
needs a layout box and a device pixel ratio.

Everything else a control does is a presenter method. A slider is answerable without a GPU, a
server or a browser - `raw_edit_presenter.test.ts` calls the method the control is wired to and
asserts on the value the module would be handed, which is why almost none of this needs Playwright
(CLAUDE.md, "An edit producing a picture is not an end-to-end question").

## 8. A picture the tab cannot decode

A panorama is several photographs and a canvas of hundreds of megapixels; a phone cannot hold one
photograph's samples, let alone a set of them. So the picture is prepared where the files are -
`GET /image/:photoId/prepare`, which is `picture::prepared`, which is a rendition stopped before
the grade - and what crosses is the coded canvas rather than the sources behind it.

**The tick does not know.** `holdPicture` uploads the samples and builds the same `Drawing` an
open builds, so the frame is in the form §2 describes and everything above it is the same call.
What the page decides is which arm to take, and it decides it from the recipe
(`prepare_choice.ts`): a composite has no file to download whatever its size, and past a hundred
megapixels or on a coarse pointer neither has anything else.

Three things are genuinely absent on that arm, all below the coding:

- **The Detail and Dust panels.** There is no mosaic on this side, so a new amount is a new
  prepare. `mosaic` on the header says so and the panels close.
- **The loupe.** What it claims to show is the export's own pixels, and what arrived is the
  picture at a level.
- **The levels a reader can zoom into.** One level today, the coarsest the picture has
  (`composition::coarsest_level`, pinned against the page by `prepare-levels.txt`). Zooming past it
  magnifies rather than fetching finer - the plan under
  `docs/superpowers/plans/` is what makes it a ladder.

The reply is framed rather than headered: a `u32` header length, that much `PreparedHeader`, zero
padding to a word, then the samples (`edit::samples_at`). In the body because the desktop shell's
proxy keeps seven response headers and drops every other, so a header naming the levels and the
colour match would arrive empty in the webview.
