# Bowerbird design: Editing in the browser, and HDR

A chapter of [`DESIGN.md`](../../DESIGN.md), numbered with the other chapters as one document.
`DESIGN §N` anywhere in the repo, or a nonlocal `§N` here, refers to the section indexed in `DESIGN.md`.

---

## 21. Editing in the browser

The editor opens the RAW in the page - in any browser with WebGPU, and in the desktop shell's own
webview, which is why the shell has no decode path of its own - and grades per tick on the GPU
through the rendition's own shaders. `rawshim` builds for `wasm32-unknown-unknown` as pure Rust
with no C linked, which `tests/wasm_build.rs` is the host-side half of. The module runs on the
app's GPU thread (`web/src/gpu/gpu_thread.ts`), one worker for the life of the page holding the
one device everything draws with. wgpu cannot adopt a `GPUDevice` from JS, so the module requests
its own (`gpu::page_device`) and the page hands over canvases (`transferControlToOffscreen`) for it
to draw on. **`docs/gpu-editor.md` describes the runtime.**

Edit, in the photo viewer, replaces the metadata strip with the edit panels and the stage with the live grade. On desktop the panels sit under a bar of icon tabs, one per category, labelled under the icon: Tone (Tone, White balance and Colour), Detail (Detail, Effects and Dust removal), Retouch (Reflection removal, §10.9.4) and Geometry. A panel's heading collapses it, remembered across opens; a phone's sheet keeps one tab per panel. One RAW is decoded once and then graded per slider tick, entirely client side: the module decodes the RAW and its embedded preview, fits the camera match and opens the frame (`edit.rs`), and each tick is `gpu::present`, a uniform write, one pass and a present onto the handed-over canvas. A tick sends the worker a region and a set of edits and no pixels, there is no server in the loop below the fetch, and the browser contributes nothing to the picture.

The Tone panel has exposure, contrast, highlights, shadows, whites, blacks, and a tone curve. Exposure sets the global level, starting at the camera's value anchored to middle grey. The basic sliders act first. The curve changes contrast within the photo; the camera's starting curve has a knot at exposed middle grey. It maps luma through a monotone cubic and carries the change to colour as a ratio so hue stays fixed. Its horizontal axis puts diffuse white at the middle and 3 stops above white at the right edge. [§10.8.1](rendering.md#1081-the-same-look-in-hdr-hdr_fitrs) defines the stored curve shape and interpolation. The camera match writes its exposure, saturation, curve and white balance as the photo's first edits, from the first render that fits it or the editor's open, adding no undo step. The white balance is the temperature and tint that pull the frame's greys onto the camera's, written as a Custom pair, or As Shot where the match pulled none. A merged photo gets them beside the crop its merge wrote. It never writes into edits a person or a sidecar made, and those render as written: an exposure of 0 is 0. Once written they are ordinary edits: each reset goes to 0, a straight curve or As Shot, and **Reset edits to camera match** in the overflow menu measures the photo again, reopening it with its stored analysis dropped, and writes the new match's four and the Matched profile back. **Reset all edits** there, and under the viewer's Edits panel, sets the whole document to neutral. The Colour profile choice leaves all four where they are: None drops only the match's residual colour.

The Colour panel's colour wheel edits colours one at a time ([§10.8.2](rendering.md#1082-the-readers-colour-edits-latticecolournode)), on top of the profile. Hue runs around it and chroma out to its rim, drawn in HDR at one of five lightness channels (ZCAM lightness 10, 30, 55, 80 and 110) or All, which edits every lightness at once. The channels are round swatches, each the grey of its lightness, with All a ramp across them, set first and apart from the rest and chosen when the editor opens; up to three dots under a channel mark the edits it holds that move colour furthest (ZCAM distance from source to output), each the colour the edit reads, scaled until its brightest component is diffuse white (`colour_wheel::swatch`), so a shadow's still shows its hue. A tap or click on the wheel adds an edit there, at the colour it selected, moving nothing yet; with an edit selected, it lets go of the edit instead. A drag across the wheel adds nothing; on a phone it scrolls the edit sheet unless it starts on an edit or one of its handles, as one on the tone curve does unless it starts on a point or the curve. Browsers ignore `touch-action` on SVG shapes, so a drag holds the sheet still by cancelling its `touchmove` (`ui/hold_scroll.ts`). An edit's outer saturation edge stays on the wheel: dragging the edit towards the rim narrows its saturation range to fit, and widens it back to where the drag began as the edit comes away, and the saturation handle stops at the rim. The selected edit darkens the wheel by up to 80%, less wherever it reaches, by the weight `lattice_bake.slang` gives a colour there (`kernel_reach.slang`, shared with the backdrop). It shows its reach as an outline and an arrow to the output colour, a ring the arrowhead stops short of with the output colour itself drawn undarkened inside it; dragging the edit moves the colour it reads and leaves the output where it is, dragging the ring moves the output, a double press on the ring puts the output back on the hue and saturation the edit reads, keeping its lightness, and two-way arrows on the outline set the reach by drag or arrow keys, one halfway along each hue edge (a single one once the reach is a full circle) and one at the chroma edge. On a phone each grab area is about three times as wide, and a drag hides the edit sheet, as a slider's does, leaving the photo under only the dragged edit, its outlines, its output and the wheel's colours inside its reach, at half opacity as a dragged slider is. While the edit itself is dragged, the stage takes each pixel towards black by how much the edit does not reach it, by the same weight read where the edit keys the pixel (`reach_kept` in `colour.slang`, applied after the grade in `frame.slang`'s `fs` so the peak pass never sees it); the mask fades in and out over 100ms (`stage/fade.ts`). Dragging the ring or a reach handle draws the photo as it is. A touch on a slider starts it only once it moves sideways past 10px or rests on the knob for a quarter second (`ui/touch_drag.ts`), so a swipe down the sheet scrolls it even from a knob. Starting a slider or a wheel drag vibrates briefly where the device can. Under the wheel, a lightness range slider (on the five channels, not All) sits above output hue, saturation and lightness, which set the same output as the ring. Behind the edits, the wheel can show a few thousand of the photo's own pixels at the channel as faint dots, where edits read them, and the profile's strongest push in each twelfth of the hue circle as an arrow, dropping any under a fifth of the strongest or shorter than twice its head; each is off until turned on from the wheel's options menu. The profile is read at 45%, 65% and 85% of the way out to the display's edge at each hue and lightness, so every arrow starts on a colour the display shows. A dashed outline marks that edge at the channel's lightness, Display P3 under its peak, and for All the widest of the five; it is on until turned off from the same menu.

**The grade stays exact.** Every tick, a drag's included, draws with the rendition's transform and library settings at the stage's resolution (`stage_resolution.ts`). Spend resolution, never tone or colour accuracy: a cheaper curve would show a different picture.

### 21.1 One pipeline, two entry points

A rendition and the editor open a photograph through the same code (`open::measure`) and draw it through the same `gpu.rs` passes. A job is an open, one tick and an encode; the editor is the open (`edit.rs`) and then a tick per slider move. What differs between the two callers is `open::Opening`, and it is three things: a rendition may decline the camera match, the two fit it from different sources (`Fitting`), and a job brings its own strengths.

**A second implementation of one picture drifts silently.** A camera match fitted against a different frame, or reduced through a kernel that is wrong on one target only, still grades a plausible HDR frame at the right size, just flatter and less saturated than the rendition of the same file, and nothing reports a failure. So both hosts fit the match against the same frame, `Strengths::before_the_fit` defining what the fit sees, on the same fit grids, a shader (`fit_grids.slang`); the GPU tick is pinned against fixtures; and a CPU arm for a stage that has a shader is refused outright. Nothing native runs the wasm build, so the e2e assertion that the editor reports the camera match (`data-matched` in `editor/raw_editing.spec.ts`) is what catches the browser losing it.

**Settings cross as one JSON value, `edit::EditRequest`.** The web side reads the server's settings. Inlining peak, anchor or denoise defaults would make edited libraries show one picture and write another.

**The browser decodes nothing of a RAW, including the preview the match is fitted from.** `crate::jpeg` is `jpeg-decoder`, pure Rust, and the decoder the server fits against; `Fitting::Preview` reads the preview out of the RAW's own bytes, on both hosts.

### 21.1.1 The merge page draws through the stage's own pipeline, not a second one

The take-best-parts merge page (§18.3.5) also draws pipeline output outside a stored rendition;
the same prohibition on a second implementation applies.

**Every preview on the page, a hover or a pick, is the viewer's own pipeline with one addition: a
mask.** `stage.slang`'s `stage_light` is the whole of what turns a decoded plane into a canvas pixel - the
planes read, PQ taken back to nits, rolled into the display's headroom, rotated onto the canvas's primaries -
and it is called once, from both `planar` and `planar_masked`, so a masked draw is the same picture with
an alpha rather than a second copy of that arithmetic. `StagePainter.paintMasked` (`stage_gpu.ts`) draws the base layer
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

**Pictures stay in extended range.** The canvas uses the viewer's `rgba16float`, `toneMapping: extended`;
every layer is an HDR-decoded `VideoFrame`. Avoid `createImageBitmap`, which tone-maps to SDR before drawing.

**What stays out of the browser is a masked, feathered, multi-layer composite of its own** - the band split
that hides a residual seam and the per-source weight that decides how far a feather reaches - which is
exactly the kind of second answer that drifts silently (§21.1). A masked _draw_ of layers already decoded
for the canvas is the whole of what the browser is trusted to do here; the render that actually blends the
bands and the weights runs once, in the one native crate, on the server.

**A pick that stands still for 400ms is asked for as a render**, and the server's own picture of it
replaces the masked draw in place. The masked draw is what a hover and a click show at once, because
a render is most of a second; the render is what answers "is this what Save writes", because it is
that picture at the layers' size. Each is keyed by what it draws (`MergeStore.keyOf`), so stepping back
to a pick already seen is the file rather than a second render of it, and every one is reaped with
the draft it sits beside.

**Save** posts the finished recipe straight to the route that commits or updates the photograph
(§18.3.5).

### 21.2 How each engine shows the frame

The frame reaches the compositor the same way in Chromium and Safari: an `rgba16float` WebGPU
canvas configured with `toneMapping: extended`, which is what makes a compositor show values above
SDR white, drawn by the module on the GPU thread. Both light an HDR panel above SDR white from it.
An engine without WebGPU has no editor (`wasm::needs_webgpu`).

**Firefox shows HDR only through `<video>`** (§10.7.2), and refuses an `rgba16float` canvas
outright. So there the stage, the loupe and an isolated colour wheel draw into held textures, and
each tick hands back what it drew as PQ Rec.2020 4:2:0 ten-bit planes (`pq420.slang`). The SDR range
is coded as the platform shows a PQ video's, through the same match as the viewer's copies
(`hdrVideoSdrMatch`, `sdr_match.slang`, §10.7.2). The page
encodes them as a one-frame VP9 profile 2 stream with libvpx, built for `wasm32-wasip1-threads`
(`native/vp9_encode`, `bun run get:vpx`) with up to eight threads and one encoder per surface, wraps
that as an MP4 (`vp9FrameToMp4`) and shows it in a `<video>` over the canvas, which keeps the
pointer and the accessible name (`canvas_video.tsx`). About 30ms a 1080p frame, all of it on top of
the tick; a banner over the viewer and the editor says so (`quality_notice.tsx`). The panel
thumbnails are packed to eight-bit sRGB (`pack_srgb8`) and drawn to a PNG in every engine.

**WebKit caps a transferred canvas at the headroom of its default HDR image content**: 1000 nits
over 203, whatever the display reaches, while a canvas the page configures on its own device is not
capped. So on WebKit, and only where the display's peak can pass 1000 nits, the canvas stays on the
page and the GPU thread hands back what it drew as RGB9E5 words, which the page draws through
`readback.slang` (`web/src/gpu/readback_canvas.ts`). Everywhere else the canvas is transferred and
nothing comes back.

### 21.3 Where the state lives

`EditStore` holds what every tool reads - the document, its revision, undo and save - and `StageStore`, `CropStore`, `KeystoneStore`, `RepairStore`, `ColourWheelStore`, `LoupeStore` and `PrintStore` hold their own, each taking a one-way reference to the peers it reads. A presenter per domain is the only writer of its store, and `RawEditPresenter` owns the open: its session on the GPU thread and the canvases it hands over. The stores are constructed when edit mode or the viewer's print mockup is entered on the photo detail page and torn down when it is left - never for an ordinary viewer visit - rather than in the app's provider (§18.2), because an open holds the RAW, the frame and its tiles on the device. `RawEditPresenter` is built per photo over them; closing it frees the photo's state on the GPU thread but keeps the stage there for the next photo to draw onto (`EditSurface`), which the visit drops when it ends.

Drag requests **coalesce rather than queue**: only the latest position remains outstanding, avoiding slow-motion replay after release.

What the stage is proofed as is one choice, the `Soft proof` menu in the header - in the editor
between the zoom and the filmstrip, in the viewer between the triage buttons and the
filmstrip, and labelled with the proof in force. `HDR (Rec.2020 PQ)` is the default and is withheld
from a rendition with no HDR in it; `SDR (sRGB)` is always offered and is what an SDR rendition
already shows; the two printed media proofs are always offered. Choosing a proof with panels adds
a `Soft proof` tab of them and selects it: SDR the rendering intent, titled `Tone mapping`,
`Printed media` the paper and printer, `Printed media (3D)` those and lighting and orientation.
The editor sends sRGB to the worker as an output and an intent, and the module fits the frame into
sRGB with the same operator a print, an SDR rendition and an SDR export use (`gamut_map.slang`).
The viewer has no module, so an HDR rendition proofed as sRGB is fitted in `stage.slang` on the
client, through that operator, against the rendition's own headroom; a print proof from the viewer opens the photograph's `/mockup`, which
builds the editor's session for it and saves nothing, and choosing an HDR or sRGB proof there or
pressing Escape returns to the photograph. The mockup draws the rendition the viewer was showing
rather than the RAW - the camera's JPEG, `full` or `max`, carried on the navigation because opening
the mockup clears the reader's own choice, and `max` for an address opened directly. Every edit is
already in a rendition, so the page asks for it to be built or fetched where it is missing or behind
the edits and downloads the file, and nothing of it is prepared on the server. The camera's JPEG is
decoded by the module, as a JPEG original is, turned by its EXIF. The module has no AV1 decoder
(`decode_rendered::av1`), so an HDR AVIF reaches it as the planes WebCodecs' `ImageDecoder` hands
back from `copyTo`, or `native/avif_planes` (below) where there is no `ImageDecoder` or it declines,
and `planes.slang` converts them to the sixteen-bit codes libavif would have given - by the same
video-range arithmetic the viewer's stage draws with (`video_range.slang`), and pinned against
libavif (`planes_convert_to_the_codes_libavif_decodes`). Both decoders take limited-range PQ only,
so an SDR AVIF - a library with HDR renditions off, a composite's camera view - is decoded by the
browser to RGBA, which is all an SDR picture is, and handed over with the file for its colour
(`decode_rendered::hold_pixels`, which refuses an HDR file that got that far rather than clip it).
The open is a finished picture's, unedited, with no analysis read or filed, and anchored at the
white its file states (`EditRequest::stated_white`) rather than at a quantile, and the page draws it
at neutral without reading the saved edits. A neutral grade of that frame is the file's own light,
so the print starts from the picture the viewer shows, and what crosses the network is the file
rather than the samples it decodes to - 3MB against 59MB for a 10MP rendition.

**Safari has no `ImageDecoder`, and every other way it decodes a picture flattens HDR** - an
`<img>` drawn to a canvas, `createImageBitmap`, a `VideoFrame` built from an image, all SDR by the
time a canvas sees them. So the viewer and the mockup decode a rendition themselves there: rav1d
(`native/avif_planes`), built for `wasm32-wasip1-threads` because it cannot build for
`wasm32-unknown-unknown`, returning exactly the planes `copyTo` would (pinned sample for sample
against libavif, grids included, through the files and planes `tables/avif-planes.txt` lists).
`web/src/avif/` hosts it: a worker holding the instance, and a pool of workers started ahead of time as its threads
(`web/src/wasi/`, shared with the VP9 encoder),
handed each thread through shared memory because the decode that spawns one never returns to its
event loop until it is done. Shared memory is why the app is served cross-origin isolated
(`src/schemas/isolation.ts`), and the pool is why the decode costs 90ms for a 10MP rendition rather
than seconds. Decodes run one at a time, the photo on screen ahead of its neighbours; an abandoned
one waiting is dropped, and an abandoned one running past 20MP tears the decoder down and starts a
fresh one rather than being waited out, which a rebuild costs less than.

Print mode holds its paper, lighting and orientation in a separate `PrintStore`, written by
`PrintPresenter`. These are viewing settings and leave the photo document and its history alone.
`Printed media` is the flat proof: the pigment the print grade arrives at drawn as paper
reflectance under diffuse white, straight onto the ordinary stage (`fs_print_flat`), with no sheet,
room or light to integrate, so it costs what the ordinary grade does and every editing tool works
over it. `Printed media (3D)` draws a suspended sheet with the same worker and HDR canvas through
the shared Slang renderer, and closes the tools that draw over the photograph. The photo
is graded to a bounded print reflectance before illumination.

**One operator takes HDR or SDR into any smaller gamut, and the rendering intent is its only
setting.** `gamut_map.slang` is handed the graded light before any roll into a display and does
three things. Luminance: perceptual rolls the scene's peak into white along the grade's roll-off
(§10.7.1), which leaves everything a third of a stop under white where it is; relative colorimetric
leaves all of it, so a highlight past white clips; to white, the default, rolls luma from BT.2390's
knee held no lower than 1.5 stops under white and keeps only as much chroma as the pixel's hottest
channel survives of the same roll, so a bright saturated light goes towards white the way it does
on film and in AgX rather than staying a flat saturated patch. Gamut: at constant Rec.2020 luma, chroma past what the target
holds at that luma and hue is compressed from 0.9 of the limit (perceptual, to white) or cut at it
(relative). Black: perceptual and to white lift the frame onto the target's black, relative does so
with black point compensation and otherwise floors at it. Two of the intents are Lightroom's;
absolute colorimetric proofs one medium on another, which a print of a photograph never asks for.
To white is what every SDR rendition, export and proof gets unless the reader picks another. Its
lower knee is a choice with a cost: when the frame holds highlights well past white, diffuse white
and up to a stop and a half under it land below where perceptual puts them. The target is an
interface, so
sRGB and generic paper are the cube in closed form, and a printer profile is a table of its maximum
chroma over 64 hues and 32 lumas. A profile is read into that table with moxcms each time one is
picked - its device grid through the profile's relative transform into linear Rec.2020, binned by
hue and luma - which costs 6ms for a CMYK printer, so nothing is cached. The same pass reads the
profile's paper white and black, which then take over the paper panel's two reflectances. The
paper's colour is laid on only 30% of the way from neutral (`PAPER_ADAPTATION`, a Bradford
adaptation at its own luminance). A profile's white is measured under UV, so a paper with optical
brighteners reads bluer than a room with little UV in its light shows it - Red River's UltraPro
Luster reads b* −13 - and a reader's eye settles most of the way onto a sheet's white besides.
Laid on whole, that white turns a whole print lavender.
What a vendor's own perceptual table does is not reproduced: it is built for SDR input,
and one operator for both ranges is the point.
Surface reflections can exceed diffuse white. Dragging or arrow keys rotate the sheet, the wheel
lengthens the camera's focal length about whatever sits under the pointer and the middle button
drags the view across, and Home or a double-click puts all three back. Zoom is the focal length
rather than a scale on the drawn canvas, so a print seen closer is a print seen closer: the
perspective narrows and the sheen moves with it, where scaling the canvas would only enlarge the
same picture. The camera fits the sheet's own outline to the canvas, so a landscape sheet fills a
landscape canvas as far as a portrait one does, where one fitted to the long edge alone would lie
along the canvas's long edge and cover half the frame. The panel controls the material and the light, and
every slider carries the editor's reset arrow and double-click back to its rest - for a paper
control, the chosen paper's own value, which is also what choosing a paper puts every material
control back to. The mockup is the viewer's own screen, so a sidebar the viewer hides stays hidden
under it.
The camera rays intersect a slightly bowed sheet, lit by a round ceiling downlight whose illuminance is
specified at the print centre facing the light. Its opal diffuser is flat through the middle and
falls to nothing at the rim (`1 - r^4`), a radiance profile shared by
light samples and reflected rays. Surface reflection uses dielectric Fresnel and GGX; its
GPU-tabulated directional albedo couples it to the diffuse body through the reciprocal
[OpenPBR glossy-diffuse model](https://academysoftwarefoundation.github.io/OpenPBR/).
This conserves reflected energy while approximating scattering inside the paper. Surface
texture varies roughness in paper coordinates, with its physical scale set by the print's
long edge and its visible detail filtered against the camera-ray footprint. Its bumps are a sum
of cosines over three octaves in random directions, which stays smooth however far the camera
closes in. A paper's black is its maker's Dmax, a 45/0 reading, so it already holds the coating's
reflection at that angle: the flat proof shows it as it is, and the drawn sheet takes that share
out again (`coating_at_45_0`) because it draws the coating itself. The coating reads the room
along its mirrored direction, blurred by its lobe, and a lobe wider than about a radian (matte)
reads the room's average instead, as the diffuse body does, so that it carries no window.
The room is a photographed one: an equirectangular HDR map from Poly Haven, CC0, fetched by
`bun run get:environments` and chosen from the Lighting panel - a room lit by its windows at midday
(`poly_haven_studio`), open grass under a clear sun (`meadow_2`), and a hotel bedroom at dusk under
warm downlights (`hotel_room`). The editor fetches the one a reader picks, from a hashed name beside
the module as PMRID's weights are (`scripts/hash-pkg.ts`); the native tests read the getter's tree.
Each map's brightest light is the lamp. `print_environment_build.slang` turns the map so that light
hangs where the preset puts it, takes it out - every texel within a few degrees of it brighter than a
threshold clipped to the threshold - and builds a mip chain, so the lamp is drawn once, by the direct
term, rather than once there and again as a bright patch of the map. The preset is measured off the
map rather than chosen: `each_environments_lamp_is_the_light_it_takes_out_of_its_map` holds its
direction to within a degree of what the build took out, its lux against the room's to a tenth of
the ratio the map has, and its temperature to the colour of that light. The hotel's downlights are
greener than any temperature, which is as close as a lamp with no tint gets. Choosing an environment
puts every lighting control back to its preset, which is also where each control's reset goes.
The ambient setting is the illuminance an upright print facing the reader stands in, and the map is
scaled to deliver exactly that, so the map only decides which direction and colour it arrives in. A
sheen is a reflection of the map along the mirrored direction, read at the mip level its lobe spans,
and follows what the sheet is turned towards; the other downlights and the windows are what makes it
a reflection rather than a veil. What is behind the print is the same map along each camera ray, and
it and every mirror image of it are 0.012 radians out of focus, as a 50mm lens at f/2.8 focused on
the print leaves a room a few metres behind it. The map is read through a cubic B-spline: a
bilinear read draws its texel grid into a window brighter than white once the display's roll-off
flattens each ramp. The reader is in that room too, and is a body rather than a
head: a third of a radian across and most of a radian tall, standing on the floor rather than
floating at eye level, so the silhouette hangs below the direction a square-on sheet mirrors into
the eye and reaches half the room's own radiance. A print faced straight therefore reflects a
silhouette rather than a room and holds its paper's own black, and one tilted down its own height
still has the reader in it where one tilted up does not. The silhouette washes out as the lobe
reading it opens, in the ratio the two solid angles stand in, so it belongs to gloss and barely to
matte. Nothing shadows the diffuse side, where the same cone is worth under a percent of the
illuminance.
The diffuse side reads the same map through its spherical harmonics to the second band, per channel,
fitted over the whole sphere once per lamp, which is all a Lambert cosine keeps of any surround -
windows included. A surround of one radiance instead puts the whole room's illuminance in the
direction the reader's own reflection comes from, which lifts that black four times over and leaves
every off-axis reflection a flat wash. The map carries its own colour, and the light temperature
tints the lamp alone.
Only the brightest light is a lamp, because a lamp is the whole of the print's cost: the direct term
samples it 64 to 128 times a pixel for the specular and, where it is wide or shadowed, for the
diffuse too. Every other light in a map is lit through the mips, which is exact for the diffuse side
and loses only the frame's shadow and the sharpest glint on gloss.
Camera exposure meters the room against a sheet hung facing the reader, and never against the pose:
a camera meters a room once, and re-metering as the print is turned holds the sheet at one
brightness while moving everything that did not turn - the background with it - which reads as the
room changing colour under a rotation. Turning a print towards the ceiling gathers more light and
arrives brighter, which is what the HDR headroom above diffuse white is for.
The GPU integrates the finite light against the sheet's orientation, including light crossing
its horizon. One exposure gain applies to the whole scene, anchored to 203-nit diffuse white
and bounded in dark rooms; coating reflections retain their HDR headroom. The scene is then rolled
onto the display's peak on its brightest channel, as a frame is, because nothing else bounds it: a
sheet turned to the lamp gathers past any display, and what a compositor clips it clips per
channel, which is a hue shift across the brightest paper.

The display's peak is the device's on an HDR display (§10.7: the screen's headroom where the shell
reads it, the device setting where it cannot) and SDR white on one that is not. Every tick carries
it to the module as `DeviceSettingsStore.peakNits`, null on an SDR screen, which aims every draw - a
frame, a proof, a sheet - at SDR white, the rule the viewer keeps too. Whether the screen is HDR is
the shell's answer where there is a shell and `(dynamic-range: high)` where there is not, and both are
observed, so a window dragged to another screen redraws. Firefox answering `standard` on an HDR
display is right here: the canvas is the one thing it composites in SDR.
The default is the daylit room: 500 lux of it, and a 133-lux downlight a degree and a half across,
over the reader's head at 7800 K. The sunny meadow is 80000 lux of sun against 9570 of sky and
grass, and the hotel room 30 of downlight against 15, which the exposure's floor leaves reading dim.
Both lux controls slide in decades, from 1 to 150000, so a dim room and the sun each get a usable
stretch of track. The lamp is placed by where it hangs rather than by
its angle: across, up and forward from the sheet's centre in print lengths, at most ten, which is
where the sun stands. Angles alone leave the
one question a reader asks of a room light - is it behind me or in front of the picture - with no
control of its own. The source spans a tenth of a degree to ninety, slid
in decades so a pinpoint lamp and a broad one each get a usable stretch of track. Below about a degree the
highlight stops following the source: the paper's own roughness is wider than the lamp, and the
roughness control is what narrows it from there. The light temperature
uses the same Robertson chromaticity model as white balance. Gloss reflects the room through its
directional Fresnel response, producing a broad sheen at grazing angles.
A framed print stands flat behind 2mm glass, above a mat and inside a moulding that casts its own
shadow. The glass mirrors the room and the lamp twice, once off each of its surfaces, with the
second image offset by the thickness it crossed and refracted on the way - which is what makes it
read as glass rather than as a light painted on the picture. The pane is anti-reflection coated, as
framing glass is: each surface sends back 0.4% square on rather than bare glass's 4%, and follows
Fresnel's own rise from there, so a frame tipped back a few degrees shows the picture and only a
steep one fills with the room. The paper's own sheen reaches the
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
see: the core is far past paper white and meets the display's peak whatever is done to it, and the taper that
would soften the rim falls inside a pixel, so integrating the pixel does not reach it - measured,
four rays across a pixel moved the rim and nothing else, and cost as much as the halo does.
A frame costs about 1.4x an unframed sheet on the scene path, measured at 1920 on radv: a quarter
more canvas to cover, the moulding and mat to intersect, and the glass's own two reflections. The
light integration answers for one surface per pixel - a pixel shows the photograph or the mat or the
moulding, and only the footprint's width between them needs two - and the moulding's shadow takes
four corner tests rather than a ray-box test per emitter sample, since the hole is convex and so is
the emitter.
**What the print costs is the emitter's integral, and it is paid per canvas pixel on the desktop
path and per field texel on the touch one.** Four things keep it in proportion. The emitter is
sampled against how much of the sky it covers, from 64 for a small lamp to 128 for a broad one, since a
source a degree across hardly varies over its own solid angle. Where the emitter is the smaller of
the two, only the emitter is sampled, not the lobe as well: balance-weighted MIS is unbiased either
way, and the lobe's strategy finds a one-degree lamp once in a hundred tries for a hundred times the
value, which is variance and not signal - held against a thousand-sample render, the pair costs a
third of the frame and lands closer than sampling both strategies does.
The third is that those counts are the _specular's_. Under a hundredth of a steradian - a small
lamp, not a broad one - every geometric factor is constant across the emitter's face, so the diffuse
half of the same pixel is the diffuser's mean radiance times one cosine, in closed form, at one
evaluation rather than sixty-four. A near, broad lamp varies its own inverse square over its face by a quarter and
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
An address opened straight into the mockup opens the max rendition, the sensor's own size with every
edit in it, because its zoom reaches eight times the sheet and a 3840px rendition runs out of pixels
well before that; from the viewer it prints whichever rendition was on screen. The
sheet's fragment shaders are also the longest thing here
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
index: the index sets how strong the coating's reflection is - an eightieth of the light at normal
incidence for the 1.25 of a microporous gloss or satin coat, a twenty-fifth for matte's 1.5 - and
nothing about its width. Satin sits at 0.28, where a one-degree lamp is a soft spot rather than a
glow across half the sheet.

### 21.4 Tests

Three suites check the editor's GPU path, and they fail at different places: `gpu_shader.rs` the
shader arithmetic, `gpu_fixture.rs` that the grade still draws its snapshots, both in-process against
a Vulkan adapter, and `editor/raw_editing.spec.ts` that a real photo reaches the browser's own adapter
through the wasm module and comes back live, the camera match included (`data-matched`, §21.1). The
e2e spec is the only one that can see the bindings and the page disagreeing. It runs in Chromium
alone: the editor needs WebGPU, which the Linux Firefox the suite runs does not ship. What no
automated check can confirm is the pixels reaching an HDR compositor.

## 22. What HDR is for (`landing/hdr.html`)

The landing site's HDR page makes the case for HDR in pictures: four raw files, each developed twice and swapped **in place**. A toggle makes differences visible without the eye travelling between frames.

**It opens on the 8-bit version**, the reader's familiar picture. Adding HDR is easier to notice than its absence.

**Its copy never names this app.** The argument about 8-bit photographs applies wherever readers develop raws and should be checkable against their experience. The closing section defines each pair - one raw, same settings, different container - without naming its producer. Copy addresses photographers through stops, clipping and channels, not PQ, transfer curves or nits.

**The HDR arm comes out of `runJob`** (`scripts/demo-assets.ts`) at the settings the app ships with - `SettingsSchema.parse({})`, not a table of numbers copied into the script - with only the size changed, 1200px rather than 3840.

**The 8-bit arm is derived from that file rather than asked for as a second target**, and getting this wrong is what the first version of the page did. A library's SDR rendition is _not_ the HDR one with its highlights removed: it came off LibRaw's sRGB output, auto-brightened and fitted to the camera's JPEG (§10.8), where the HDR one is a scene-linear decode graded against a quantile (§10.7.1). On a daylight frame those land in nearly the same place. On a night frame they do not - measured on the neon sign, the SDR arm sat at a black level of 0.059 with a red cast where the HDR arm was at 0.003 and neutral, and on the WC sign it was darker everywhere rather than only in the highlights. Both are defensible renderings and neither is a bug. But a page whose entire claim is _the same picture with less room at the top_ cannot be built from two pictures that disagree at the bottom, and a reader looking at those pairs correctly reported that the 8-bit one was simply broken.

So the 8-bit arm is now the HDR arm with its ceiling brought down to white: the PQ taken back to light with 203 nits tied to 1.0, everything above that clipped by the sRGB transfer, written out at the quantizer a stored SDR rendition would have used. A clamp and a colour conversion, no second grade - which is exactly what the page says it is showing, and now literally true rather than nearly true.

The cost of the fix is that the page can no longer borrow a difference from the two arms disagreeing. Only content genuinely above white differs now, and three of the original five scenes did not survive it. A moon over some roofs lost **0.0%** of its pixels to the ceiling and a pizzeria sign **0.1%**: they had been showing a difference that was entirely the two grades disagreeing, and with that gone they show nothing at all. A third, an LED-lit still life, kept 6.7% but was replaced for a different reason - a reader with no idea what the room actually looked like cannot tell which of the two versions is the better one, which is a fair complaint about any picture whose subject they cannot check against memory.

**The raw files are the maintainer's own**, read from a path only their machine has, which is why the script does not run on a fresh checkout and does not need to: the renditions are committed under `landing/public/hdr` and the page serves those. They were CC BY-SA submissions from discuss.pixls.us for as long as the page was illustrated by strangers, which is where the credit line under each picture went when the photographs became the maintainer's.

**Choose scenes by measurement, then recognisability.** Most raws hold only a stop or two above diffuse white: metering favours the subject, with sensor saturation a little above. Frames containing a light source work best. Encoded rendition measurements:

|                              | above white | peak      | colour recovered |
| ---------------------------- | ----------- | --------- | ---------------- |
| rapids under an overcast sky | 2.4%        | 587 nits  | 0.00%            |
| a sunset over railway tracks | 2.5%        | 656 nits  | 0.00%            |
| lit arches at night          | 2.6%        | 1460 nits | **1.28%**        |

**"Above white" turned out to be the wrong number to choose on, and the third column is the right one.** It counts pixels that are bright and _neutral_ in the 8-bit arm while still being a colour in the HDR one - which is the thing the page claims in words and the thing a reader checks by eye. Two pictures chosen on headroom alone were rejected on sight for showing "not much" and "still blown-out red", and they score 0.24% and 0.04% here: the metric agrees with the reader, where the headroom figure did not. The arches score 1.28%, an order of magnitude past anything the licensed candidates managed.

**What it exposes is a property of the grade, not of the photographs.** Screened across eight night, neon and traffic-light frames, _none_ recovers more than 0.04%. The BT.2390 roll-off is applied per channel against a shared curve (§10.7.1), so a light source twenty stops above white arrives with all three channels pressed against the ceiling - near-white in the HDR rendition too, just very much brighter. Saturated colour survives where it sits one to three stops above white and not twenty. The arches are in that window and are what the page argues colour with: measured over the pixels the ceiling touches, mean saturation is **0.571 in HDR against 0.186 in eight bits, and 51% of them go neutral** - they are pink in one file and white in the other, which is the whole claim. Making a neon tube twenty stops up come back red as well would need a hue-preserving roll-off in `tone.rs`, a change to what every HDR rendition in the app looks like and not something a page about the app gets to decide.

**Which picture carries which argument is decided by that measurement, not by the subject.** The sunset looks like the colour example and is not one: over its above-white pixels, saturation goes 0.913 to 0.791 and _none_ of them go neutral, so the eight-bit version is barely less colourful - what it loses is height, being folded into the top of the range. It is captioned as that. The copy had the two the wrong way round until the numbers were run.

**A sunlit snowfield is the worst case for this grade, which is worth writing down because it reads backwards.** The obvious way to show clipping is a big white subject, so twelve snow and surf frames were measured looking for one. Ten came back at 0.0% above white. The reason is structural rather than bad luck: `HDR_WHITE_QUANTILE` puts diffuse white at the 90th percentile of the frame (§10.7.1), and in a picture that is mostly snow the 90th percentile _is_ the snow - so white lands on the subject and there is nothing left above it. The one that worked is a sunset, where the snow is in shadow and the sun is not.

The second test is recognisability: readers know a backlit beer, traffic light or neon tube. They cannot judge which rendering of an unfamiliar LED-lit room is right, regardless of headroom.

**In Safari, an HDR image inside a scrolling element has to be promoted to its own layer or it is not HDR.** WebKit gives a scroller one shared backing store and that store is SDR, so a PQ image drawn into it composites flat. `will-change: opacity` is enough to take the image out of it.

This cost a day to find, and every wrong turn on the way is instructive about how the failure hides. The strip was flat in Safari and bright in Chromium, so it looked like the file: it was the one asset on the page tagged 1/16/1 at 4:4:4 rather than 9/16/9 at 4:2:0, which is a genuine problem and was worth fixing on its own, and fixing it changed nothing. It was bright in Reader mode, which is the page's CSS being stripped, so it looked like the stylesheet - and an audit for the filter/transform/opacity rule below came back clean, because that rule was not the one being broken. A bare probe page reproduced _none_ of it: file, markup, `clli`, scaling, layer promotion, all bright. What finally isolated it was moving the `<img>` up the tree on the real page until it came good, which put it exactly at `.content`, and then killing one declaration.

**The photographs escaped the failure accidentally.** `.compare__layer` already had `will-change: opacity` for repaint-free swapping, promoting them out of the scroller.

**The swap is an opacity change on two mounted, decoded frames**, which is the stack triage flip (§20.4) and works for the same reason: `will-change: opacity` keeps the hidden one rasterised, so a press costs no repaint. Nothing on that subtree or above it may carry a filter, a transform or a partial opacity - any of those rasterises into an SDR intermediate and loses the PQ tagging silently (§10.7).

Each picture is an `HdrPicture`, so Firefox is shown a rewrap of each scene's committed `-hdr-10bit.avif`, or `-hdr-10bit-mac-video.avif` on macOS, and never fetches the still (§10.7.2). Four mounted MP4s cost a few hundred kilobytes and avoid rewrapping per press. The swatch strip is rewrapped from its own file, which is 10-bit 4:2:0 already, bar macOS's `swatches-mac-video.avif`.

**Swatch strips are the page's only synthetic content.** They explain brightness above white before the photographs: five colours start at their 8-bit maximum and rise to their format's limit. Quantisation is lossless; flat colour has no detail to trade away.

**The strip is tagged and subsampled exactly like a rendition - 9/16/9, 4:2:0 - and was not.** It was 4:4:4 at **1/16/1**, Rec.709 primaries with a PQ transfer, which dodged the gamut conversion and rendered correctly in Chromium. Neither half of that is a combination another engine has reason to expect: 4:4:4 is the one thing Firefox will not composite in HDR (§10.7), and 709-with-PQ is not a colour space anything ships a path for. A reader on Safari saw the HDR half come out better than the 8-bit half but not _bright_, and saw it come good in Reader mode - which is the page's own CSS being stripped, so it may yet be page-side, but a file that is the only one of its kind on the page is the first variable to remove.

Two details in doing it. The **conversion to Rec.2020 happens in the script rather than in zimg**, so the samples can be scaled by `1/max` afterwards and diffuse white still lands on 1.0; the conversion pulls a saturated Rec.709 red to 0.65 of full scale and would otherwise put the first patch at 130 nits. And the **8-bit half is clipped before the conversion, not after**, because the clip is the thing being demonstrated and it is an _sRGB_ clip. Clipping in the wide space walks the reds to a khaki and the blues to a grey-green, which is not what any JPEG has ever done - it was drawn that way for one build and it looked precisely as wrong as it sounds.

**All three channels scale together, and the two attempts to avoid that are worth recording** because both looked like improvements. The HDR row reads as getting lighter along its length, which invites holding the two minor channels and raising the dominant one alone: the row then deepens instead of lightening, and side by side the two strips stop looking like the same move at different speeds.

It is wrong twice over. It flattens the 8-bit arm to five identical patches, since that arm goes pale _because_ those channels are rising underneath a dominant one that has already stopped - so the arms have to be authored separately, which they then were. And measured across the row it moves the hue: **orange from 24 degrees to 5, red in all but name, and blue from 212 to 235**. A strip captioned "the same colour, brighter" cannot be turning one colour into another, and trading a lightness error for a hue error is not a fix.

Scaling the triple is the only construction that means what the caption says. It leaves chromaticity alone, so hue and saturation are both held exactly - measured across a row, 24.2 to 24.2 degrees and 0.97 saturation on the orange, while the light goes 198 to 974 nits. The row does look lighter, because more light is what it has; the caption now says that and points at what the 8-bit arm spends to get the same climb.

**Both halves are in one PQ file, and that is what makes the comparison survive an ordinary screen.** Three rounds of complaint about the HDR strip - lighter, then dark on the left, then dimmer in the first column than the 8-bit one - all traced to the same measurement rather than to the samples. **A standard-range browser renders a PQ file by fixing its own white at about 406 nits.** Probed off the canvas and off a screenshot alike, a patch sitting exactly on diffuse white paints at 187 where an sRGB white paints 255, and nothing in the file moves it: `clli` makes no difference, and a flat 203-nit image with nothing above white at all still comes out at 187.

On most screens, sRGB paints about a quarter brighter than PQ, whether adjacent or swapped: one is untouched, the other tone-mapped. Two files cannot isolate the intended comparison.

One file can. The left half is the same colours with every channel clamped at white and the right half is those numbers left alone, so whatever the screen does to one half it does to the other and what is left is the comparison. Measured on the composited page, the first patch of each half now paints identically at `187,48,44`, where the last pair reads `188,107,99` against `255,81,74` - the same brightness gone pale on the left, more brightness with the colour intact on the right. On a real HDR screen the left half simply cannot exceed diffuse white, which states the argument as a brightness rather than as a caption.

The photographs never showed any of this, because a swap never puts two pictures next to each other. It is worth knowing anyway: it is what an SDR viewer sees of _every_ HDR rendition this app writes, and it is why the notice at the top of the page is worded the way it is.

**The stops chart above them started as folklore and took three attempts to source.** "About 8 stops for a JPEG, about 15 for 10-bit" is what it said until a reader asked where those came from, which was nowhere.

_Measuring the code values_ was the first answer and made the threshold the author's choice: how far down before the gap between adjacent values exceeds 5% gives 6.0 and 14.6, 2% gives 2.8 and 10.3, and 1% - about the Weber limit, and roughly what PQ was designed against - gives **0.4 and 3.9**. That last pair is true and useless on a chart. A photograph is not a smooth gradient and its own grain dithers away the banding the criterion is hunting for, so quantisation belongs in a sentence rather than in the length of a bar.

_Quoting each format's specification_ was the second and was wrong in both directions at once. sRGB's 80:1 is its reference _viewing environment_ from 1999 - a CRT in a lit office, ambient flare included - and describes no panel anyone owns; it gave the JPEG 6.3 stops, which is far too mean. HDR10's 1000 nits over 0.005 is a mastering reference met by an OLED in a dark room; it gave 17.6, which is far too generous for the LCD most readers are on.

_What the hardware can actually show_ was the third, and it was answering a different question from the one the label asked: a bar reading "An 8-bit JPEG" that says 10 stops because a monitor is 1000:1 is a fact about the monitor.

**So each file gets its format's own range with the screens indented beneath it** as subsets. sRGB encodes codes 1 to 255, which is 11.7 stops; PQ at 10 bits encodes 0.0001 to 10,000 nits, which is 27.9. Under each sit an OLED in a dark room, a MacBook Pro XDR, and an LCD in a lit one.

**Screen rows cannot exceed the eye row:** they describe perception, not panel capacity. Two versions violated this, including an OLED at 25.2 stops beneath 20-stop eyes.

**The two HDR panels differ at the bottom and not the top.** Both peak near 1600 nits on the small bright areas a photograph actually puts there. An OLED switches its pixels off, so nothing about the panel stops you and the eye does, at -14. A mini-LED cannot: the XDR blooms, and its **1,000,000:1 is a full-field-black figure describing nothing anyone will ever look at** - with bright content on screen the local floor is nearer 0.05 nits, which is -12. Believing the spec sheet puts the XDR at -14 as well and draws the two identical, which was the second mistake and the mirror of the first, where both were handed the same 0.005 and the OLED lost the one thing it is for.

The rows under the JPEG are the reason this is worth drawing four times. **Two of them are identical to the format bar above them**, because either HDR screen outruns sRGB by several stops and so the thing limiting a JPEG there is the JPEG. The HDR file is the other way round on every screen: 27.9 encodable against 17 seen on the OLED, 15 on the XDR and 10.2 on the LCD, because there the panel and then the eye run out long before the file does. Neither fact is visible when a bar carries one number.

**A JPEG's headroom is 0.2 stops rather than none**, which the bar now shows as a sliver past the line rather than stopping dead on it. A camera puts diffuse white around code 240 and not 255, leaving the last 15 codes for specular glints: `log2(linear(255)/linear(240))` is 0.20, and placing white at 235 or 245 gives 0.27 or 0.13. The page kept saying a JPEG has _nothing_ above white and it nearly does, but 0.2 against the HDR file's 2.3 makes the point better than a wrong zero would.

**Hatch above-white range; draw the white tick heavy over the bars.** The chart's subject is where values fall relative to white, so that boundary must dominate.

**Which leaves the chart saying something better than "HDR is bigger".** The formats are not far apart in total once both are read honestly, and on the screen most people own they are within a stop or two of each other. What separates them is entirely on one side of one line: the JPEG's headroom is 0.2 stops and the HDR file's is 2.3, on every row. The other two bars stay approximations: a full-frame sensor's engineering dynamic range at base ISO, and the eye across one scene with the gaze moving.

**The photographs ship with the landing site only.** The app carries just the swatch strip in `web/public/hdr`, which `HdrOutput` keeps painted so Chrome on Windows presents in HDR. Halving assets introduces artefacts in the highlights being demonstrated; lazy-loading saves nothing for readers reaching the bottom.

`(dynamic-range: high)` or `(video-dynamic-range: high)` decides whether to say the display is SDR. The second query is Firefox's: it answers `dynamic-range` `standard` on an HDR display, and is shown this page's pictures as video (§10.7.2). On an SDR one the colour losses still show - a clipped neon tube is white there too - and only the brightness ones are lost, which is what the notice says.
