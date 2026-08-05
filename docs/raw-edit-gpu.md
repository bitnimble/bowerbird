# RAW editor: per-tick stages and GPU reachability

Date: 2026-08-03. **Built, 2026-08-04**, see the status below before reading on.

## 0. Status: what this argued for, and what shipped

This is the note that took the editor from a wasm CPU tick to a WebGPU one. It is
kept as the record of *why*, so it still describes the CPU pipeline in the present
tense throughout. That pipeline no longer exists. Read §1–§5 as the baseline being
argued against, not as the system.

Where the code went:

- `native/rawshim/src/wasm.rs`, **deleted**. The browser-side Rust is gone, and
  so is the wasm32 target. The open is `native/rawshim/src/edit.rs`, called
  natively.
- The tick is `web/src/features/raw_edit/gpu/`: `wgsl/` holds the shaders,
  `tick_pipeline.ts` orchestrates them.
- The three sinks, the interactive 960px preview, `Resolution`, and the
  `VideoFrame` / PNG / AVIF routing all went with §7; the canvas replaced them.

Four things this note got wrong or did not foresee, each fixed by measurement:

- **`image::finish` is not a per-tick stage.** It runs once, at the open, in the
  PQ domain (`edit::filter_once`). A tick is the grade alone.
- **The graded frame does not need to exist.** §6 assumed a chain of resident
  textures; the colour transform is one fragment shader straight to the canvas,
  and materialising nits between passes cost 5.2ms of a 15ms tick.
- **The tick's cost is the canvas, not the frame.** §4.1's whole argument about
  choosing a pixel count is moot: the draw runs once per canvas pixel over a crop,
  so `EDIT_LONG_EDGE` is gone and the open decodes the sensor. A 61MP frame ticks
  in 8ms at a 2560x1707 stage.
- **wgpu in Rust (§6.2) was not taken.** The shaders are WGSL in the page, which
  is where the canvas is. §6.3's parity pin is what makes that safe: against the
  CPU it holds the mean within 0.5 counts of 65535, with the worst pixel bounded
  at 320 and under 0.5% of samples past 16. The mean is the assertion that
  matters; the worst is loose because f32 against f64 either side of PQ separates
  a handful of pixels, and it only reaches hundreds at all because the fixtures
  carry a real camera fit rather than the identity they started as.

What §7 concluded; the extended-range canvas, 203 nits, no bespoke gamut mapping; was measured against a real PQ AVIF on both engines and is what ships.

---

What runs on an exposure slider change in the browser editor (`native/rawshim`
wasm + `web/src/features/raw_edit/`), what it costs, and what a GPU would
actually buy, including from which thread that GPU is reachable.

## 1. Open vs tick

**Once at open** (not on slider change): LibRaw decode → `hdr::prepare` (levels)
→ camera match fit from embedded JPEG → lens warp materialised into `Prepared`
→ interactive shrink (960 long edge) → `release_source` (drop decode + RAW
bytes). After that, ticks grade from `prepared` / `preview` only.

**Every exposure tick** is `Editor::grade(ev)` (settle, full size) or
`Editor::preview(ev)` (drag, interactive size). Same stages, different pixel
count. Entry: `grade_from` in `wasm.rs`.

## 2. Stages on a slider tick

| # | Stage | Code | What it does |
|---|---|---|---|
| 1 | Copy | `working.copy_from_slice` | Prepared (or interactive) `u16` RGB into the working buffer |
| 2 | Grade | `hdr::grade_prepared` → `tone::grade` | Exposure × camera curves / matrix / chroma + BT.2390 EETF roll-off |
| 3 | PQ | `tone::encode_pq` | ST 2084 via a 64k LUT |
| 4 | Finish | `image::finish` | Defringe → luma denoise → chroma denoise → sharpen (library strengths; defaults are non-zero) |
| 5 | Emit | `emit` | Sink-dependent (below) |

**Emit by sink** (`wasm::Sink`, chosen in `raw_edit_route.ts`):

- **Video** (Chromium): `pack`, PQ RGB to I444 planes for a `VideoFrame`
- **Still** (Safari): 16-bit PQ PNG
- **Avif** (Firefox): libaom AVIF, then JS `avifToMp4` rewrap

Drag uses `interactiveEdge` 960; settle uses the full prepared frame. Tone and
colour are never approximated, only resolution.

## 3. Where the time goes

Timed inside `grade_from` at a ~9.8MP settle (DESIGN §21.1.1):

| Stage | ms | Share |
|---|---|---|
| Copy | 3–5 | noise |
| Grade | 118–146 | ~10% |
| PQ | 6–15 | noise |
| **Finish** | **837–1035** | **~80% track/still, ~60% AVIF** |
| Emit | 106–190 (pack) / 146–189 (PNG) / 617–798 (AVIF) | rest |

A drag tick at 960 is 88ms (PNG route) and 119ms (AVIF), delivering 7-12fps
depending on route (DESIGN §21.2, §21.3).

## 4. The goal, and three costs

**The goal is a full-resolution tick, not a faster settle.** Every tick, drag
included, graded at the frame's real size, which is what would let
`Resolution::Interactive` and the whole 960 preview path be deleted rather than
optimised. Read the rest of this note against that target: reducing pixel count
is a lever on the current pipeline, not the destination.

A tick costs

**pixel count** × **per-pixel work** + **delivery to the compositor**

and a GPU addresses only the middle factor. The other two are larger than they
look, cheaper to move, and need no device, no second implementation and no
fallback story. They also do not conflict with the full-resolution goal: the
right size for a tick is the size the stage can show, which on most displays is
below 3840 and on a 5K one is above it (§4.1). "Full resolution" means the frame
is not deliberately degraded for the drag, not that the pixel count is fixed by
a constant.

### 4.1 The pixel count is a constant nobody chose for the screen

`EDIT_LONG_EDGE = 3840` in `photo_detail_page.tsx` is the only thing that sets
the editor's working size. It reaches `EditorSpec::long_edge` and then
`decode_frame_bytes` as `at_least_long_edge`, which picks LibRaw's half-size
ladder step where one fits (`full_long_edge / 2 >= at_least`) and has
`copy_processed` fit the result to exactly that edge. `hdr::prepare` then runs
with no `fit_to` precisely because the decode is already bounded. So one
constant fixes the decode size, the `prepared` buffer, the settle's pixel count,
the emitted frame, and most of the resident set: 841MB to 1.24GB on the track
route and 1.4GB to 2.17GB on the still route, moving from 1920 to 3840
(DESIGN §21.2).

It is inherited from the rendition default, a size chosen for a file kept
forever, and nothing on screen agrees with it. There is no zoom in the editor
(§21: Edit replaces the stage, Done discards), so the only resolution that means
anything is the stage's own physical pixels.

Everything in §3 is linear in pixels above a fixed floor (the 65536-entry LUTs,
and `scene_peak_nits`'s 1M-sample quantile), so sizing to the stage moves every
row of that table together. **The size of the win is not fixed, and it is not
always a win:**

- 1440p at dPR 1, portrait frame at ~1200px of stage height: under 1MP on
  screen against 9.8MP graded, so most of a tick is spent on pixels that are
  resampled away before they are seen
- A 16" laptop or a 4K panel at dPR 2: roughly 2.5-3MP on screen, 3-4x
- A 5K panel (5120x2880, dPR 2), portrait frame at full stage height: ~2600
  physical px on the long edge, so 3840 is ~2.2x more pixels than are shown
- **A 5K or 6K panel with a landscape frame filling the stage width: 3840 is
  too small.** ~4000+ physical px are needed, so the emitted frame is upscaled
  by the browser and `presenter.settleExposure`'s "the frame that gets judged,
  at full resolution" is not true there. `finish` is a sharpen and a denoise,
  which is exactly what cannot be judged through an upscale

So the fix is two-directional, and that matters more than the 2-4x: the constant
is currently wrong in both directions and only accidentally right in the middle
of the range.

Mechanically the machinery exists: pass the stage's
`clientWidth * devicePixelRatio` (or `clientHeight`, whichever bounds the frame)
as `longEdge` at open. A window moved to a larger display then wants a reopen,
which is what a route change already does.

**Keep a cap.** The constant is also doing memory duty, and the still route was
measured at 2.17GB resident at 3840. Following a 5K display upward without a
ceiling walks straight past that, so the shape is
`min(stage physical long edge, CAP)`, with the GPU path (§6) being what makes a
larger CAP affordable rather than something to adopt first.

### 4.2 A drag pays 80ms for a filter it cannot show

`Radii::for_strength` and `LUMA_DENOISE_RADIUS` are absolute pixel radii scaled
by strength alone, and `measure_noise` / `measure_defocus` are whole-frame. So
at 960 every filter in `finish` covers roughly 4x the *picture* it covers at
3840: the drag is already showing a different denoise and a different sharpen
from the settle it lands on. It pays ~80ms of its ~88ms tick to do that.

§21's contract is that tone and colour are exact and resolution is disposable.
`finish` is neither tone nor colour, and at drag resolution it is already
approximated. Dropping it during a drag (or keeping only defringe, one
five-point Laplacian) leaves grade + PQ, about 13ms at 960, which is the first
time anything here has been inside a frame budget. No device, no shader, no
twin.

### 4.3 Delivery caps the two blob routes, not compute

DESIGN §21.3: 88ms and 119ms ticks both deliver 7-8fps, so something outside the
tick sets the rate, and it is the blob → object URL → browser decode per tick.
GPU compute does not touch that at all. It is the same finding that makes §7
worth more than it looks.

## 5. GPU accelerability, stage by stage

| Stage | GPU-shaped? | Worth it? |
|---|---|---|
| **Finish** | Yes, guided filters + Richardson-Lucy are classic image kernels | **Yes**, dominates settle |
| Grade | Yes, per-pixel LUT / matrix plus one sampled reduction | Marginal (~130ms) |
| PQ / pack | Yes, trivial | No, already cheap |
| PNG / AVIF | No, entropy coding is serial / warp-divergent | No (same argument as server AV1 in DESIGN §10.4) |

DESIGN §10.4's "why not a GPU" is about the **server import** budget (decode /
fit / AV1). It does not rule out WebGPU for the **editor tick**; the bottleneck
and the runtime are different. Note the converse too: `finish` is a *shared*
stage, so a GPU `finish` would answer part of the import budget that §10.4 never
addressed, since §10.4's objections are about the unpack and the coder.

## 6. If the GPU is the answer, the frame should live there

The shape this note first described, view the shared heap, `writeBuffer`,
dispatch, `mapAsync`, write back, is the worst available version: it pays two
transfers per tick to accelerate the middle of a tick. It is a stage swap, not
an architecture.

`Prepared` is immutable between camera matches. That is the entire point of the
type, and it is what makes the resident-frame shape obvious:

- **Once at open**: upload `prepared` (59MB at 9.8MP), the camera match's colour
  tables, and the PQ LUT
- **Per tick**: write a uniform (exposure, levels, peak, strengths), tens of
  bytes, then dispatch grade → PQ → finish over resident textures
- **Readback**: only what the sink needs, and on one route nothing at all (§7)

Stage 1 of §2 disappears with it: nothing is trampled, so there is no working
copy to refresh. So does `Resolution::Interactive`, once a full-size tick lands
inside a frame, and with it `preview`, the second `Prepared` and `shrunk_to`.
That deletion is the goal (§4), not a side effect: the CPU/GPU twin is usually
argued as pure addition, and it is not.

### 6.0 One shot, so keep everything GPU-shaped adjacent

The stages worth running on the GPU should be contiguous, so a tick is one
upload boundary and one download boundary rather than one per stage. Today they
almost are, and the exceptions are the interesting part:

- **grade → PQ → finish** are already adjacent, and all three are GPU-shaped.
  That run is the single shot
- **`pack` belongs inside it.** It is per-pixel matrix work plus a dither, sits
  immediately after `finish`, and is currently the one CPU stage between the
  pixels and a `VideoFrame`. Moving it in means the download is I444 planes
  written by the same dispatch chain. Note it is not a bandwidth win at 10 bits
  (three full planes of `u16` is what an RGB `u16` frame already costs), it is
  one less CPU pass and one less boundary
- **The open-time stages can go too.** `prepare`, the lens warp and the shrink
  all run once and feed a buffer nothing else reads. Doing them on the GPU means
  the decode uploads once and `prepared` never exists in wasm memory at all,
  which removes the 59MB per-open upload as well
- **Only the encoders stay CPU**, and only on the routes that need one (§7)

The ordering constraint that survives is `finish`'s: defringe before either
denoise, chroma guided by cleaned luma, sharpen last (§10.9). That is a
dependency chain between dispatches, not a reason to round-trip.

### 6.1 The limits are defaults, and defaults are the floor

Every WebGPU limit quoted here is what a device gets when it asks for nothing.
The adapter's own maximum is usually far higher, and reaching it is one line at
device creation:

```js
const shared = Math.min(32768, adapter.limits.maxComputeWorkgroupStorageSize);
const device = await adapter.requestDevice({
  requiredLimits: { maxComputeWorkgroupStorageSize: shared },
});
```

Three things make that worth writing down rather than assuming. Asking for more
than the adapter has **rejects** rather than clamping, so the clamp is the
caller's. The shader then has to branch on `device.limits`, not on what it asked
for. And an adapter is **consumed** by its first `requestDevice`, so a fallback
device needs a second `requestAdapter` rather than a second call.

A raised limit is therefore not a free win: it is a second code path, worth
taking only where the default genuinely does not fit. The request itself costs
nothing, but spending the memory does - a workgroup claiming 32KB halves how many
an SM can hold resident, which is how a GPU hides memory latency.

Measured on this machine's integrated RDNA2, defaults against what the adapter
actually offers:

| limit | default | this adapter |
|---|---|---|
| `maxComputeWorkgroupStorageSize` | 16KB | 64KB |
| `maxStorageBufferBindingSize` | 128MB | 4GB |
| `maxTextureDimension2D` | 8192 | 16384 |

The design consequences, at the defaults:

- an interleaved f32 RGB frame at 9.8MP is 118MB, inside the 128MB binding by 8%
  and over it at any larger edge. Per-plane buffers (39MB) or textures do not
  have the problem, and neither does a raised limit where one is available
- the 9504-wide frame `strip_interior` exists for does not fit an 8192 texture,
  so the native-resolution case tiles unless the limit is raised
- a workgroup histogram wants 8192 bins at 4 bytes, which is 32KB: over the
  default, inside this adapter. That is exactly the case for a two-level
  histogram rather than a raised limit, since the fallback has to exist anyway
  for the parts that stop at 16KB - which is most mobile hardware

Tiles are not strips: no `carry` rows, no sequential dependency. But the reason
`halo()` computes a reach (a guided filter of radius r reaches 2r, composed
three deep, plus the deconvolution) applies unchanged to a tile's overlap.

**A feature is not a limit, and `float32-filterable` is the one with no
fallback.** A limit clamps; an optional feature is simply absent, and that one is
absent on every Apple GPU - Metal gates 32-bit float filtering behind
`MTLDevice.supports32BitFloatFiltering`, true on a few iPad parts and on no
iPhone. Requiring it refused every RAW on iOS at the open, matched or not, since
the device is requested before the frame arrives. So the tick requires nothing:
the chroma map is `rgba16float`, which core WebGPU filters everywhere, and the
tone curve's `r32float` is declared `unfilterable-float` - `sample_curve` only
ever loads from it, and the default `float` sample type is rejected against a
format the device cannot filter, at bind-group creation, asynchronously.

Half precision costs 2^-11 on nodes bounded near 1, measured rather than argued:
the worst pixel over every colour the lattice spans moves 0.109 deltaE ITP, where
1.0 is the threshold of visibility, and §6.3's parity mean goes from 0.14 to 0.18
counts against a 0.5 pin. The corrections multiply chroma differences, so the
error vanishes on the grey axis where the eye is least forgiving, and quantising
nodes before interpolating them leaves the surface continuous. The same treatment
of the tone curve does not: it changes the step between neighbouring levels by
eleven times the step itself, which is a contour, and is why `sample_curve`
interpolates by hand.

### 6.2 wgpu in Rust, not a device in JS

A device in JS with shaders beside it is a second implementation of `finish` in
a second language. That is precisely the divergence §21.1 exists to prevent, and
this codebase has already paid for it twice: the editor's own copy of the grade
lost the camera match, and its own decode fringed blown skies magenta.

wgpu compiles to WebGPU on wasm and to Vulkan / Metal / DX natively, so one
Rust implementation serves the editor tick **and** the server's renditions,
which run the same `finish` per file. The kernels stay next to the CPU code they
must agree with, and the pins can compare them in one process.

Async does not go away: wgpu on wasm still needs the event loop, so the entry
point becomes an exported `async fn` returning a Promise, driven between wasm
calls. Same conclusion as §8, reached in Rust instead of JS.

### 6.3 What has to match, and what does not

"Keep a CPU twin that matches renditions byte-for-byte" is what makes this look
impossible. Box means over 9.8M pixels and Richardson-Lucy iterations summed in
a different order do not reproduce CPU f32 arithmetic bit-for-bit on any
hardware, and no amount of care changes that.

Split the requirement the way §21 already splits resolution from tone:

- **Grade and PQ must match exactly.** Tone and colour are the promise the whole
  editor exists to keep. Both are per-pixel work over tables the CPU builds and
  uploads, so exactness here is achievable rather than merely desirable
- **Finish may deviate within a bounded tolerance.** It is denoise and sharpen,
  it is already resolution-dependent (§4.2), and the drag already deviates from
  the settle. Pin it as a bounded difference against the CPU result, not as
  equality

Without that split there is no GPU path worth starting. With it, the part that
carries risk is small, and it is the part a tolerance pin can actually guard.

## 7. The emit stage may be the thing that disappears

Three sinks exist for one reason: from a worker there is no way to hand HDR
pixels to a compositor except as media. A frame already sitting in a GPU texture
has another: a WebGPU canvas.

- **Chromium: measured working.** Chrome 151, M-series MacBook Pro, XDR panel,
  `rgba16float` + `toneMapping: { mode: 'extended' }` + colorSpace `srgb`:
  values above 1.0 light the panel above SDR white, and the ladder plateaus at
  an encoded 3.0. No encode, no blob, no `VideoFrame`, no track, and it takes
  the still route's unrecoverable `cc::ImageDecodeCache` growth (§21.2, ~500MB
  per six-second drag) with it
- **Safari: measured working, and it is the surprise.** Safari 26.4, same
  machine and panel, `rgba16float` + extended + colorSpace `display-p3`: same
  behaviour as Chrome, and the 203 to 1000 nit ramp steps all the way up. So the
  PNG-per-tick route exists only because a `VideoFrame` there is 8-bit, and a
  canvas is not a `VideoFrame`. **The still route's encode, its blob, its browser
  decode and its unrecoverable decode cache are all replaceable on the engine
  that needed them most.**
- **Firefox**: composites HDR through video and only video, measured (§10.7), so
  the AVIF rewrap survives whatever happens here. Readback stays on that route:
  59MB, ~10ms, against the 617-798ms encode it feeds

So on macOS the route table collapses from three to two: a canvas for Chromium
and Safari, the AVIF rewrap for Firefox, which composites HDR through video and
only video no matter what its WebGPU support does. Three questions stood between
here and that, none of them about performance, and §7.1 to §7.4 answer all
three: the mapping is a constant, the gamut needs no bespoke handling, and above
the headroom the canvas is no worse than the media path it replaces.

### 7.1 The canvas is relative where PQ is absolute

Two measured facts change what the final transfer has to be, and the second one
is the awkward one.

**The canvas carries the sRGB transfer, not linear light.** Measured against a
CSS `rgb(128,128,128)` swatch: a canvas value of 0.5 matches it, 0.2158 does
not. So an `rgba16float` canvas in the `srgb` space is sRGB-encoded with the
curve simply evaluated past 1.0, and the mapping is
`srgb_encode(nits / sdr_white_nits)`, not `nits / 203`. A value of 3.0 is about
12.8x SDR white in luminance, which is what the measured plateau actually means.

**The reference white is 203 nits, and it is the browser's constant rather than
the display's.** This looked like the blocking problem: PQ is absolute, an
extended canvas is relative to whatever SDR white the OS is showing, and no API
reports it (`screen.highDynamicRangeHeadroom` is unsupported in both engines).
The §7.3 comparison answers it directly. Sweeping the divisor against a real PQ
AVIF of the same pixels, the two arms match at **203**, in both engines: below
it the canvas is brighter than the media path, above it darker, and the change
is a uniform scale with no clipping at any setting.

203 is BT.2408's reference white, and the compositor is evidently using it to
bring the AVIF's absolute nits into the same extended-range space the canvas
writes into. So the mapping is a constant, `srgb_encode(nits / 203)`, and it
does not have to be measured, guessed, or tracked as the user moves the
brightness slider: **both paths are relative to the same number, so they move
together.**

Two things follow. The headroom does not need to be readable after all: the EETF
can keep rolling off to the configured `peak_nits` exactly as it does now, and
whatever the panel cannot show is the compositor's problem on both paths
equally. And the 203 is *not* `Grade::reference_white_nits`, which is a library
setting a user can move; it is the browser's fixed constant, so the divisor
stays 203 even when the library grades to a different anchor.

**Safari composites the first paint without the headroom.** On first load,
lowering the divisor made the bright tiles clip and merge; switching to another
app and back fixed it, after which it behaved exactly as Chrome does. So the EDR
headroom is negotiated lazily there and the page can be painted before it
arrives. In the editor that would read as a first frame that looks flat and then
silently corrects itself, which is worth knowing before it is diagnosed as a
grading fault.

**Nothing a page can do clears it, and it does not reach the editor anyway.**
Tried and measured as ineffective: redrawing, `unconfigure` plus `configure`,
recreating the drawing buffer, `dynamic-range-limit: no-limit`, and a continuous
`requestAnimationFrame` loop. Only an app switch works, so the state belongs to
the window rather than to anything script owns.

What bounds it is that the fault only appears with the divisor **below** 203,
which is a request for more headroom than the window has been granted. The real
app has no such knob: the divisor is fixed at 203, the grade rolls off to
`hdr_peak_nits`, and at the shipping default of 1000 that asks for 4.9x SDR
white against the ~12.8x measured on that panel. So on a first paint the editor
sits comfortably inside the initially granted headroom and never enters the
failing state. It stops being comfortable if `hdr_peak_nits` is raised well
above 1000, or on a display whose headroom is small because SDR brightness is
high.

Incidental from the same runs, worth knowing before relying on any of it: on
that machine `(dynamic-range: high)` is true while `(video-dynamic-range: high)`
is false, in **both** engines. Both also accept `toneMapping: 'extended'` on
`bgra8unorm` and `rgba8unorm` and echo it back from `getConfiguration()`, so the
echo proves nothing: only a float format can carry a value above 1.0. And the
two disagree about `screen.colorDepth` on the same panel, 30 in Chrome and 24 in
Safari, so that is not a capability signal either.

### 7.2 The canvas has no Rec.2020

`GPUCanvasConfiguration.colorSpace` is `srgb` or `display-p3`. Nothing else. The
grade works in Rec.2020 and the renditions are tagged Rec.2020, so a canvas path
needs a primaries conversion at the end that the media path never needed: PQ
frames are tagged and the compositor converts.

The conversion itself is a 3x3 matrix, i.e. free on a GPU and exactly the kind
of thing that belongs in the last dispatch of §6.0. What is not free is what
happens to Rec.2020 colours outside P3. Through that matrix a Rec.2020 green
becomes P3 `(-0.568, 1.033, -0.150)` and a Rec.2020 red becomes
`(1.138, -0.283, 0.036)`, so out-of-gamut shows up as negative components, which
an extended-range float canvas can carry in principle, the way scRGB does.

**Measured: it does not, or it makes no difference.** Both engines, same XDR
panel: the negatives-kept patch and the clipped-at-zero patch are
indistinguishable, for both the green and the red.

That result cannot separate the two explanations, and on this hardware it does
not need to. The panel is P3, so a Rec.2020 green is outside what it can emit
whatever the pipeline carries; a canvas that clamped and a canvas that carried
the value into a compositor that then gamut-mapped for the display would both
end up somewhere on the P3 hull. Any test that would tell them apart needs a
display wider than the colour being tested, which is not the hardware this ships
to.

**And the comparison in §7.3 says it does not matter, because the two paths
already agree.** Every colour matched between the AVIF and the canvas, in both
engines, including the Rec.2020 primaries and secondaries at 203 and at 600 nits
which are all outside P3. So whatever the compositor does to an out-of-P3 PQ
colour lands in the same place as the matrix plus a plain clamp does.

That is the requirement, and it is worth being precise about which one: the
editor does not have to be *right* about a colour the panel cannot show, it has
to be *the same* as the rendition beside it. It measurably is. So no bespoke
gamut mapping is needed, and adding a hue-preserving compression would now be a
way to introduce a difference rather than remove one. Revisit only on hardware
wider than P3, where the two paths have room to disagree.

### 7.3 The comparison that settles it

The question §7.1 and §7.2 both end on is whether a PQ Rec.2020 frame down the
media path and the same pixels through a canvas land in the same place on one
panel. That is a comparison, not a probe, so it needs a fixture rather than a
feature test.

`native/rawshim/examples/pq_pattern.rs` writes the media arm: a Rec.2020 PQ
10-bit 4:4:4 AVIF at quantizer 0, through the same `avif::save_still` and the
same CICP a rendition is written with. `/codebox-workspace/bowerbird/hdr-compare.html`
puts that in an `<img>` and rebuilds the same samples for the canvas arm, from
the same nits table and the same ST 2084 curve, then runs them through what the
final GPU dispatch would do: PQ decode to nits, Rec.2020 to P3 in linear light,
divide by SDR white, sRGB encode. The two arms were checked identical to the
sample, 2.16M of them, against the Rust buffer. Rebuilding rather than fetching
is what lets the page open straight off the filesystem, since `file://` blocks
`fetch` but not an `<img>`. Adjacent for a seam, and overlaid on a 2Hz
flicker, which catches what a seam does not. The pattern is a neutral ramp at
100 to 1000 nits, the Rec.2020 primaries and secondaries at two levels, every
one of which is outside P3, and a fourth row from 1500 to 10000 nits that no
display can show (§7.4).

It also measures the number §7.1 said was unreadable: the divisor at which the
neutral ramp stops stepping at the seam. That came back as 203 in both engines,
which is what turned the relative-versus-absolute problem into a constant.

**Result: the canvas path is validated end to end on macOS.** Colour matches,
including every out-of-P3 patch; luminance matches at a fixed divisor; the
divisor is a browser constant rather than a display property, so it does not
move under the user. What is left is implementation, and the one operational
wrinkle is Safari's first paint (§7.1).

Note both engines were run at their own default in the probe (Chrome on `srgb`,
Safari on `display-p3`) and agreed. That is expected for the neutral patches
used: both spaces are D65 with the sRGB transfer, so greys are identical in
either, and only chromatic values would separate them.

Rank this against `finish` rather than after it. On the track route emit is
106-190ms of a 1.2s settle *and* the whole of the drag's delivery ceiling
(§4.3), and unlike `finish` it removes code rather than doubling it.

**Probe page**: `/codebox-workspace/bowerbird/hdr-canvas-test.html`, which
established support, the transfer, the headroom and the gamut clamp. The 203
divisor and the colour match came from the comparison page instead, since
neither can be seen without a real PQ frame to hold them against (§7.3). Pairs
an extended canvas against an identical standard one at 1x to 12x SDR white, so
"configured happily and did nothing" is visible rather than inferred, reads the
`getConfiguration()` echo for every format and mode, settles whether the float
values are linear or sRGB-encoded against a CSS swatch, and renders the
library's own 203 to 1000 nit ramp. It also renders the ladder into an offscreen
`rgba16float` texture and reads it back, so a black canvas can be attributed to
presentation rather than to the shader. Verified on SwiftShader here: the
readback is exact (1, 1.5, 2, 3, 4, 6, 8, 12) and every combination configures.
Canvas presentation itself cannot be checked headless, where even a minimal
WebGPU canvas composites nothing, so the visual half needs a real machine.

### 7.4 Above the headroom, both paths clip, and the canvas is not the worse one

The expectation here was that the two would fail differently: PQ carries
absolute nits, so a compositor knows both the content's brightness and the
panel's and could roll off, while an extended-range canvas value carries no such
information and can only clip. Row 4 of the pattern (1500 to 10000 nits, past
any display) says otherwise.

**Chrome clips both paths, identically, at every brightness.** There is no
graceful roll-off on the media side to lose. What moves is the headroom, with
the SDR brightness slider:

| SDR brightness | row 4 separates up to |
|---|---|
| 100% | nothing, the whole row is one block |
| 75% | 1500 nits |
| ~55% | 3000 nits, 4000 and above merged |

So the headroom is roughly 15x SDR white at 55% brightness and under 7x at 100%,
and the frame's own peak is `hdr_peak_nits / 203`, which is 4.9x at the shipping
default. The editor is inside it at moderate brightness and approaching it at
maximum, on both paths equally.

**Safari clips harder, and there the canvas is the better of the two.** Its
whole HDR presentation reads as weaker, its peak brightness lower, and its AVIF
arm is fully clipped across row 4 while the canvas arm still separates 1500 from
the rest. Consistent with the first-paint behaviour in §7.1: WebKit is stingier
with headroom throughout. Whatever else that means, replacing the still route
with a canvas does not cost highlight rendition on Safari, it gains a little.

Two things follow. The canvas path carries **no** clipping risk the current
media path does not already have, which retires the concern this section was
opened to record. And what actually governs whether highlights clip is our own
EETF target: `peak_nits` at 1000 is a reasonable choice against a headroom that
is 5x to 15x depending on a slider we cannot read. If a headroom API ever lands
(§7.1: unsupported in both engines today), pointing the EETF at it would be a
real improvement over a fixed 1000, and it would improve the rendition path at
the same time.

## 8. Can the editor worker reach a GPU?

**Yes, from the editor dedicated worker. Not usefully from a rayon thread.**

Topology today:

```
main (RawEditPresenter)
  └─ daemon worker (owns SAB + rayon pool)
       ├─ editor worker  ← grades here (initSync into shared heap)
       └─ N rayon workers (wbg_rayon_start_worker, sync wasm loop)
```

### Editor worker

`navigator.gpu` is on `WorkerNavigator`. A dedicated worker can
`requestAdapter` / `requestDevice` and run compute. WebGPU asks only for a
secure context, already satisfied; the page's cross-origin isolation is there
for SAB / rayon and neither buys nor costs anything here.

**A tick blocks the editor worker too.** `grade_from` runs under `with_pool`,
i.e. `pool.install`, so the editor's own thread joins the work and its event
loop is parked from `copy` to `emit`, the same sync/async wall the rayon workers
hit, released between ticks rather than never. So the two placements are not
interchangeable:

- **Device on the editor worker**: the GPU stage has to be driven *between* wasm
  calls (`grade` split pre / GPU / post), since the promises only settle once
  the handler returns. Nothing can orchestrate a device on its own worker from
  inside a blocking call: waiting for `mapAsync` deadlocks the loop that would
  resolve it
- **Device on a sibling GPU worker**: wasm can stay the orchestrator, blocking
  on `Atomics.wait` for a flag the sibling writes to the shared heap. No copy
  either way, the sibling addresses the same memory

`GPUDevice` / buffers / textures are **not transferable** between workers yet.
Create the device where it will be used, do not `postMessage` it from main or
the daemon.

SAB caveat: uploading a TypedArray over the shared heap is intended
(`AllowSharedBufferSource`); some engines have historically rejected SAB-backed
views and needed a copy. Measure, don't assume free.

### Rayon threads

Rayon pool workers are also dedicated workers, so they *have* `navigator.gpu`
in theory. In practice:

- After `wbg_rayon_start_worker` they park in a **sync** wasm run loop, no
  awaiting promises mid-`par_iter`
- WebGPU is **async** (`requestDevice`, `mapAsync`, queue completion)
- One device cannot be shared across those workers anyway

So GPU cannot sit under `finish`'s rayon strips. GPU **replaces** that parallel
CPU work (one queue, one device off the pool), rather than nesting inside it.

### 8.1 Does the pool survive the port?

If the GPU takes grade, PQ, finish and pack, and the canvas takes emit (§7),
then nothing on a tick is threaded any more. Which raises the real prize:
`SharedArrayBuffer`, wasm-bindgen-rayon, the patched fork, the daemon worker,
the pool teardown choreography, the `+atomics` / `--shared-memory` /
`--import-memory` build, `wasi_stub`'s memory plumbing, and the cross-origin
isolation the whole page carries for it.

**The tick stops needing threads. The open does not.** Measured with
`native/rawshim/examples/open_threads.rs`, which runs the same stages as
`Editor::new` plus `fit_camera_match` on a 24MP ARW at the 3840 edge, native, 12
threads against 1 (native numbers, so read the ratios and not the absolutes):

| Stage | 12 threads | 1 thread | cost |
|---|---|---|---|
| LibRaw decode | 349ms | 651ms | 1.9x |
| `hdr::prepare` | 25ms | 28ms | none, its quantile is a fixed sample count |
| preview JPEG | 19ms | 17ms | none, single-threaded either way |
| camera fit | 413ms | 1495ms | 3.6x |
| lens warp | 99ms | 710ms | **7.2x** |
| interactive shrink | 3ms | 18ms | 6x |
| **open, total** | **908ms** | **2918ms** | **3.2x** |
| one 960 tick | 76ms | 245ms | 3.2x (moot, this is the GPU's) |

So dropping the pool naively costs about two seconds on a one-off open, behind a
progress state that already exists. A 61MP body from the same set moves the
decode rather than the ratio: 1058ms against 1231ms, open 1707ms against 3520ms.

Most of that regression follows the pixels onto the GPU anyway (§6.0): the warp
is a pure gather and the worst single offender at 7.2x, the shrink is a box
resample, and `prepare` never mattered. What genuinely cannot go is LibRaw's
decode, which is bit-serial unpack and demosaic in C, and the camera fit, whose
refine is a sequential hill-climb (DESIGN §10.4). That leaves roughly
651 + 17 + 1495 = 2.2s of single-threaded open against today's 908ms.

**So it comes down to one question: is a CPU tick still a supported fallback?**

- **If WebGPU is required**, all of it goes. The reference implementation for
  renditions is the *server's* native build, which keeps rayon and is untouched
  by any of this, so "keep the CPU path as the reference" (§9) does not require
  keeping it in the browser. The cost is a slower open and no editor at all on
  an engine without WebGPU; the gain is deleting every item in the first
  paragraph, including cross-origin isolation, which the rest of the page pays
  for and only the editor needs
- **If a CPU tick has to keep working**, none of it goes, because a
  single-threaded `finish` is 4x worse than a pool that is itself the reason
  settle costs a second. A fallback that slow is arguably not a fallback

Worth noting the encode side is already threadless: libaom in the module is
built single-threaded (DESIGN §21.3), so Firefox's rewrap route does not depend
on the pool either.

| Where | Verdict |
|---|---|
| Editor worker driving the device between wasm calls | Viable |
| Sibling GPU worker, editor blocking on `Atomics.wait` | Viable, and the only shape that keeps wasm the orchestrator |
| Daemon owning GPU | Bad fit: it is deliberately free of pixel work so `kill` can run while the editor is blocked mid-tick |
| Inside rayon / wasm `par_chunks` | Dead end until WebGPU multi-worker + sync GPU (neither exists) |

## 9. Order of work

Cheapest first, and the first three are not GPU work at all:

1. **Settle at the stage's size, capped** (§4.1). One constant, 2-4x off every
   row of §3 on a typical display, and a *correctness* fix on a 5K or 6K one
   where 3840 is currently too small to judge a sharpen through
2. **Drop `finish` from the drag** (§4.2). ~80ms of an ~88ms tick, for a filter
   whose output the drag cannot show anyway
3. **Cache the PQ LUT.** `tone::encode_pq` rebuilds 65536 entries (two `powf`
   each) on every call and it depends only on `peak_nits`. Free, and it is most
   of the PQ stage at drag resolution
4. **Replace `emit` with a canvas on Chromium and Safari** (§7). Measured
   working end to end against a real PQ AVIF of the same pixels: colour,
   luminance, and behaviour past the display's headroom, where it turns out to
   match Chrome exactly and to beat Safari's own image path. So this is
   implementation rather than investigation: two of the three sinks go and
   Firefox keeps the rewrap. The last dispatch ends with the Rec.2020 to P3
   matrix, a plain clamp, and `srgb_encode(nits / 203)`. The EETF stays exactly
   as it is
5. **Only then port `finish` with wgpu** (§6), resident frame. Whether the
   browser keeps a CPU tick as a fallback is the decision that also decides
   whether `SharedArrayBuffer`, the pool and cross-origin isolation can be
   deleted (§8.1); the *reference* implementation is the server's native build
   either way

Steps 1-3 need no device, no twin, no tolerance pin and no engine-coverage
argument, and they are what makes the current pipeline bearable while 4 and 5
are built. They are not the destination: only 5 delivers a full-resolution tick
(§4), and 2 is explicitly a stopgap that the full-resolution tick then reverts.

## 10. Tauri changes the answer to two of these

A native shell with a webview removes the two constraints this note spends the
most words working around, so it is worth writing down which conclusions are
browser-shaped and which survive.

**Survives.** The resident-frame architecture (§6), the adjacency argument
(§6.0), the exact-grade / tolerant-finish split (§6.3), and the whole of §4:
none of those are about WebGPU, they are about where the pixels live and what
has to match.

**Gets much stronger.** wgpu in Rust rather than a device in JS (§6.2). In a
Tauri build the same kernels run natively against Vulkan or Metal, in the
browser build against WebGPU, and on the server for renditions. One
implementation, three runtimes, which is the §21.1 anti-divergence argument
taken as far as it goes. A device in JS could never have reached the native
build at all.

**Goes away.** Most of §8. There is no rayon-worker sync wall, no
`Atomics.wait` hop, no non-transferable `GPUDevice` between workers, and no
async-only `mapAsync`: native wgpu can block on a submission and the pixels can
be handed to a native encoder without ever entering JS. §8.1's question stops
being a trade too: native threads need no `SharedArrayBuffer` and no
cross-origin isolation, so the open path keeps its pool for free and only the
browser build has to choose.

### 10.1 Linux has no WebGPU in WebKit, so Linux does not get WebKit

The conclusion below stands as a fact about `webkit2gtk` and is now routed
around rather than lived with: `docs/tauri-cef-evaluation.md` has Linux on
**`tauri-runtime-cef`**, a bundled Chromium, with wry's system webview on macOS
and Windows. That is a per-target Cargo feature (that doc's §4.4), so the switch
itself is nearly free.

With that, every platform has WebGPU: WebView2 and CEF are Chromium, and
WKWebView has it from macOS 26. **The canvas plan reaches all three**, and §10.2
collapses to one answer instead of one per platform.

Two things worth carrying back to that evaluation, since it was written against
the streaming design rather than this one:

- **Its §4.4 dilemma dissolves.** "CEF everywhere or CEF on Linux only" is
  forced there by the native editor needing an open-ended custom-protocol
  response to push frames into, which only CEF can hold open, so a mixed build
  would fork the editor's transport. A canvas needs no stream at all: one
  transfer per *open* (§10.2b), which wry's one-shot protocol serves perfectly
  well. The mixed build stops being a trap and becomes the obvious choice, and
  only Linux pays CEF's ~180-240MB
- **The latency risk it names goes with it.** "A media pipeline buffers to smooth
  jitter, and a slider wants the newest frame now" is a real problem for a pushed
  video stream and a non-problem for a texture that is already resident on the
  GPU. There is no encode, no container, no buffer and no decode between a slider
  move and a dispatch

What it gets right and this note agrees with: `routeFor()` and all three arms go,
the wasm module leaves the shell, and `SharedArrayBuffer` with it (§8.1).

One caveat that is nobody's webview: HDR *presentation* on Linux is a compositor
question (Wayland colour management, nothing on X11), not an engine one. CEF
gets the pipeline running there; whether the panel lights is a platform matter
and is nascent generally.

### 10.1.1 Why WebKit was the blocker

Measured here: Playwright's WebKit 26.5 Linux build (WPE headless) reports
`navigator.gpu` as **absent**. Not conclusive for `webkit2gtk` specifically,
since it is a different build of the same engine, but WebGPU is a build-time
feature in WebKit's Linux ports and it is off here. Hardware is not the reason:
Chromium on the same box takes a real Vulkan adapter (`amd / rdna-2`) and runs
the probe fine, so the engine is the difference rather than the machine. Add that Linux HDR
presentation needs the Wayland colour-management protocol, which is new and
absent on X11 entirely, and the canvas plan does not reach a Tauri Linux build
at all today.

The webview per platform is what decides which option is even available:

| Tauri platform | Webview | WebGPU | Canvas plan (§7) |
|---|---|---|---|
| macOS | WKWebView (wry) | yes, from macOS/iOS 26 | works, with an OS floor |
| Windows | WebView2 (Chromium, wry) | yes | works |
| Linux | CEF (bundled Chromium) | yes | works |
| ~~Linux~~ | ~~webkit2gtk~~ | ~~no~~ | ~~why Linux takes CEF~~ |

**macOS carries a deployment floor rather than a doubt.** Safari's feature flags
do not reach WKWebView: Apple's own answer to a developer hitting exactly this
was that "these feature flags only impact Safari and not WebKit generally. For
WKWebView, the feature will work when it's enabled by default", and on 18.2
`navigator.gpu` was simply absent in an embedded webview while Safari beside it
had it. That changed in 26, where WebGPU is on by default and therefore reaches
WKWebView. So a Tauri build gets the canvas path on macOS 26 and later, and gets
nothing on 15 and earlier. No entitlement or private setting bridges the gap.

**Linux is not a configuration problem, and no launch argument reaches it.**
WebKit's own build definition is
`WEBKIT_OPTION_DEFINE(ENABLE_WEBGPU "Toggle WebGPU support" PRIVATE OFF)`: a
**compile-time** option, off by default, and `OptionsGTK.cmake` never turns it
on. So WebGPU is not built into the `webkit2gtk` anyone ships, and nothing at
runtime can enable what is not compiled. Reaching it would mean building and
distributing our own WebKitGTK.

Worth separating from the thing that *is* runtime-toggleable, because the two
get confused: `UseGPUProcessForWebGL` is a WebKit runtime feature, settable
through `webkit_settings_set_feature_enabled` and therefore reachable from wry,
but it is about moving **WebGL** into the GPU process and has nothing to do with
WebGPU. Turning it on buys nothing here.

Launch arguments do matter on the other platform, though: WebView2 takes
Chromium switches through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` or wry's
`with_additional_browser_args`, which is where an `--enable-unsafe-webgpu` would
go if a given runtime ever needed it.

### 10.2 Three ways to get pixels on screen under Tauri

**(a) Encode natively, deliver as video.** Reintroduces exactly what §7 just
deleted: an encode per tick, plus a decode in the webview, plus muxing and
buffering latency, and it is the design `docs/tauri-cef-evaluation.md` was
written around. Kept here only as the shape being replaced.

**(b) The frontend owns the GPU, the backend owns the open.** The canvas and the
shaders live in the webview, already measured working end to end on macOS
(§7.3), and available on every platform once Linux runs CEF (§10.1).

The part worth spelling out is that **the tick path needs no wasm at all**.
`Prepared` is immutable between matches (§6), so:

1. Open: the Rust backend, natively and with real threads, does LibRaw, the fit,
   the warp and the shrink. §8.1's 3.2x single-thread regression never happens,
   because nothing here is running in a browser
2. Transfer, once per photo: `prepared` crosses to the webview as bytes over a
   custom protocol, `fetch` to an `ArrayBuffer`. 59MB at 9.8MP, or ~27MB once
   the settle is sized to the stage (§4.1). Tens of milliseconds, against an
   open already measured at ~900ms. The camera match's colour tables go with it
   and are small
3. Upload, once: `queue.writeBuffer` into the resident storage buffer of §6.
   Written here as `writeTexture` into a texture, which is what it was when this
   was argued; a texture wanted a fourth component that is a constant 65535 and a
   second full-frame copy to write it, and nothing samples the frame bilinearly,
   so it is a packed buffer
4. Every tick after that: write a uniform of a few dozen bytes, dispatch grade
   to PQ to finish, present. No transfer, no LibRaw, no wasm module in the
   webview at all

So the wasm build stops being something the desktop app carries and becomes the
*web* build's business only. That is not a fork in the source: `rawshim` already
compiles as a cdylib for wasm and an rlib for the server, and this is the same
arrangement with the desktop app as a third consumer of the native side.

Keeping the wasm open under Tauri instead is the version that buys nothing: the
browser's numbers, the 6.7MB module, and `SharedArrayBuffer` back again. Tauri
does control its own headers, so cross-origin isolation would at least be free
there, but there is no reason to want it.

**(c) Render natively, put the pixels in the window.** Two very different
things get called this:

- *Shared memory into a canvas*: there is no zero-copy path into a webview
  canvas on any platform. The best available is an IPC buffer plus
  `writeTexture`, which is a copy per tick and still needs the webview to have
  WebGPU, so it inherits (b)'s Linux problem while giving up (b)'s simplicity
- *A native surface composited in the window*: wgpu renders into a layer of its
  own, the webview draws the UI around a transparent region. This is the real
  punch-through, and Tauri exposes the window handle that wgpu needs. It also
  has the simplest data flow of the three, since `prepared` never leaves Rust:
  no protocol, no `ArrayBuffer`, no second upload

The second is the only option that solves problems rather than moving them.
**It is the one path with absolute luminance**: a `CAMetalLayer` with
`wantsExtendedDynamicRangeContent` and `CAEDRMetadata` takes PQ with real nits,
so §7.1's relative-to-SDR-white compromise and §7.4's clipping both disappear,
and DXGI HDR10 does the same on Windows.

It is also well-trodden: `wry` ships `examples/wgpu.rs`, Tauri v2 supports
several surfaces in one window, and there is a community plugin doing exactly
this for Steam overlays. What that experience reports is worth taking as the
cost estimate rather than discovering again. Windows needs a separate child
`HWND` rather than one derived from the webview's; macOS can derive the surface
from the webview's window handle; the surface has to stay transparent or it
competes with the webview's own rendering; the child window needs click-through
so input still reaches the DOM; the swap chain must be configured after the
window has its real size; and presentation wants to be continuous at vsync.
**Wayland is explicitly unsupported**, X11 reportedly works.

Note Wayland's absence bites (c) but not (b): with CEF on Linux (§10.1) the
canvas runs there, so the overlay is an upgrade rather than the only door.

**(b) is the baseline on all three platforms**, since CEF closes Linux and
WKWebView closes macOS from 26. It is one codebase, already proven end to end
(§7.3), and it needs nothing per-platform.

**(c) is the upgrade where absolute nits are worth per-platform code**, which is
macOS and Windows only. It is the sole path that carries real luminance rather
than multiples of SDR white, so it is what to reach for if §7.1's constant or
§7.4's clipping ever stops being good enough. Not a starting point.

**(a) is now needed nowhere.** It exists in this note only as the thing the
canvas replaced.

**Changes shape.** §7. With direct GPU access plus a platform encoder
(VideoToolbox on macOS, hardware 10-bit HEVC or AV1), the frame can be encoded
without a CPU round trip and served to a `<video>` through a custom protocol or
a local URL, which is the delivery ceiling of §4.3 removed outright rather than
worked around. The webview is still WebKit on macOS, so the constraints
DESIGN §21.2 measured for Safari still govern what it will composite: the win is
that we choose the encoder and the transport, not that the compositor got
easier. The extended-range canvas probe (§7) is still worth running, because a
canvas path would serve both builds and needs no encoder at all.
