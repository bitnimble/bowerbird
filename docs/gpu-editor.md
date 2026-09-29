# The editor, as it runs

Browser RAW editor runtime. Design rationale: `docs/raw-edit-gpu.md` and DESIGN §21.

## 1. The browser runs this crate

Editor ticks call `gpu::present` from `wasm.rs`, sharing WGSL and passes with rendition jobs.
Page chooses region, exposure, `Adjust`, `Geometry`; renderer owns pixel arithmetic.
Shared implementation guarantees agreement; duplicated rules have fixtures (§6).

**No WebGPU, no editor.** `wasm::needs_webgpu` checks first, naming adapter failure rather than
reporting an unreadable file. Conditioning, GALOSH, RCD, coding, defringe, gather and grade are
shaders; no CPU fallback allowed.

## 2. No pixels cross the boundary

Worker's device decodes, denoises, demosaics, warps, sharpens and grades into transferred canvases.
Boundary carries regions and edits; worker draws frames.

Exception: pictures the tab cannot decode (§8) transfer coded samples once at open.
Normalised PQ Rec.2020 matches the local open's device frame; subsequent ticks are identical.

Neither `GPUDevice` nor textures cross worker boundaries. Sending samples would cost 366MB
at 61MP plus copies. Page transfers `OffscreenCanvas` (`attachStage`, `attachLoupe`);
module creates surfaces on its device.

wgpu 30 has no `from_webgpu` for adopting JS `GPUDevice`; WebGPU is a backend, not a
`wgpu-hal` target. Module requests its own (`gpu::page_device`); page supplies canvases.
One device, no readback between decode and draw.

## 3. The open, and what it leaves on the device

`edit.rs` decodes, prepares, fits camera match, materialises lens warp, denoises and sharpens.
Its `Opened` holds device-resident coded frame (`tone::encode_base`) and grade metadata.

This half is where threads are worth having, measured at 3.2x between one and twelve. The tick
below is entirely the GPU's.

**Two things are held across ticks, at different lifetimes.**

`HeldRaw` retains device mosaic, read, black levels, white balance and conditioning.
Detail/dust sliders rerun denoise, demosaic and grade without file reads. Noise fit is measured
once per photo: repeating Phase 0 per slider position would waste sixteen reductions.

`hold_drawing` builds and retains curves, lattice and pyramid per frame/size, independent of sliders.

`Uploaded::detail_for` lazily builds neighbourhood blur when `Adjust` first needs nonzero
texture, clarity, dehaze, highlights or shadows, then caches it in `OnceCell`.
A 1x1 placeholder and `hold_drawing`'s `Adjust::none()` avoid this cost at open.

## 4. The tick

`tick(ev, region)` writes uniform, draws one pass, presents. Three calls deep, synchronous,
with no GPU wait or readback.

`frame.slang` transforms sensor levels directly to canvas output. No intermediate `rgba32float`
nits buffer or separate loop over 30M samples: intermediate values stay in registers.
Materialising that buffer costs 158MB write plus 158MB read, measured at 5.2ms of a 15ms tick,
and unnecessary PQ encode/decode at six `pow` each way.

Runs per viewport pixel: a 61MP frame on a 2560x1707 stage transforms 4.4MP rather than 60,
costing 7ms rather than 100.

Absent `region` draws the whole cropped picture; module computes it from `hdr::cropped_size`.

`setAdjust` and `setGeometry` retain independent state across ticks and drags.

## 5. The two canvases

The stage is the picture. The loupe is a second canvas over it, drawn from the same frame at
`max_lod: 0` - a magnifier is only ever magnified, so it reads the frame's own buffer at whatever
ratio rather than a level averaged for a smaller canvas.

`holdTile` builds a 1:1 tile through the rendition chain so loupe detail matches export,
not stage-scaled denoise/sharpen. Retain it across pointer draws. Until its tens-of-milliseconds
build finishes, loupe uses editor frame.

## 6. What is pinned, and why each one exists

Fixtures pin duplicated page/module rules:

| Pin | Holds |
|---|---|
| `test/fixtures/tables/module-json.json` | The three shapes a tick crosses as. `module_json.rs` deserialises into `gpu::Region`, `gpu::Adjust` and `image::Geometry`; `module_json.test.ts` rebuilds them from annotated TypeScript literals. A field renamed on one side is `missing field` at the first tick, which is a black stage. |
| `test/fixtures/tables/display-size.txt` | What a geometry does to a frame's shape: `hdr::cropped_size` against `schemas/display_size.ts`, which the grid lays tiles out with. |
| `the_draw_places_a_pixel_where_the_gather_does` | The geometry mapping, over every output pixel of a set of geometries: `image::Plan::at` against `geometry.slang`. |
| `gpu_fixture.rs`, `edit-words.txt`, `detail-passes.txt`, `reduction-words.txt` | The graded frame's snapshots and the tables behind it. `detail-passes.txt` is the guided filter's entry-point order, which no graded fixture can see because those are pinned at every slider zero. |

Pin new duplicated rules in the same commit.

## 7. The page's half

`gpu_worker.ts` owns the module, on the one worker the app starts at boot and keeps
(`gpu_thread.ts`); `gpu_protocol.ts` is the protocol between it and the page, a tagged message and
answer pair over `postMessage`. **That worker holds the app's only GPU device**: the module opens it
(`gpu::page_device`) and hands the browser's `GPUDevice` under it to the viewer's own WebGPU drawing
(`stage_gpu.ts`), whose canvases the page transfers in on their first paint (`stage_canvas.ts`). So
the editor, the print mockup, the merge page, the viewer and the renditions this device builds share
one device and one set of compiled pipelines for the life of the page. Each editor open is a session
on it (`LocalDecoder`), freed when the editor closes. The RAW is transferred in once and kept, so a
tile costs neither a download nor a copy - and a picture the tab did not decode is transferred the
same way, once, for the reason in §8.

Page retains open header for the panel. Its `stage_resolution.ts` decides backing-store
dimensions from layout size and device pixel ratio.

Controls call presenters. `raw_edit_presenter.test.ts` asserts module inputs without GPU,
server or browser; see CLAUDE.md, "An edit producing a picture is not an end-to-end question".

## 8. A picture the tab cannot decode

Panoramas can span hundreds of megapixels, beyond phone memory. Server
`GET /image/:photoId/prepare` calls `picture::prepared`, stopping rendition before grade;
transfers coded canvas instead of source frames.

`holdPicture` uploads samples into the same `Drawing` as local open, preserving identical ticks.
`prepare_choice.ts` selects this path for composites, photos past a hundred megapixels,
or coarse pointers.

Three things are genuinely absent on that arm, all below the coding:

- **The Detail and Dust panels.** There is no mosaic on this side, so a new amount is a new
  prepare. `mosaic` on the header says so and the panels close.
- **The loupe.** What it claims to show is the export's own pixels, and what arrived is the
  picture at a level.
- **The levels a reader can zoom into.** One level today, the coarsest the picture has
  (`composition::coarsest_level`, pinned against the page by `prepare-levels.txt`). Zooming past it
  magnifies rather than fetching finer - the plan under
  `docs/superpowers/plans/` is what makes it a ladder.

Reply body: `u32` header length, `PreparedHeader` bytes, zero padding to a word, samples
(`edit::samples_at`). Desktop proxy preserves only seven response headers, so levels and
colour-match metadata must travel in the body.
