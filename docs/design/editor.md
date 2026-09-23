# Bowerbird design: Editing in the browser, and HDR

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 21. Editing in the browser

> **Status: this section is an argument about a wasm CPU editor, not a description of the
> one that ships.** The editor opens the RAW in the page - in any browser, and in the desktop
> shell's own webview, which is why the shell has no decode path of its own - and grades per
> tick on the GPU through WGSL. The crate builds for `wasm32-unknown-unknown` as pure Rust
> with no C linked, which `tests/wasm_build.rs` is the host-side half of. The device is the
> module's own: wgpu cannot adopt a `GPUDevice` from JS, so the page hands over a canvas
> instead (`gpu::page_device`). **`docs/gpu-editor.md` describes what runs.**
>
> What it is kept for is §21.1: how a second implementation of one picture drifts - the
> editor lost the camera match twice, silently - which is the reason the GPU tick is pinned
> against CPU fixtures at all, and the reason a CPU arm for a stage that has a shader is
> refused outright.

A Lightroom exposure slider, in the photo viewer, in HDR. Actions → Edit replaces the metadata strip with the exposure panel and the stage with the live grade; Done (or Escape) discards everything and returns to the stored rendition. There is no save yet - sidecars come later. One RAW is decoded once and then graded per slider tick, entirely client side: `rawshim` compiled to `wasm32-unknown-unknown` runs LibRaw, the embedded preview's JPEG decode, the camera match and the grade. There is no server in the loop below the fetch, and the browser contributes nothing to the picture.

**The point of the exercise was to find out whether the grade could stay exact.** It can, so nothing here approximates tone or colour: a drag grades the *same* transform the renditions do, under the same library settings, and spends resolution instead - 960px on its long edge while the pointer moves, full size once it stops. Resolution is the disposable part of a preview; a cheaper curve is not, because a cheap curve is a different picture and the whole purpose is judging the real one.

### 21.1 One pipeline, two entry points

The editor grades through `hdr::prepare` and `hdr::grade_prepared`, which are the functions the renditions grade through. `Prepared` is a decoded frame with the geometry, the falloff and the levels already applied and the exposure not yet - which is precisely the split an interactive grade needs, since exposure is the only thing a tick changes. A rendition calls both once; the editor calls `prepare` at open and `grade_prepared` per tick.

That is not a refactor for tidiness. The spike began with the editor holding its own copy of the grade, and it drifted immediately and invisibly: it fitted the camera match against a *sharpened* render where the renditions fit against an unsharpened one, so the two produced different colour from the same file. `Strengths::before_the_fit` is now the one place that answers what the fit sees.

**Settings cross as one JSON value, `wasm::EditorSpec`.** An editor inlining the shipping defaults for the peak, the anchor and the denoise strengths shows one picture in the viewer and writes a different one to disk for any library whose settings have been moved. The web side builds it from the same settings the server reads.

**The browser decodes nothing, including the preview the match is fitted from.** That was `createImageBitmap` onto an `OffscreenCanvas` once, on the reasoning that the engine has a good JPEG decoder and the alternative was another codec in the module. There was no second codec to avoid: `crate::jpeg` is `jpeg-decoder`, pure Rust and already compiled in, and it is the decoder the server fits against. `fit_camera_match` now takes no arguments and reads the preview out of the RAW itself, which is what `hdr::fit_all` does natively.

**The wasm build is scalar - no `+simd128` - and libblur's wasm kernel is what first put it there.** 0.24 selected a hand-written wasm SIMD stack blur under `target_feature = "simd128"`, and that kernel is wrong: it rounds the accumulator with `f32x4_nearest` and then hands the result straight to `u32x4_pack_trunc_u16x8`, so an IEEE-754 bit pattern is packed as though it were an integer - the SSE kernel beside it converts with `_mm_cvtps_epi32` first, and so do this crate's own wasm `fast_gaussian` kernels, which pair `f32x4_nearest` with `i32x4_trunc_sat_f32x4`. Only the two stack blur passes are missing it. A blurred 148.0 is `0x43140000`, whose low 16 bits are zero, so it stores black. On the fit's own grid the mean fell from 148 to 56 and 47% of the pixels came out black. `pairs` then rejected nearly everything it was handed, the fit found 1,702 usable pairs where `MIN_PAIRS` wants 2,000, and it declined - so **every browser edit graded on the neutral arm**, flatter and less saturated than the rendition beside it, with nothing anywhere reporting a failure. A two-line fork adding the missing `i32x4_trunc_sat_f32x4` fixed it and found 234,075 pairs against the server's 230,969 on the same frame, so the bug is understood rather than merely avoided.

The fork is not what ships, because the flag it rescues turns out to be worth nothing: interleaved runs put the drag at a median of 106 and 137ms with `+simd128` and 107 and 113ms without, which is one machine's noise and no more (see below for why so little of the module is flag-gated in the first place). Carrying a submodule and a `[patch.crates-io]` to keep a free flag safe is a bad trade, so `build:wasm` asks for `+atomics,+bulk-memory` and stops there.

The flag is safe to turn on now: the fit's blur is `fit_grids.slang`, so there is no libblur in the crate for a wasm kernel to be wrong in. The guard that caught it - the e2e assertion that the browser reports `camera match` rather than `neutral` - is still the only thing that would, since nothing native runs the wasm build.

### 21.1.1 What SIMD is actually doing here, which is less than the flag suggests

Toggling `+simd128` moves neither settle nor drag, and the reason is not that SIMD is idle - it is that the flag governs almost nothing that runs per tick:

- **`fast_image_resize` ignores it.** Its wasm kernels are `#[target_feature(enable = "simd128")]` per function and its `has_simd128()` returns a hardcoded `true` on wasm32, so the resize is vectorised whether or not the flag is set. It is also the only vectorised code in the module: 14,306 of the 14,306 SIMD instructions in the shipped `.wasm`, all of them still there in the scalar build.
- **libblur was flag-gated** (`cfg(all(target_arch = "wasm32", target_feature = "simd128"))`) and ran once per open, inside the fit, so it never showed up in a per-tick figure either way - and its flag-gated path was the broken one above. The fit's blur is `fit_grids.slang` now, so neither the breakage nor the count survives.
- **LibRaw, libaom and libavif are not vectorised at all**, and deliberately - a deliberate choice of the wasi-sdk build. Enabling `-msimd128` across the three raises the count to 465k and makes everything 30-130% slower, the still route's pure-Rust drag included, because the module grows 2MB and the engine's cost for that exceeds what the lanes save.
- **Our own grade is scalar Rust** that LLVM does not appear to vectorise - but see below, because it is not where the time goes either.

**A settle is a second of `image::finish` and very little else.** Timed inside `grade_from` at the default 3840 edge, a 2566x3840 frame in Chromium, two samples each:

| stage | ms | what it is |
| --- | --- | --- |
| copy | 3-5 | the prepared frame into the working buffer |
| grade | 118-146 | `tone::grade`, the exposure and the fitted camera curve |
| pq | 6-15 | `tone::encode_pq`, a LUT and a lookup |
| finish | **837-1035** | `image::finish` - denoise, defringe, sharpen |
| emit | 106-190 / 146-189 / 617-798 | pack for a track / PNG / AVIF |

So the still route's 1.2s and the rewrap route's 1.7s are 80% and 60% one function, and the grade proper is a tenth of either. `finish` is not slow through carelessness - it is already rayon-parallel throughout - it is five guided-filter passes plus a Richardson-Lucy deconvolution over three f32 planes of 9.8M pixels, each allocating its own. Optimising the arithmetic of the grade, or vectorising it, addresses the 130ms.

Two directions, neither taken yet and neither small: cut what `finish` costs (fewer passes, reused buffers, or the whole-frame `measure_defocus` reused across ticks instead of re-measured), or stop paying it per tick - emit the graded frame as soon as it exists and the finished one behind it, which leaves the resting picture identical and roughly quarters the perceived latency, at the price of two encodes per settle. The second is a change to the editor's contract rather than an optimisation, which is why it is written down here rather than done.

**There is no AVX to reach for, in any browser.** WebAssembly SIMD is 128-bit `v128` and nothing else; the 256-bit AVX intrinsics Emscripten documents are emulated as two 128-bit operations, which is source compatibility rather than width, and the proposal for genuinely wider vectors (flexible vectors) is unshipped everywhere. The one step up is relaxed SIMD - still 128-bit, mostly FMA and relaxed lane ops - and it is unavailable to us twice over: Safari does not support it (Chrome 114+, Firefox 146+), and Safari is a blessed platform, so the module would be refused outright there rather than degraded. Measured anyway: building with `+relaxed-simd` emits *zero* relaxed instructions and leaves the SIMD count byte-identical, so there is nothing in this module for it to improve.

### 21.1.2 The merge page draws through the stage's own pipeline, not a second one

The take-best-parts merge page (§18.3.5) draws a picture that is not being edited in the sense above -
nobody is dragging an exposure slider - but the rule against a second implementation applies to it exactly,
because what it draws is a photograph leaving this pipeline through a route other than a stored rendition.

**Every preview on the page, a hover or a pick, is `paintExtended`'s own pipeline with one addition: a
mask.** `stage.slang`'s `stage_light` is the whole of what turns a decoded plane into a canvas pixel - the
planes read, PQ taken back to nits, rolled into the display's headroom, rotated onto the canvas's primaries
- and it is called once, from both `planar` and `planar_masked`, so a masked draw is the same picture with
an alpha rather than a second copy of that arithmetic. `paintMasked` (`stage_gpu.ts`) draws the base layer
opaque, then each source a tile currently picks blended over it, its alpha sampled from an 8-bit mask
`merge_mask.ts` rasterises from the tile outlines on an offscreen 2D canvas - fine for a mask, where it
would not be for the picture itself. Hovering a swatch and clicking it call the identical draw, so the two
look the same on screen and differ only in whether the choice survives the pointer leaving.

**One render pass, one submit, and every plane copied out before the canvas is touched.** A composite cannot
be spread over several frames: `VideoFrame.copyTo` answers a task or more later, a canvas texture is presented
at the end of the frame it was drawn in, and the next one comes back cleared - so a base drawn in one frame
and its layers in the next would blend onto a texture the compositor had already taken, leaving the picture
around the tile black. Each layer therefore carries a uniform buffer of its own, `writeBuffer` being a queue
operation that one shared buffer would have every pass read the last write of.

**The pictures never leave the extended-range path.** The canvas is configured exactly as the viewer's own -
`rgba16float`, `toneMapping: extended` - and every layer is a `VideoFrame` decoded the way an HDR rendition
is, so nothing here goes through `createImageBitmap` and the SDR tone map it applies before any canvas sees
the picture.

**What stays out of the browser is a masked, feathered, multi-layer composite of its own** - the band split
that hides a residual seam and the per-source weight that decides how far a feather reaches - which is
exactly the kind of second answer this pipeline has already lost to drift, twice, silently (§21.1). There is
no AVIF decoder in an editor wasm build and no compute pipeline in `web/src` to run one through, so a masked
*draw* of layers already decoded for the canvas is the whole of what the browser is trusted to do here; the
render that actually blends the bands and the weights runs once, in the one native crate, on the server.

**A pick that stands still for 400ms is asked for as a render**, and the server's own picture of it
replaces the masked draw in place. The masked draw is what a hover and a click show at once, because
a render is most of a second; the render is what answers "is this what Save writes", because it is
that picture at the layers' size. Each is keyed by what it draws (`pictureKeyOf`), so stepping back
to a pick already seen is the file rather than a second render of it, and every one is reaped with
the draft it sits beside.

**Save** posts the finished recipe straight to the route that commits or updates the photograph
(§18.3.5).

### 21.2 Three engines, three routes

How a graded frame reaches the compositor is the only thing that differs per browser, and every branch is a measurement rather than a preference:

- **Chromium, anywhere: a video track.** It accepts a 10-bit `VideoFrame` and composites a PQ track. Also the cheapest route there is - no encode, no blob, no decode, just planes handed to a sink. Where the track is *created* is itself forced: Chromium's `MediaStreamTrackGenerator` is a track, and a track is neither transferable nor cloneable, so it is built on the main thread and fed from the worker; Safari's standard `VideoTrackGenerator` exists only in a worker and hands a track back. Two paths, no way to unify them.
- **Safari on macOS and iOS: a PNG per tick.** WebKit validates `I420` and `NV12` alone, so a track there is 8 bits, and Apple's guidance for the layer behind a `MediaStream` is that sample buffers need 10 or more to reach EDR - the PQ tag is accepted and then tone-mapped, which on an XDR panel is a washed-out picture. A PNG goes through Core Graphics, which reads CICP and has no bit-depth floor, and carries 16 bits at 4:4:4. The better frame, the worse drag: measured at 9fps against 12, and 1.4GB resident against 841MB.
- **Firefox: a 12-bit AV1 per tick, rewrapped as an MP4.** Gecko composites HDR through video and only video, and every in-page route to a video frame is capped at 8 bits - which it then will not composite either. So the frame is encoded properly and handed over in the container Gecko will take. See below.

The route is forced from a `?route=` query param (e2e only), which is how any two of them get compared on one machine. The viewer itself has no route picker.

**The still route's memory is the browser's, and no page can get it back.** A URL per tick is a decode per tick, and Chromium holds those in `cc::ImageDecodeCache` outside the JS heap: a six-second drag at 1920 adds ~500MB that a forced major GC does not touch. It is a cache rather than a leak - four drags grow it 1.5x, and a critical memory-pressure notification returns ~330MB - but every lever that returns it belongs to the browser. Measured and all within noise: revoking sooner, reusing one `Image` (the cache is keyed by URL and there is a new one each tick), blanking the decoded element's `src`, freezing the page. The pressure notification is DevTools protocol only, and the API that would have exposed it to a page is an archived WICG proposal. Explicit lifetimes exist exactly once, on `ImageDecoder` and `close()` - which decodes to a `VideoFrame`, so it is the route this one is the fallback for.

### 21.3 Firefox: the encoder moves into the module

The rewrap that serves Firefox its *renditions* (§10.7.2) works because the AV1 already exists inside the AVIF and only the container changes. **A live edit has nothing to rewrap**, so it has to make one.

Not with WebCodecs. Its input is a `VideoFrame`, which Gecko accepts as 8-bit `I420` or `NV12` and nothing else, so the depth ceiling is in the *frame* type rather than the codec - VP9 profile 2 and HEVC are shut out by the same wall. And 8 bits would not have been enough anyway: an 8-bit PQ AV1 in an MP4, correctly tagged, does not composite as HDR on 153/Windows, measured against a 10-bit control of the same frame on the same page and the same panel. The 10-bit one lights the display and the 8-bit one does not.

So the encoder is **libaom, compiled into the wasm module**, taking the graded samples directly and never passing through a `VideoFrame`. rav1e was the obvious candidate - pure Rust, smaller - and is the wrong one: it would be a *second* AV1 encoder with its own colour handling to keep in step with the first, which is the divergence §21.1 exists to prevent. libaom keeps the promise that the frame in the viewer is the frame the library writes, because it is literally `avif::encode_still` under the CICP a rendition uses. The page then hands the AVIF to `avifToMp4` - the same rewrap the photo view uses on stored renditions, so there is one implementation of the container trick and not one per caller.

Two settings are the editor's own rather than the library's, because a frame that lives for one slider tick and never reaches a disk is not a size decision: fastest speed, and a quantizer low enough to judge on. Chroma is forced to 4:2:0 whatever `sdr_full_chroma` says, since Firefox decodes 4:4:4 AV1 in software and then declines to composite it in HDR (§10.7).

**It builds with wasi-sdk, not emscripten** (the wasm library build), which is what makes it a static archive that links into an ordinary `wasm32-unknown-unknown` cdylib with wasm-bindgen still owning the boundary - the same route LibRaw already took. `AOM_TARGET_CPU=generic` drops every x86 and NEON path, and the C fallbacks are complete. It is built single-threaded: libaom would otherwise call `pthread_create`, which under wasip1-threads wants a `wasi_thread_spawn` import no browser provides, and this module's threads come from wasm-bindgen-rayon. What is lost is tile threading on a frame the grade has already parallelised into.

Two things in that build are silent when wrong and cost an afternoon each. libaom signals codec errors with `setjmp`/`longjmp`, which on wasm lowers onto exception handling: it needs `-mllvm -wasm-enable-sjlj`, it must link wasi-libc's `libsetjmp.a` or the runtime calls become imports from an `env` module that **the link still accepts**, and it has to use the same non-legacy EH encoding as the prebuilt libc++abi or the browser refuses the whole module. And `find_package(libsharpyuv QUIET)` finds the *host's* copy and links an x86 archive into a wasm one, so the build script asserts no archive references it.

**The cost, measured.** The module goes from 2.87MB to 6.72MB, and 896KB to 2.08MB gzipped - it more than doubles. Tolerable only because the module is fetched by the editor's worker and nothing else, so no one browsing photos pays for it. On a 9.9MP frame in Chromium, against the PNG route on the same machine and the same file: a drag tick costs 119ms against 88ms, a settle 1.4s against 1.05s, and both deliver 7-8fps. The encode is therefore *not* what limits the drag on either route; swapping a fresh blob into an element each tick is.

### 21.4 Where the state lives

`EditStore` holds what every tool reads - the document, its revision, undo and save - and `StageStore`, `CropStore`, `KeystoneStore`, `RepairStore` and `LoupeStore` hold their own, each taking a one-way reference to the peers it reads. A presenter per domain is the only writer of its store, and `RawEditPresenter` owns the worker, the track and every object URL. They are constructed when edit mode or the viewer's print mockup is entered on the photo detail page, and torn down when it is left or the photo changes - never for an ordinary viewer visit - rather than in the app's provider (§18.2), because the presenter owns a worker and a few hundred MB of wasm heap. A new route rebuilds them, since the route is fixed at decode.

A drag emits far more pointer positions than the grade can serve, so requests **coalesce rather than queue**: only the latest position is ever outstanding, and queueing them would replay the drag in slow motion after the user let go.

What the stage is proofed as is one choice, the `Soft proof` menu in the header - in the editor
between the zoom and the overflow menu, in the viewer between the triage buttons and the
filmstrip. Rec.2020 PQ HDR is the default and is withheld from a rendition with no HDR in it; sRGB
is always offered and is what an SDR rendition already shows; the two printed media proofs need
the original. Choosing one adds its panels under the edit panels: sRGB the highlights operator,
`Printed media` the paper, `Printed media (3D)` the paper, lighting and orientation. The editor
sends sRGB to the worker as an output and an operator, and the module fits the frame's highlights
into sRGB white with the same operators a print uses (`print_tone.slang`). The viewer has no
module, so an HDR rendition proofed as sRGB is fitted in `stage.slang` on the client, against the
rendition's own headroom; a print proof from the viewer opens the photograph's `/mockup`, which
builds the editor's session for it and saves nothing, and choosing an HDR or sRGB proof there or
pressing Escape returns to the photograph.

Print mode holds its paper, lighting and orientation in a separate `PrintStore`, written by
`PrintPresenter`. These are viewing settings and leave the photo document and its history alone.
`Printed media` is the flat proof: the pigment the print grade arrives at drawn as paper
reflectance under diffuse white, straight onto the ordinary stage (`fs_print_flat`), with no sheet,
room or light to integrate, so it costs what the ordinary grade does and every editing tool works
over it. `Printed media (3D)` draws a suspended sheet with the same worker and HDR canvas through
the shared Slang renderer, and closes the tools that draw over the photograph. The photo
is graded to a bounded print reflectance before illumination, with smooth chroma compression
into the generic sRGB paper gamut that preserves luminance and neutral whites. Highlights past
what paper can hold are fitted into it by one of three operators the paper panel selects. Neutral
rolls the max channel off from a knee under white, so ratios and hue survive. Filmic is a film
stock over the whole range - grey held, the scene's peak landed on paper white, a contrast of 1.4
between a toe and a shoulder - and bleaches towards luminance through the shoulder. Per channel
clips each channel at paper white with no shoulder, the way a printer driver meets its ink limit.
By region dodges: the edge-aware neighbourhood the presence sliders read says how bright each
region is, regions over a stop under white are brought down along a curve that lands the frame's
own top on white, and a shoulder then takes what their detail carries past it. The three curves
are one mapping over the frame, and one that holds grey has about half a stop of paper for the
three stops a daylight frame keeps over its white - diffuse white is the 90th percentile by
default, so that is a tenth of the picture. Dodging spends the compression between regions
rather than inside them, which is what keeps a sky's texture. Every operator is handed the light
before any roll-off, the neutral arm included, whose own roll into the display is the neutral
operator's job here.
**Each has to differ on a photograph whose highlights are simply blown**, because that is the
photograph a reader picks to compare them, and a blown highlight is neutral - every channel clipped
alike. Operators that differ only in what they do to a highlight's *colour* above the knee were
pixel-identical there: the same curve on three equal numbers is the same curve. Measured under a
blown patch, the same tone reads 118 nits neutral, 106 filmic and 131 per channel.
Surface reflections can exceed diffuse white. Dragging or arrow keys rotate the sheet, the wheel
lengthens the camera's focal length about whatever sits under the pointer and the middle button
drags the view across, and Home or a double-click puts all three back. Zoom is the focal length
rather than a scale on the drawn canvas, so a print seen closer is a print seen closer: the
perspective narrows and the sheen moves with it, where scaling the canvas would only enlarge the
same picture. The camera fits the sheet's own outline to the canvas, so a landscape sheet fills a
landscape canvas as far as a portrait one does; fitted to the long edge alone it lay along the
canvas's long edge and covered half the frame. The panel controls the material and the light, and
every slider carries the editor's reset arrow and double-click back to its rest - for a paper
control, the chosen paper's own value, which is also what choosing a paper puts every material
control back to. The mockup is the viewer's own screen, so a sidebar the viewer hides stays hidden
under it.
The camera rays intersect a slightly bowed sheet, lit by a finite softbox whose illuminance is specified at
the print centre facing the light. Its diffuser has a smooth spatial radiance profile, shared by
light samples and reflected rays. Surface reflection uses dielectric Fresnel and GGX; its
GPU-tabulated directional albedo couples it to the diffuse body through the reciprocal
[OpenPBR glossy-diffuse model](https://academysoftwarefoundation.github.io/OpenPBR/).
This conserves reflected energy while approximating scattering inside the paper. Surface
texture varies roughness in paper coordinates, with its physical scale set by the print's
long edge and its visible detail filtered against the camera-ray footprint.
The ambient light is a room rather than a surround of one radiance: its ceiling and the luminaires
in it carry the light, and the wall opposite, the floor and the reader in front of the print sit at
a fifth of that. The ambient setting is the illuminance an upright print stands in, and the
room is scaled to deliver exactly that, so the shape above only decides which direction it arrives
from. A sheen is then a reflection of the room and follows what the sheet is turned towards: the
wall, or the ceiling five times brighter. The reader is in that room too, and is a body rather than
a head: a third of a radian across and most of a radian tall, standing on the floor rather than
floating at eye level, so the silhouette hangs below the direction a square-on sheet mirrors into
the eye and reaches half the wall's own radiance. A print faced straight therefore reflects a
silhouette rather than a room and holds its paper's own black, and one tilted down its own height
still has the reader in it where one tilted up does not.
The lamp lights that room as well as the print. What a luminaire throws past a sheet lands on the
floor and the lower walls and comes back up, so the room carries a second, dimmer copy of itself
under the lamp - a tenth of the accent level, and shaped from below where the ambient is shaped from
above. It is modelled apart rather than folded in because a sheet tilted down reads the two in
opposite order, and because it is the whole of the light reaching a print turned away from a lamp in
an unlit room: measured, a sheet turned 30 degrees off a 1000-lux lamp with the ambient at zero
holds a seventh of what it holds facing the lamp, and brightens again as it turns onto the floor.
Both floors are calibrations a reader can see through the
frame's glass, which mirrors whatever the model leaves in those directions: a dim wall and a dark
body multiplied together put a framed print behind a black pane with the lamp's image the only
thing in it. The silhouette washes out as the lobe reading it opens, in the ratio the two solid
angles stand in, so it belongs to gloss and barely to matte. Nothing shadows the diffuse side,
where the same cone is worth under a percent of the illuminance.
The diffuse side reads the same room through zonal harmonics to the second band, which is
all a Lambert cosine keeps of any surround. A surround of one radiance instead puts the whole
room's illuminance in the direction the reader's own reflection comes from, which lifts that black
four times over and leaves every off-axis reflection a flat wash.
Camera exposure meters the room against a sheet hung facing the reader, and never against the pose:
a camera meters a room once, and re-metering as the print is turned holds the sheet at one
brightness while moving everything that did not turn - the background with it - which reads as the
room changing colour under a rotation. Turning a print towards the ceiling gathers more light and
arrives brighter, which is what the HDR headroom above diffuse white is for.
The GPU integrates the finite light against the sheet's orientation, including light crossing
its horizon. One exposure gain applies to the whole scene, anchored to 203-nit diffuse white
and bounded in dark rooms; coating reflections retain their HDR headroom.
The featureless background follows ambient illumination and is black at zero ambient. Defaults
use 500 lux ambient, a 1000-lux light one degree across - a ceiling downlight, near the
sun's half degree - and 6500 K illumination. The lamp is placed by where it hangs rather than by
its angle: across, up and forward from the sheet's centre in print lengths, by default 3.9 up and
1.7 forward, which is over the reader's head rather than over the sheet. Angles alone left the
one question a reader asks of a room light - is it behind me or in front of the picture - with no
control of its own. The source spans a tenth of a degree to ninety, slid
in decades so a lamp and a softbox each get a usable stretch of track. Below about a degree the
highlight stops following the source: the paper's own roughness is wider than the lamp, and the
roughness control is what narrows it from there. The light temperature
uses the same Robertson chromaticity model as white balance. Gloss reflects the room through its
directional Fresnel response, producing a broad sheen at grazing angles.
A framed print stands flat behind 2mm glass, above a mat and inside a moulding that casts its own
shadow. The glass mirrors the room and the lamp twice, once off each of its surfaces, with the
second image offset by the thickness it crossed and refracted on the way - which is what makes it
read as glass rather than as a light painted on the picture. The paper's own sheen reaches the
reader through that glass twice over and under the glass's own reflection of the same room, so
half of what separates satin from gloss goes behind it, the way it does on a wall.
Light also travels the other way and comes back. A tenth of what the mat and the photograph send up
returns off the underside of the pane to be diffused again, and a tenth of that after it, which the
closed form `1/(1 - R·rho)` sums: a framed print is about a tenth brighter than the same print bare,
per channel, so a deep colour behind glass comes back deeper while the mat beside it barely moves.
The pane is not an optical flat, and that is what stops a mirrored lamp reading as a white
quadrilateral someone pasted on: drawn sheet keeps a shallow wave from the line it was rolled on
and a pane in a rebate adds its own bow, a few thousandths of a radian over a hand's width, which
bends the lamp's straight edges into curves. Nor is the pane perfectly clear, so a fourteenth of
what it mirrors leaves within a couple of degrees of the specular direction rather than along it,
as a halo around the image. That halo is the only part of a mirrored lamp whose shape a reader can
see: the core is a hundred times paper white and clips whatever is done to it, and the taper that
would soften the rim falls inside a pixel, so integrating the pixel does not reach it - measured,
four rays across a pixel moved the rim and nothing else, and cost as much as the halo does.
A frame costs about 1.4x an unframed sheet on the scene path, measured at 1920 on radv: a quarter
more canvas to cover, the moulding and mat to intersect, and the glass's own two reflections. What
it no longer costs is the light integration answering for all three surfaces at every pixel - a
pixel shows the photograph or the mat or the moulding, and only the footprint's width between them
needs two - nor a ray-box test against the moulding for each of the emitter's samples, since the
hole is convex and so is the emitter, which makes four corner tests decide it for all of them.
**What the print costs is the emitter's integral, and it is paid per canvas pixel on the desktop
path and per field texel on the touch one.** Four things keep it in proportion. The emitter is
sampled against how much of the sky it covers, from 64 for a lamp to 128 for a softbox, since a
source a degree across hardly varies over its own solid angle. Sampling the lobe as well is dropped
where the emitter is the smaller of the two: balance-weighted MIS is unbiased either way, and the
lobe's strategy finds a one-degree lamp once in a hundred tries for a hundred times the value, which
is variance and not signal - held against a thousand-sample render, the pair costs a third of the
frame and lands closer than the old estimator did.
The third is that those counts are the *specular's*. Under a hundredth of a steradian - a lamp, not
a softbox - every geometric factor is constant across the emitter's face, so the diffuse half of
the same pixel is the diffuser's mean radiance times one cosine, in closed form, at one evaluation
rather than sixty-four. A near softbox varies its own inverse square over its face by a quarter and
pays the full count; so does a penumbra, where the face is what the softness is made of, and the
four corner tests already say which pixels those are. The fourth is that a gloss sheet's specular is
zero wherever the lobe reflected towards the reader misses the lamp by more than its own reach,
which is most of the sheet; the reach is taken to where GGX has fallen a millionth under its peak,
so what it drops sits beneath the last code of an HDR white - measured against a share of the peak
instead, it clips the tail into a step, which the cached lighting field reports before the eye does.
With them a framed gloss sheet costs 56ms a frame at 1920 on radv, and a framed satin one 38ms.
**Half precision is not the next step, and the lobe is why.** WebGPU offers `shader-f16`, but a
gloss paper's alpha squared is 4.1e-5 where fp16's smallest normal is 6.1e-5, and GGX divides by
that square again - so the one term worth the conversion is the one term half cannot hold, and what
is left of the integral is sixteen samples. Ray-tracing cores are not reachable at all: WebGPU has
no ray-tracing API, and the editor and a rendition are one implementation of the same shaders.
And the scene path's canvas is one pixel per
device pixel rather than supersampled, the photograph arriving there through the pyramid's
anisotropic taps and every edge carrying its own subpixel coverage, so the 2.25x bought nothing.
The mockup also opens the photograph at half the sensor where the editor takes all of it: a 61MP
frame is 366MB of samples and 650MB of pyramid to draw a sheet two thousand pixels across, and the
mockup has no loupe to spend it on. The sheet's fragment shaders are also the longest thing here
to compile, and a pipeline is built synchronously on the browser's GPU thread, where it blocks
every page the browser is drawing - so `pipeline_warmth.ts` hands wgpu a stand-in for each one and
builds it at the pass that sets it, leaving an editor open that never shows a print compiling none
of the print's, and compiles whatever recent sessions did draw with asynchronously ahead of wgpu's
device, so the wait is paid once per shader rather than once per open. Nothing in the crate
arranges that: the shim finds every `create…Pipeline` the device offers and every class that takes
one, so a pipeline added tomorrow is covered without being told about.
Edge pixels integrate subpixel coverage of the curved sheet, with denser sampling for thin silhouettes.
The photo uses up to 16 anisotropic taps along the projected footprint, with trilinear mip
sampling in decoded light, so a tilted sheet preserves detail along its less compressed axis.
Touch devices use a surface presentation: the print fills the editor's canvas with its normal
crop, zoom and pan mapping, while device orientation changes material lighting without rotating
the image. Motion permission is requested as the 3D proof opens, inside the click that opened it,
since a browser that gates the sensors only grants them under a user gesture; a control offers the
prompt again where that gesture was spent. Tilt is relative to the device's initial pose, recentres across screen orientation changes,
and stops while the tab is hidden or the 3D proof is left. Without motion access the surface remains
usable with the lighting controls.
Mobile editing controls sit in footer tabs. A tab opens one panel over the photograph without
resizing it, and a tap outside the panel closes it rather than reaching the stage beneath.
During a slider drag the panel fades away and a floating readout keeps the active
slider visible at the same position; its original control keeps pointer capture and commits
the edit on release. Panels support keyboard navigation, Escape and reduced motion.
Gloss, satin and matte are generic simulations. Predicting a specific print requires its
printer, ink and paper colour profile, measured surface reflectance and calibrated viewing conditions.
What sets how far a lamp's highlight spreads across a sheet is its roughness, not its refractive
index: the index sets how strong the coating's reflection is - a twenty-fifth of the light at normal
incidence for the 1.5 every photo coating sits near - and nothing about its width. Satin sits at
0.18, where a one-degree lamp is a soft spot rather than a glow across half the sheet.

### 21.5 Tests

Cross-origin isolation and the thread pool are pinned by e2e, because the module needs `SharedArrayBuffer` and the failure is a silent fall back to one thread. The still route's PQ tagging is asserted on the bytes the browser was handed, over a real graded frame from the ARW fixture: the route is HDR only because of four bytes in a cICP chunk, and a PNG that loses them is a valid, ordinary, SDR picture that every other check downstream would pass.

The rewrap route is asserted the same way and for the same reason - the `colr` box and the `high_bitdepth` bit of the AV1 configuration record, off the MP4 the browser actually received. The bytes are the point rather than the browser: a frame that is not high-bit-depth PQ is wrong without any engine having to refuse it.

**A rendition is twelve-bit now, which is AV1 Professional profile, and this is the route that route is most exposed on.** The rewrap copies the file's own `av1C` verbatim, so it carries whatever the still was written at, and a still decoder taking profile 2 says nothing about a *video* pipeline taking it - which is the one Firefox composites HDR through. Untested here, and the failure would be Firefox showing nothing rather than showing it flat.

This spec is the second one to run under Gecko as well as Chromium, and the only one whose *subject* is an engine - a route that exists for Firefox and is exercised only in Chromium is tested everywhere except where it matters. It confirms the mechanism end to end there: shared memory, the thread pool, LibRaw, libaom and the rewrap. What it cannot confirm is the pixels reaching an HDR compositor, which no automated check can read back on any of the three routes.

## 22. What HDR is for (`/hdr`)

The HDR setting asks the reader to believe something they cannot check from the settings page, so `/hdr` makes the case in photographs: three raw files, each shown twice, with a control that swaps the two **in place**. Side by side, the eye travels between the frames and the difference becomes a matter of opinion; in one place it is simply visible, which is why the page is a toggle rather than a pair.

**It opens on the 8-bit version**, not the HDR one. That is the picture the reader already has, and the page is about what it costs them; opening on the other one asks them to notice an absence, which is the harder direction.

**It never mentions this app**, and that is deliberate rather than an oversight. The argument is about photographs and 8-bit files, holds wherever the reader develops their raws, and is worth more for being checkable against their own experience instead of against a claim by the thing making the claim. So the closing section says what a pair *is* - one raw file developed twice, same settings, different container - and not what produced it, and nothing on the page routes to Settings. The copy is pitched at someone who shoots rather than someone who encodes: it spends stops, clipping and channels, and it does not spend PQ, transfer curves or nits.

**The HDR arm comes out of `runJob`** (`scripts/demo-assets.ts`) at the settings the app ships with - `SettingsSchema.parse({})`, not a table of numbers copied into the script - with only the size changed, 1200px rather than 3840.

**The 8-bit arm is derived from that file rather than asked for as a second target**, and getting this wrong is what the first version of the page did. A library's SDR rendition is *not* the HDR one with its highlights removed: it came off LibRaw's sRGB output, auto-brightened and fitted to the camera's JPEG (§10.8), where the HDR one is a scene-linear decode graded against a quantile (§10.7.1). On a daylight frame those land in nearly the same place. On a night frame they do not - measured on the neon sign, the SDR arm sat at a black level of 0.059 with a red cast where the HDR arm was at 0.003 and neutral, and on the WC sign it was darker everywhere rather than only in the highlights. Both are defensible renderings and neither is a bug. But a page whose entire claim is *the same picture with less room at the top* cannot be built from two pictures that disagree at the bottom, and a reader looking at those pairs correctly reported that the 8-bit one was simply broken.

So the 8-bit arm is now the HDR arm with its ceiling brought down to white: the PQ taken back to light with 203 nits tied to 1.0, everything above that clipped by the sRGB transfer, written out at the quantizer a stored SDR rendition would have used. A clamp and a colour conversion, no second grade - which is exactly what the page says it is showing, and now literally true rather than nearly true.

The cost of the fix is that the page can no longer borrow a difference from the two arms disagreeing. Only content genuinely above white differs now, and three of the original five scenes did not survive it. A moon over some roofs lost **0.0%** of its pixels to the ceiling and a pizzeria sign **0.1%**: they had been showing a difference that was entirely the two grades disagreeing, and with that gone they show nothing at all. A third, an LED-lit still life, kept 6.7% but was replaced for a different reason - a reader with no idea what the room actually looked like cannot tell which of the two versions is the better one, which is a fair complaint about any picture whose subject they cannot check against memory.

**The raw files are the maintainer's own**, read from a path only their machine has, which is why the script does not run on a fresh checkout and does not need to: the renditions are committed - about 845kB for the six, the swatch strip included - and the page serves those. They were CC BY-SA submissions from discuss.pixls.us for as long as the page was illustrated by strangers, which is where the credit line under each picture went when the photographs became the maintainer's.

**The scenes are chosen by measurement, and then by whether the reader can check them.** What most raw files hold above diffuse white is a stop or two, because the photographer metered for the subject and the sensor saturated a little above it, so the frames worth showing are the ones with a light source *in* them. Measured on the encoded renditions:

| | above white | peak | colour recovered |
|---|---|---|---|
| rapids under an overcast sky | 2.4% | 587 nits | 0.00% |
| a sunset over railway tracks | 2.5% | 656 nits | 0.00% |
| lit arches at night | 2.6% | 1460 nits | **1.28%** |

**"Above white" turned out to be the wrong number to choose on, and the third column is the right one.** It counts pixels that are bright and *neutral* in the 8-bit arm while still being a colour in the HDR one - which is the thing the page claims in words and the thing a reader checks by eye. Two pictures chosen on headroom alone were rejected on sight for showing "not much" and "still blown-out red", and they score 0.24% and 0.04% here: the metric agrees with the reader, where the headroom figure did not. The arches score 1.28%, an order of magnitude past anything the licensed candidates managed.

**What it exposes is a property of the grade, not of the photographs.** Screened across eight night, neon and traffic-light frames, *none* recovers more than 0.04%. The BT.2390 roll-off is applied per channel against a shared curve (§10.7.1), so a light source twenty stops above white arrives with all three channels pressed against the ceiling - near-white in the HDR rendition too, just very much brighter. Saturated colour survives where it sits one to three stops above white and not twenty. The arches are in that window and are what the page argues colour with: measured over the pixels the ceiling touches, mean saturation is **0.571 in HDR against 0.186 in eight bits, and 51% of them go neutral** - they are pink in one file and white in the other, which is the whole claim. Making a neon tube twenty stops up come back red as well would need a hue-preserving roll-off in `tone.rs`, a change to what every HDR rendition in the app looks like and not something a page about the app gets to decide.

**Which picture carries which argument is decided by that measurement, not by the subject.** The sunset looks like the colour example and is not one: over its above-white pixels, saturation goes 0.913 to 0.791 and *none* of them go neutral, so the eight-bit version is barely less colourful - what it loses is height, being folded into the top of the range. It is captioned as that. The copy had the two the wrong way round until the numbers were run.

**A sunlit snowfield is the worst case for this grade, which is worth writing down because it reads backwards.** The obvious way to show clipping is a big white subject, so twelve snow and surf frames were measured looking for one. Ten came back at 0.0% above white. The reason is structural rather than bad luck: `HDR_WHITE_QUANTILE` puts diffuse white at the 90th percentile of the frame (§10.7.1), and in a picture that is mostly snow the 90th percentile *is* the snow - so white lands on the subject and there is nothing left above it. The one that worked is a sunset, where the snow is in shadow and the sun is not.

The second test is the one measurement cannot make. A picture only argues if the reader knows what the subject is meant to look like: a beer held up to the light, a traffic light, a neon tube. A room lit by two LED panels fails it however much headroom it has, because nothing in the reader's memory says which of the two versions is right.

**In Safari, an HDR image inside a scrolling element has to be promoted to its own layer or it is not HDR.** WebKit gives a scroller one shared backing store and that store is SDR, so a PQ image drawn into it composites flat. `will-change: opacity` is enough to take the image out of it.

This cost a day to find, and every wrong turn on the way is instructive about how the failure hides. The strip was flat in Safari and bright in Chromium, so it looked like the file: it was the one asset on the page tagged 1/16/1 at 4:4:4 rather than 9/16/9 at 4:2:0, which is a genuine problem and was worth fixing on its own, and fixing it changed nothing. It was bright in Reader mode, which is the page's CSS being stripped, so it looked like the stylesheet - and an audit for the filter/transform/opacity rule below came back clean, because that rule was not the one being broken. A bare probe page reproduced *none* of it: file, markup, `clli`, scaling, layer promotion, all bright. What finally isolated it was moving the `<img>` up the tree on the real page until it came good, which put it exactly at `.content`, and then killing one declaration.

**The photographs on the same page never showed it**, which is what made it look like a property of the strip. `.compare__layer` carries `will-change: opacity` already, for the unrelated reason that the swap has to be repaint-free, and that promotion happens to lift them clear of the scroller. So the app had been relying on an accident.

**The swap is an opacity change on two mounted, decoded frames**, which is the stack triage flip (§20.4) and works for the same reason: `will-change: opacity` keeps the hidden one rasterised, so a press costs no repaint. Nothing on that subtree or above it may carry a filter, a transform or a partial opacity - any of those rasterises into an SDR intermediate and loses the PQ tagging silently (§10.7). That constraint is also why the reading column is left-aligned rather than centred, in passing: `.pad`'s first child reserves an inline gap for the collapsed sidebar's floating button, and a centred column would carry that indent on the heading and nowhere else.

The Firefox rewrap is the photo view's, through `useHdrVideo`. Three of them mount at once here, so that engine holds three MP4s resident where the photo view holds one - a few hundred kilobytes, and the alternative is rewrapping on every press. The swatch strip does not take that path at all, being 4:4:4.

**The swatch strips are the only synthetic thing on the page**, and they exist because every photograph below them assumes an answer to a question the reader has not been given: what "brighter" means once white is no longer the top. Five colours, each starting as bright as 8 bits can render it, each row then going as bright as its own format can manage. They are losslessly quantised, since flat colour has no detail to trade away.

**The strip is tagged and subsampled exactly like a rendition - 9/16/9, 4:2:0 - and was not.** It was 4:4:4 at **1/16/1**, Rec.709 primaries with a PQ transfer, which dodged the gamut conversion and rendered correctly in Chromium. Neither half of that is a combination another engine has reason to expect: 4:4:4 is the one thing Firefox will not composite in HDR (§10.7), and 709-with-PQ is not a colour space anything ships a path for. A reader on Safari saw the HDR half come out better than the 8-bit half but not *bright*, and saw it come good in Reader mode - which is the page's own CSS being stripped, so it may yet be page-side, but a file that is the only one of its kind on the page is the first variable to remove.

Two details in doing it. The **conversion to Rec.2020 happens in the script rather than in zimg**, so the samples can be scaled by `1/max` afterwards and diffuse white still lands on 1.0; the conversion pulls a saturated Rec.709 red to 0.65 of full scale and would otherwise put the first patch at 130 nits. And the **8-bit half is clipped before the conversion, not after**, because the clip is the thing being demonstrated and it is an *sRGB* clip. Clipping in the wide space walks the reds to a khaki and the blues to a grey-green, which is not what any JPEG has ever done - it was drawn that way for one build and it looked precisely as wrong as it sounds.

**All three channels scale together, and the two attempts to avoid that are worth recording** because both looked like improvements. The HDR row reads as getting lighter along its length, which invites holding the two minor channels and raising the dominant one alone: the row then deepens instead of lightening, and side by side the two strips stop looking like the same move at different speeds.

It is wrong twice over. It flattens the 8-bit arm to five identical patches, since that arm goes pale *because* those channels are rising underneath a dominant one that has already stopped - so the arms have to be authored separately, which they then were. And measured across the row it moves the hue: **orange from 24 degrees to 5, red in all but name, and blue from 212 to 235**. A strip captioned "the same colour, brighter" cannot be turning one colour into another, and trading a lightness error for a hue error is not a fix.

Scaling the triple is the only construction that means what the caption says. It leaves chromaticity alone, so hue and saturation are both held exactly - measured across a row, 24.2 to 24.2 degrees and 0.97 saturation on the orange, while the light goes 198 to 974 nits. The row does look lighter, because more light is what it has; the caption now says that and points at what the 8-bit arm spends to get the same climb.

**Both halves are in one PQ file, and that is what makes the comparison survive an ordinary screen.** Three rounds of complaint about the HDR strip - lighter, then dark on the left, then dimmer in the first column than the 8-bit one - all traced to the same measurement rather than to the samples. **A standard-range browser renders a PQ file by fixing its own white at about 406 nits.** Probed off the canvas and off a screenshot alike, a patch sitting exactly on diffuse white paints at 187 where an sRGB white paints 255, and nothing in the file moves it: `clli` makes no difference, and a flat 203-nit image with nothing above white at all still comes out at 187.

So an sRGB image shown next to a PQ one is painted about a quarter brighter than it on the majority of screens, for a reason the page is not arguing - and that holds whether the two are side by side or swapped in place, since either way the reader is comparing a tone-mapped picture against an untouched one. Two files could not have fixed it.

One file can. The left half is the same colours with every channel clamped at white and the right half is those numbers left alone, so whatever the screen does to one half it does to the other and what is left is the comparison. Measured on the composited page, the first patch of each half now paints identically at `187,48,44`, where the last pair reads `188,107,99` against `255,81,74` - the same brightness gone pale on the left, more brightness with the colour intact on the right. On a real HDR screen the left half simply cannot exceed diffuse white, which states the argument as a brightness rather than as a caption.

The photographs never showed any of this, because a swap never puts two pictures next to each other. It is worth knowing anyway: it is what an SDR viewer sees of *every* HDR rendition this app writes, and it is why the notice at the top of the page is worded the way it is.

**The stops chart above them started as folklore and took three attempts to source.** "About 8 stops for a JPEG, about 15 for 10-bit" is what it said until a reader asked where those came from, which was nowhere.

*Measuring the code values* was the first answer and made the threshold the author's choice: how far down before the gap between adjacent values exceeds 5% gives 6.0 and 14.6, 2% gives 2.8 and 10.3, and 1% - about the Weber limit, and roughly what PQ was designed against - gives **0.4 and 3.9**. That last pair is true and useless on a chart. A photograph is not a smooth gradient and its own grain dithers away the banding the criterion is hunting for, so quantisation belongs in a sentence rather than in the length of a bar.

*Quoting each format's specification* was the second and was wrong in both directions at once. sRGB's 80:1 is its reference *viewing environment* from 1999 - a CRT in a lit office, ambient flare included - and describes no panel anyone owns; it gave the JPEG 6.3 stops, which is far too mean. HDR10's 1000 nits over 0.005 is a mastering reference met by an OLED in a dark room; it gave 17.6, which is far too generous for the LCD most readers are on.

*What the hardware can actually show* was the third, and it was answering a different question from the one the label asked: a bar reading "An 8-bit JPEG" that says 10 stops because a monitor is 1000:1 is a fact about the monitor.

**So each file gets its format's own range with the screens indented beneath it** as subsets. sRGB encodes codes 1 to 255, which is 11.7 stops; PQ at 10 bits encodes 0.0001 to 10,000 nits, which is 27.9. Under each sit an OLED in a dark room, a MacBook Pro XDR, and an LCD in a lit one.

**A screen row is what a reader can see, so it cannot run past the eye row**, whatever the panel can physically do. Two versions of these rows did exactly that - one had an OLED at 25.2 stops under a 20-stop pair of eyes - which is nonsense on a chart whose whole subject is what reaches a person.

**The two HDR panels differ at the bottom and not the top.** Both peak near 1600 nits on the small bright areas a photograph actually puts there. An OLED switches its pixels off, so nothing about the panel stops you and the eye does, at -14. A mini-LED cannot: the XDR blooms, and its **1,000,000:1 is a full-field-black figure describing nothing anyone will ever look at** - with bright content on screen the local floor is nearer 0.05 nits, which is -12. Believing the spec sheet puts the XDR at -14 as well and draws the two identical, which was the second mistake and the mirror of the first, where both were handed the same 0.005 and the OLED lost the one thing it is for.

The rows under the JPEG are the reason this is worth drawing four times. **Two of them are identical to the format bar above them**, because either HDR screen outruns sRGB by several stops and so the thing limiting a JPEG there is the JPEG. The HDR file is the other way round on every screen: 27.9 encodable against 17 seen on the OLED, 15 on the XDR and 10.2 on the LCD, because there the panel and then the eye run out long before the file does. Neither fact is visible when a bar carries one number.

**A JPEG's headroom is 0.2 stops rather than none**, which the bar now shows as a sliver past the line rather than stopping dead on it. A camera puts diffuse white around code 240 and not 255, leaving the last 15 codes for specular glints: `log2(linear(255)/linear(240))` is 0.20, and placing white at 235 or 245 gives 0.27 or 0.13. The page kept saying a JPEG has *nothing* above white and it nearly does, but 0.2 against the HDR file's 2.3 makes the point better than a wrong zero would.

**The stretch above white is hatched, and the white tick is drawn heavy and over the bars.** Without it that stretch is just more bar, when it is the only stretch any of this is about; the chart is a statement about which side of one line things fall on, so that line is the thing to draw.

**Which leaves the chart saying something better than "HDR is bigger".** The formats are not far apart in total once both are read honestly, and on the screen most people own they are within a stop or two of each other. What separates them is entirely on one side of one line: the JPEG's headroom is 0.2 stops and the HDR file's is 2.3, on every row. The other two bars stay approximations: a full-frame sensor's engineering dynamic range at base ISO, and the eye across one scene with the gaze moving.

**It costs 845kB in every desktop and Android build**, since `public/` is copied into `web/dist` and that is `frontendDist`. Accepted rather than overlooked: the renditions are the page, halving them would show as encoder artefacts in exactly the highlights being argued about, and lazy-loading buys nothing for a reader who scrolls to the bottom.

`(dynamic-range: high)` decides whether to say the display is SDR, and the copy hedges rather than hiding anything: Firefox answers `standard` on an HDR display. On an SDR one the colour losses still show - a clipped neon tube is white there too - and only the brightness ones are lost, which is what the notice says.
