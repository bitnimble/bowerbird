# Viewport-scale prepare

Date: 2026-09-12

The editor opens a composite - a 26-frame panorama, 300MP of canvas - without holding it, by
preparing only what the viewport shows at the scale it shows it. The same machinery becomes the
default way every photograph reaches the editor, and the one-file-in-the-tab open becomes the
exception a small single file qualifies for.

This is the design. `docs/superpowers/plans/2026-09-12-viewport-scale-prepare-plan.md` splits it
in two and says why: **backend prepare at one level** is what makes a panorama open at all and is
about a quarter of the surface, and **the level ladder with its windowing** is where every hard
constraint lives. The plan's §0 lists the eleven, each with the code that imposes it.

## 1. Terms

**Prepare** is everything from the file to the coded frame the grade reads: decode, condition,
denoise, demosaic, code, defringe, gather, sharpen. Its output is a `Resident` (u16 x 3, normalised
PQ Rec.2020, two samples a word) plus the numbers the grade needs beside it - `tile::Prepared`'s
`keep`, `origin`, `photograph`, `levels`, `matched`, `as_shot`, `defocus` and `reference_nits`.
A client is served a *wire* form of those: `Prepared` derives no `Serialize`, holds its samples in
the same struct, and keeps `reference_nits` crate-private, so what crosses is a struct naming the
fields a caller reads, pinned against `Prepared` by a test.

**Grade** is the tick: one pass per canvas pixel over the prepared frame, on the client, unchanged
by this design. Exposure, tone, colour, the presence three, and temperature and tint are all grade
inputs (`gpu::Adjust`), so every slider a reader drags stays a local 7ms tick with no round trip.
Only the Detail sliders, the sharpen, the defringe and dust move the prepare.

**Backend prepare** runs the prepare on the server's device and ships the `Resident` to the page.
**Frontend prepare** runs it on the tab's device from RAW bytes the tab holds. Same Rust, same
WGSL; what differs is `tile::Source` (a path on the server, bytes or a held mosaic in the tab) and
the transport.

**Level** L is the canvas at `1 / 2^L`. Dynamically prepared mipmaps: each level is *prepared* at
scale `2^L` - a `Scale::Half` decode where the ratio allows, then the resize a rendition of that
size makes - never averaged down from level 0. That is what makes a level equal to the rendition of
its size.

## 2. One prepare for every recipe

**`composite_tile` becomes `tile`, and there is one per-source chain.** A `file` recipe is a one-source
composite: identity rotation, rectilinear projection, `radians_per_pixel = 1 / focal`, canvas the
source's own size, centre at `size / 2`. `canvas_to_ray` for a rectilinear canvas is the plane at
`z = 1` (`composition.rs:144`), so a canvas pixel maps to a source pixel exactly in f64 on the host,
and `Through::Lens` applies the same ratio table `warp.slang` does. Both gathers import
`catmull_rom`.

Measured before this was written, a one-source recipe through `composite_tile::prepared` against
`tile::prepared` over the same rectangle, on both fixtures over a shadow and over the brightest
block:

| Fixture | Lens | Worst difference | Samples differing |
|---|---|---|---|
| DSC02981.ARW (Sony) | identity | 1 / 65535 | 0.5% |
| IMG_5360.CR3 (Canon) | distortion fitted | 1 / 65535 | 0.6% |

f32 rounding, not a second implementation. So the split closes at every layer where the
single-file code currently sits beside the panorama code:

| Today | After |
|---|---|
| `tile::prepared_on_device` (one file) and `composite_tile::prepared` (N sources) | one `tile::prepared`, N >= 1 |
| `TileRequest` and `CompositeRequest` | one `PrepareRequest` |
| `job::Base::build` decodes a file; `composite_job::base` composites a recipe | `Base::build` dispatches on the recipe, and `composite_job::base`'s four extra arguments fold into `Job` |
| `composition::Composition` | `Recipe`, with a one-source constructor. The Rust type only: `schemas/recipes.ts` already exports a `Recipe`, and its sources are `.min(2)`, which a one-source recipe never has to satisfy because it is built in process and never stored on a row |
| `edit.rs`'s private `open`, reached through `prepare_bytes` and `from_frame` | a prepare over the whole canvas, `Source::Frame` - the open holds a frame rather than bytes, and deliberately: the camera match is fitted against scene-linear samples before any coding |

Per-source stages that sit in different places are placed once. **There are three positions
today, not two:** a rendition sharpens at `hdr::Cut::from_base`, after the resize and the lens
warp, with the warp's Jacobian; a loupe tile and the editor's open sharpen inside `base::prepare`;
and a composite sharpens at the cut with no Jacobian at all, since `composite_gather.slang` emits none.

- **Sharpen** runs after the gather, once, for every recipe. `deconvolve_split` carries the sigma
  to the level's own pixels. The Jacobian is the thing a merge has to carry with it: it is the
  sharpen's corner variation, and a composite gather that emits none drops that term silently.
- **Dust** is a request setting for every source. `composite_tile` passes `Known::Off` today.
- **Presence reach and halo** grow the window as `tile::grown` does; `footprint` reads the grown
  window, so a source is decoded for what the filters reach as well as for what is drawn.

The camera-JPEG arm (`composite_tile::From::Camera`) stays as the embedded-rendition source of a
composite.

## 3. Whole-picture numbers

Every quantity measured over "the frame" is the recipe's, measured once and handed to every
prepare. `TileRequest` already states this rule for five of them - `levels`, `noise_fit`,
`capture_sigma`, `sensor_long`, `defocus` - and `CompositeRequest.levels` for the sixth. What this
design adds is that the composite's answers are *its own* rather than its reference frame's:

| Number | A composite's answer |
|---|---|
| levels (diffuse white, scene peak in input levels) | `union_levels`, over every source stacked |
| colour match | `union_match`, fitted over every source at once, `Lens::none()` |
| scene peak (display nits) | measured on the canvas at one level, handed to every tick |
| defocus pair | the reference's |
| noise fit | the reference's |
| capture sigma | the reference's, with `sensor_long` the canvas at scale 1 rather than that sensor |
| white balance gains | the reference's |
| as-shot | the reference's |
| the decode scale | the level's, per source: each is asked for its own long edge over `2^L` |

The per-camera rows follow the rule `composition::Composition::reference` already states, and the two
union rows follow `union_match`'s own reasoning: carrying the reference's match forward "grades a
row of sky through the curves fitted to a frame of trees", measured at a stop under on the
26-frame pan.

**Two of those rows are self-consistent and physically approximate**, and it is worth saying so
rather than leaving it implied. The noise fit and the gains are one frame's, so every pixel of a
26-frame pan is damped by the sensor statistics of a frame it may not contain; and the blend
reduces noise in the overlaps, which no single fit describes. Every window gets the same answer, so
the pins hold - that is what makes it correct as a *design* - and the answer is the reference's
rather than the picture's. `composite_job::base`'s current comment says a composite has no one camera's
balance and no single noise fit, which is true and is why the alternative it chose was no table at
all; one frame's is strictly better than none, and this row is what replaces that comment.

A window never measures any of these for itself, and `as_shot` and the defocus pair are the two
that today are set only where the reference happens to fall inside the window. They travel on the
request like the levels do, or a level-0 window at the far end of a pan grades temperature and
tint differently from the coarse one.

**The sharpen's residual table needs nothing new.** It is already derived from the photograph's
`NoiseFit`, the reader's amounts, the levels the frame was coded against and the white-balance
gains (`base::sharpen_noise_table`), all of which a window is handed - so a window's table is the
frame's table by construction, and `sharpen.slang`'s `noise_at` reads what the host uploaded.

What that exposes is a gap on the composite path rather than in the table: `composite_job::base` reports
`Base::analysis` as `PhotoAnalysis::default()` and `wb_gains` as `[1, 1, 1]`, so the table
`job::run` builds for a canvas comes out all zeroes and the deconvolution runs undamped. Filing the
reference's noise fit and gains as the composite's own (the table above) is what closes it, and it
is the same change that makes the numbers survive a restart.

**A window's `matched` is the recipe's, not its reference's.** `composite_tile::prepared` returns
`sources[reference].analysis.from_raw.matched` today, which `composite_job::base` then overrides with
the union fit - fine while only a rendition consumed it, wrong the moment the client grades from
what a window hands back.

## 4. Stateless server

The expensive whole-set measures are `union_levels` and `union_match`: both stack every source at a
reduced size, and `union_match` decodes an embedded preview per source on top, so for 26 frames it
is three passes over the set rather than one. They are **read from the composite's own
`photo_analysis`, measured and written when it holds none**. Nothing is kept in memory between
requests, so `/prepare` is a pure function of `(photoId, level, rect, detail)`, cacheable by hash
anywhere, unaffected by a sidecar restart, and reused by the next open.

The store exists: `photo_analysis_store.ts` writes `<dataDir>/<libraryId>/analysis/<photoId>.bba`,
swallowing errors both ways, and `GET`/`PUT /image/:photoId/analysis` already serve it. So a read
miss means "measure", never an authoritative "nothing to know".

The fields exist too - `FromRender.levels`, `FromRender.scene_peak`, `FromRender.defocus`,
`FromRaw.matched`, `FromRaw.noise`, `FromRaw.capture_sigma`. **Only the three `FromRender` ones
carry the settings they were measured under**, so only they can be refused when a setting moves;
`FromRaw`'s three carry nothing. That matters for a composite, because `union_match` is fitted at
`job.grade.white_quantile` - so a stored union match needs a quantile stamp beside it, or a
changed quantile serves a match fitted against different levels. The fallback chain is the one
`tile.rs` already implements: the request's value, else what is stored, else measure.

Three consequences for the code that writes it:

- `composite_job::base` fills `Base::analysis` with the composite's own measures and stops passing the
  reference's analysis as `stored`, so `analysis.filled_from(&stored)` no longer files the
  reference's levels and match on the composite's row.
- `union_levels` returns `Levels` rather than `Anchored`, anchoring at the use site, because
  `MeasuredLevels.levels` is the pre-anchor value.
- **No panorama has ever had an analysis row**, past or future: the worker returns from its
  panorama branch above the only `writePhotoAnalysis` call, and the command it builds reads
  analysis per *source* and never the composite's own. So the write is new work, both directions,
  and without it the numbers above are computed and dropped.

`wb_gains` and `as_shot` need no slot of their own. The open prepares the whole canvas at the
coarsest level, which by definition covers the reference, so both come out of that prepare, ride
the `PreparedHeader` to the page, and are handed back per window in the request exactly as `levels`
and `noise_fit` are.

## 5. Route

```
GET /image/:photoId/prepare?level=L&left=&top=&width=&height=&detail=<hash>
```

Beside `renditions` and `analysis`. The photo id is the only identity; the recipe kind is the
server's to resolve and never appears in the URL.

**The body is framed and carries both halves**: a `u32` little-endian JSON length, that much of the
wire `Prepared`, padding to a multiple of four, then the window's samples read back off the device.
Four bytes so the samples land on a word and the page can view them without a copy. The numbers
are in the body rather than a response header because the desktop shell's proxy keeps seven
response headers and drops every other, so a custom one would arrive empty in the webview.

`detail` hashes everything that moves the samples, which is more than the filters: the denoise
amounts, the sharpen, the defringe and the dust, **and** `grade.white_quantile` (it picks the
levels the frame is coded against), `grade.reference_white_nits` (it is the coding curve's scale),
the recipe, and each source's analysis blob - the lens the gather uses and the spots the dust
corrects come out of that blob, so a window fetched before a first-open measure landed was
prepared with neither and nothing else in the key would say so.

The unit of *request* is the viewport window, because every source reaching it is region-decoded
once and a region decode costs what the whole photograph costs (60ms against the 2ms its pixels
then take to gather). The unit of *cache* is a 1024 x 1024 tile cut from the window's `keep`
rectangle - even, so a copy lands on a word - held page-side, bounded in bytes.

The coarsest level is the whole canvas at 4096 or under on its long edge; the open prepares it and
the page holds it for the open's life, so a picture is on screen after one request and every finer
miss draws from it until the finer level lands.

Rough sizes for a 26 x 61MP pan, canvas about 30000 x 8000:

| Level | Window | Bytes | Sources decoded | Native cost |
|---|---|---|---|---|
| 3, the fit | 3750 x 1000 | 23MB | 26, halved | ~2s |
| 0, 1:1 under a 4K stage | 5760 x 3240 | 110MB | 2 to 3 | ~300ms |

## 6. Module

One `Held`, in `wasm.rs`, whatever the recipe:

```rust
pub struct Held {
    prepare: Prepare,
    drawing: RefCell<Option<Drawing>>,
    stage: RefCell<Option<gpu::Stage>>,
    loupe: RefCell<Option<gpu::Stage>>,
    tile: RefCell<Option<Tiled>>,
    geometry: Cell<image::Geometry>,
    adjust: Cell<gpu::Adjust>,
    // levels, analysis, defocus as today
}

enum Prepare {
    /// The tab's device, from bytes it holds at the mosaic.
    Frontend { held: decode::Held, bytes: Vec<u8> },
    /// The server's device, fetched a window at a time.
    Backend { client: PrepareClient },
}

impl Prepare {
    async fn prepared(&self, level: u32, rect: Rect) -> Result<(Resident, tile::Prepared), String>;
}
```

`Frontend` answers level 0 over the whole canvas and the draw regions it, which is today's
behaviour unchanged. It carries five things, not two: the held mosaic, the file's bytes, whether
there is a sensor behind it, the noise fit and the open's request, all of which the prepare, the
band and the drawing read.

`Backend` fetches the tiles of the window it does not hold, uploads each with `queue.writeBuffer`,
and assembles the window by `copy_buffer_to_buffer` exactly as `composite_job::base` assembles a canvas
from tiles (`tile_runs`) - which means every level's size and every window's width is **even**, six
bytes a pixel standing on a word boundary only for an even count.

**Three things above `prepared` do have to change for a window**, and the design was wrong to call
them shared:

- The stage's draw is a whole-frame grade today (`window: None`). A windowed frame needs the
  `within`/`surrounded` plumbing the loupe arm uses *and* the reader's geometry, which
  `Prepared::grade` deliberately does not apply. That combination - a window, a canvas region and
  a geometry at once - is exercised nowhere in the tree and needs a test of its own.
- The pyramid is not optional: `gpu::present` and `draw_into` take a `&Pyramid`, so a window
  either builds one or three signatures change. It is also what stops a zoom-out aliasing while
  the previous window is still on screen.
- The loupe cuts its tile out of the held mosaic, which a backend open does not have, so it
  becomes a fetched level-0 window rather than the same call.

A window no source covers is the zeros it was allocated with, as a render already leaves it -
never an error, because a hand-held pan's corner wedge is a place a reader can pan to.

Level per tick: the largest L whose canvas still covers the stage's own backing store. Derived
from the size `stageResolution` actually returned rather than from `SUPERSAMPLE` alone - that
constant is one of four terms in a `Math.min`, and the others include the adapter's texture clamp,
which binds exactly in the large-canvas case this exists for. The draw then minifies by at most 2x
where the pyramid is deep enough for it (`frame.slang` clamps the level of detail by `max_lod`, so
a shallower pyramid minifies by more). The window is the stage's size times a margin at level L,
so it never approaches the texture limit.

A Detail slider under `Backend` invalidates the cache and re-requests the visible level, nearest
the viewport centre first, drawing the previous frame until each tile lands. On the 26-frame pan at
the fit level that is every source once, halved: seconds, stated rather than hidden. The grade
sliders never wait on it.

## 7. The gate

Frontend prepare only when **all** hold:

- the recipe's canvas area is at most `10_000 * 10_000` pixels, one constant, whatever the source
  count or file size: a two-frame 4K pan qualifies, a single 12000 x 10000 file does not
- the client is not the desktop shell (`raw-edit-gpu.md` §10.2b: a local wasm decode buys nothing
  when the sidecar holds the same crate on the same machine)
- the client is not a mobile device: `(pointer: coarse)` matches, or `navigator.deviceMemory` is 4
  or less where the browser reports it

Otherwise backend prepare. The existing refusal of a frame whose half exceeds
`maxTextureDimension2D` stays as the hard floor under the frontend arm - moved ahead of the
download, since it fires inside `hold_drawing` today, which is after the RAW has been fetched,
held and fully prepared.

The area ceiling is 100MP, which a frontend prepare holds as about 600MB of samples plus a
pyramid on the page's own device. That is 1.6x the 61MP frame the editor is sized for today, so it
is the number to check first if a tab ever runs out of device memory.

The page's half stays one `LocalDecoder`. Which `Prepare` the module builds is decided at the open
from the recipe's canvas and the client, and nothing above the open knows which it got.

## 8. Desktop shell

Backend prepare always. The sidecar already runs this crate on the machine's GPU and `bowerbird://`
already proxies any server route, so the shell needs no new transport: a window is one fetch over
localhost, a memcpy of tens of megabytes against a prepare of seconds. There is no zero-copy path
into a webview's WebGPU on any platform, so a fetch and a `writeBuffer` is the floor everywhere.

A native overlay surface (`raw-edit-gpu.md` §10.2c) is the later upgrade for absolute-nits HDR on
macOS and Windows. `Prepare::Backend`'s client is the one seam it replaces, with `tile::prepared`
called in process, so nothing here forecloses it and nothing here builds it.

## 9. What is pinned

- `a_tile_is_graded_as_the_rendition_is` holds for every recipe kind: a window through the one
  `tile::prepared` equals `job::run`'s output over the same rectangle, over both fixtures and over
  a one-source recipe. **Exactly** - the test asserts a worst difference of zero, which is why one
  gather rather than two is a requirement rather than a tidiness: two kernels agree to 1/65535 and
  that is not zero.
- `Prepare::Frontend` equals `Prepare::Backend` over the same rectangle, which is what stops the
  exception drifting from the default. The most load-bearing pin here, and the one that catches a
  window measuring a statistic the whole picture owns.
- A level-L window matches the rendition of that size over the same rectangle **within a
  tolerance, not exactly**: a window resized on its own lands on a grid the whole frame's resize
  never had, which `Base::cropped` already declines to guess at. Above
  `composite_job::MAX_LONG_EDGE` there is no rendition to compare against at all, so a level below that
  cap is editor-only and the loupe's claim to be the export's own pixels does not reach it.
- `module-json.json` gains the prepare request's shape, deserialised by `module_json.rs` and
  rebuilt by `module_json.test.ts`, because a field renamed on one side is a black stage at the
  first tick.
- `gpu_fixture`'s pins are regenerated once, deliberately, in the commit that moves the single-file
  path onto the composite gather, and the bench budget is re-recorded in the same commit if a
  stage's cost moves.

## 10. Out of scope

- Persisting prepared levels to disk. The stored analysis is the only thing written.
- The native overlay surface.
- A frontend prepare of a multi-source recipe. It is free by construction (`Source::Bytes` per
  source) and no client qualifies for it under the gate.
- Any change to the grade, the tick, or the pinned draw path.
- Aligning a panorama from the editor. The recipe arrives from `POST /api/composites/panorama`; the editor
  reads it.
