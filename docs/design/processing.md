# Bowerbird design: The processing pipeline

A chapter of [`DESIGN.md`](../../DESIGN.md), numbered with the other chapters as one document.
`DESIGN §N` anywhere in the repo, or a nonlocal `§N` here, refers to the section indexed in `DESIGN.md`.

---

## 10. Processing Pipeline

### 10.1 Overview

Processing converts RAW files into **renditions**: derived copies of one photo, each existing for a stated reason.

| Rendition | Constraint                                                           | Why it exists                | Output path                                                     |
| --------- | -------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- |
| `grid`    | Longest edge = `GRID_RENDITION_SIZE` (default 800px)                 | The library grid. Always SDR | `<DATA_DIR>/<library id>/renditions/grid/<photo id>.avif`       |
| `full`    | Longest edge = `FULL_RENDITION_SIZE` (default 3840px)                | The photo view               | `<DATA_DIR>/<library id>/renditions/full[-hdr]/<photo id>.avif` |
| `max`     | Native resolution within AVIF's 32768px edge and 16384² pixel limits | Pixel-peeping (§10.5)        | `<DATA_DIR>/<library id>/renditions/max[-hdr]/<photo id>.avif`  |

Requested sizes and quality come from configuration (§15). Every encoded frame fits AVIF's dimension and area limits, including after crop and straighten.

The three trees were `thumbnails/`, `previews/` and `lossless/`, misleadingly: `thumbnails/full` held the default 3840px viewer image; `previews/` did not. Renditions differ only in size and dynamic range, so one job takes a target list instead of three near-identical job types.

**The camera's picture is a rendition (`embedded`), supplied by the row's recipe.** A single-file row serves it directly from the RAW, without HDR resizing or a cached AVIF transcode; where the RAW is on another device, it serves the copy a peer lifted (replication §7.9). A composite (§19.4) combines its source pictures at viewer size and caches the result on first open; no queue builds it. Thus a merge in an embedded-picture library writes only its tile, deferring the view until someone opens it. Both recipes use the same rendition route. The grid always re-encodes to 800px rather than serving a 9504px preview.

**Composite canvas width determines tile sizing.** `PANORAMA_TILE_SCALE` widens panorama tiles: their
canvas spans several frames, so one frame's long edge would undersample every source. An assembly uses
its frames' near-identical _intersection_ (§4.2.1), roughly one frame; scaling would oversize its tile.
`processing_service.ts`'s `target()` therefore branches on panorama width, not composite status.

**Dynamic range is in the directory, not the filename**, because the file is the cache: a copy built while the library was SDR would otherwise be handed back forever, so turning HDR on and asking for the full-size view returned the old sRGB AVIF and nothing ever rebuilt it. HDR is stored _beside_ the SDR copy rather than replacing it, so turning the setting off does not throw away work that turning it back on would redo. There were once `-hdr-video` directories beside these holding a one-frame AV1 copy for Firefox; Firefox makes that for itself now (§10.7), and the prune sweep empties what they left (§10.6).

**Everything is AVIF**, every rendition, the full-resolution export (§10.5) and the HDR renditions (§10.7) - and every one of them goes through **libavif**. The SDR path moved off libvips' `heifsave` once the HDR one was already linked: measured at matched quality on a 3840px frame it is 307ms against 275ms at the grid and full setting, and 370ms against 302ms at the export's, for files within half a percent of the same size. It also takes libheif out of the chain, and with it the plugin-priority trap a libvips module has to guard against. **Encoding never resizes**: libavif receives either the target's finished frame or its bands as grid cells. Sizing happens before lens gather and sharpen, including the fit to AVIF's limits. Going through a libvips pipeline regardless had `finish` materialise a second copy of the frame - 183MB on a 61MP export - to hand over pixels libavif could read in place. A resize here would also be the wrong one: it would run _after_ the sharpen, which is a deconvolution calibrated for the size it ran at, where the per-target fit-to-size runs ahead of it. It decodes natively in every current browser with no polyfill, it is the only format here that carries HDR to Chrome and Safari alike, and at matched quality it is smaller than the WebP it replaced: the full-size rendition is 375 kB at q60 against 1019 kB for WebP q90. Nothing migrates existing files; the orphan sweep keys on the extension a directory is supposed to hold, so stranded WebP is collected on the next pass (§10.6).

**The SDR renditions are 4:2:0 too** (`sdr_full_chroma`), for the same reason and on its own numbers - a separate setting because the amounts are not the same size, and because the grid tile is a different question from the native-resolution export. Measured on the 24MP fixture:

| rendition                    |       | wall   | CPU    | peak RSS | bytes   |
| ---------------------------- | ----- | ------ | ------ | -------- | ------- |
| grid tile, 800, whole job    | 4:4:4 | 85ms   | 0.12s  | 94MB     | 13.7 kB |
|                              | 4:2:0 | 76ms   | 0.12s  | 90MB     | 12.5 kB |
| viewer, 3840, encode only    | 4:4:4 | 483ms  | 2.88s  | 476MB    | 1.72 MB |
|                              | 4:2:0 | 224ms  | 1.71s  | 420MB    | 0.53 MB |
| full resolution, encode only | 4:4:4 | 1468ms | 10.34s | 918MB    | 8.48 MB |
|                              | 4:2:0 | 842ms  | 7.25s  | 651MB    | 5.02 MB |

The viewer encodes in **less than half the time**, a larger saving than HDR: libaom's chroma planes cost most relative to its remaining state at 8-bit 4:4:4.

**The grid row measures the whole job.** It DCT-scales the embedded JPEG (§10.4), without RAW demosaic: 76ms and ~60MB above baseline. Other rows exclude demosaic. 4:2:0 saves 9% of a 12.5kB tile and about 9ms.

**And the tile has no chroma to lose.** The camera's preview is already subsampled - `yuvj422p` on the fixture, which is typical - so a 4:4:4 tile was storing chroma at a resolution the source never had. Measured against a near-lossless encode of the same tile, the combined SSIM goes 0.992211 to 0.991865, a difference of **0.0003**, and the U plane 0.9952 to 0.9946. That is as close to free as this gets, and it is the rendition every photo in the library has - the grid, masonry and list views all request it, as do the shoot and collection banners.

Per-plane at 3840, against a near-lossless 4:4:4 reference, the same shape as §10.7:

|           | Y      | U      | V      | All    | bytes  |
| --------- | ------ | ------ | ------ | ------ | ------ |
| 4:4:4 q26 | 0.9433 | 0.9561 | 0.9563 | 0.9519 | 1.72MB |
| 4:2:0 q26 | 0.9436 | 0.8802 | 0.8953 | 0.9064 | 0.53MB |
| 4:2:0 q16 | 0.9695 | 0.9054 | 0.9169 | 0.9306 | 1.52MB |

Luma matches at equal quantizer and improves at equal bytes. Chroma remains worse: 4:2:0 needs q0 and 6MB to exceed 4:4:4's combined score at q26 and 1.7MB. The setting leaves that perceptual trade to the reader; metrics cannot decide where viewers look.

**What 4:2:0 does to a PQ still is not only that loss, and an SSIM over ordinary content never saw the rest.** Chroma is stored once per 2×2 and Y' once per pixel, so a decoder reconstructs each pixel's channel as `c' + (ΔY' − Δc)` in the coding's own codes, Δ being the pixel's departure from its block mean - green's per-pixel swing lands in red at two thirds. On a saturated red that swing is thousands of PQ codes: a channel the grade holds near black sits on the curve's steepest part, and white sparkle over red moves green where red, near its roll-off, barely moves. Measured on DSC03422's hood, red's 99th-percentile Laplacian went 2174 codes to 8630 through a _lossless_ 4:2:0 encode and was unchanged through 4:4:4 - hard speckle the frame never held, in the rendition and not in the editor, which never encodes. Three things answer it. The grade holds a colour's lowest channel at a floor rather than at zero (§10.7), which takes the near-black case away entirely. libavif's chroma is converted with libsharpyuv (`SHARP_YUV`, the pinned build's `AVIF_LIBSHARPYUV=SYSTEM`), which chooses each block's chroma so the reconstruction lands closest to the source given the per-pixel Y' - 8646 → 6327 on the headlight - rather than box-averaging. It solves under sRGB's curve whatever the still's transfer (`SHARP_YUV_TRANSFER`): told PQ, libsharpyuv from 0.4 solves in linear light, and over the six fixtures at quantizer 0 that put the p99.9 worst channel 17 to 125 PQ steps off where sRGB's curve holds it to 6 to 107, at five times the time (`examples/aom_quality.rs`). And what neither can carry is measured before the encode: `chroma_leak.slang` predicts the reconstruction error per 2×2 from the coded frame, counts the blocks past `CHROMA_LEAK_CODES` per 64px tile, and a still whose worst tile is past `CHROMA_LEAK_TILE_FRACTION` is written 4:4:4 on its own. Per tile rather than per frame, because the car is a hundredth of a 61MP frame; at the bars set, that frame reads 0.24 at either size, a frame of dense chroma texture whose encode measured no leak reads 0.10, and clean frames read nothing. `hdr_still_full_chroma` on is 4:4:4 for every still; off is this.

AVIF exposes quality and speed separately. `avif_speed` defaults to 8 on libavif's 0-10 scale, where 10 is fastest, and applies to every SDR and HDR AVIF encode: renditions, grid tiles, exports and gain-map containers. The quantizer sets quality; speed controls how long the encoder searches. Two things about the quantizer settings:

- **The quality settings are libaom quantizers**, 0-63 and lower is better, because that is the scale the encoder underneath takes. They were libvips' 1-100 until the encode moved, and the defaults are the measured equivalents rather than fresh guesses: matched on SSIM, Q80 lands on 13 and Q88 on 8, and the fit holds away from the two points it was taken at - Q60, Q70 and Q95 predict within 0.0007 SSIM. **The direction inverted**, so a value carried across from the old scale means close to its opposite. Those equivalents were written down as 26 and 16 while libavif was halving every quantizer it was given (§10.7); the files were always the ones described here, only the numbering was doubled. Every one of them was measured under libaom's SSIM tune. The encoder runs IQ, which libavif gives stills from aom 3.13 and `avif.rs` names outright, and which spends up to three quarters more bytes at the same quantizer; so `processing/quality.ts` maps each setting to the IQ quantizer spending SSIM's bytes - 13 and 8 become 18 and 11, the HDR stills' 3 and 1 become 4 and 1 - and at those sizes the two read side by side as the same picture.
- **AVIF quality is not WebP's scale.** Carrying the old 90 across would have produced 2551 kB renditions, 2.5x larger than what they replace. q80 is where shadow detail stops visibly degrading on real frames; q60 and q70 lose it. Quality is chosen on appearance.

**The grid tile is always the camera's embedded JPEG**, whatever the library is set to. It is a small SDR rendition, so the only thing worth optimising is how fast it appears, and the embedded preview is the fastest source there is: ~18ms against ~1.5s to demosaic (§10.3). A body that embeds no JPEG falls back to a render inside the worker, so this is "the fastest source available" rather than "always the JPEG".

**`rendition_source` governs the photo viewer, not the grid**: `embedded` serves the camera's JPEG in the viewer as itself and builds no rendition at all, `render` builds the full-size view by demosaicing. Alongside `rendition_hdr` it lives on the `libraries` row, not the server: one catalogue may be scanned JPEGs where the camera's rendering is the point and another RAWs worth demosaicing. `render`, in HDR, is the default. Changing any of them is deliberately **not retroactive**; it decides what gets built next, and rebuilding a catalogue is an explicit action.

**A library may also leave stages out of those two renders**, per rendition, through `render_skip_full` and `render_skip_max` (`schemas/render_stages.ts`): dust removal, denoise, lens matching, camera-colour matching, defringe, and sharpen. Turning lens matching off also turns colour matching off, because the colour fit pairs pixels through the lens geometry. Turning lens matching on leaves colour off until the reader enables it. The stored skip lists are ordered sets. Like the rendition settings, these choices affect future renders.

The denoise at 0 stops at the noise fit (`galosh::wanted`), sharpen and defringe at 0 are refused by `image::Strengths`, and dust uses `dust::Settings::wanted`. A job's `cameraMatch` is `none`, `lens`, or `lensAndColour`. The global `match_embedded_jpeg` setting supplies the default, then the library's skip list restricts it. A lens-only fit stops before fitting colour. Its analysis stores the lens with no colour transform; a later full match fits colour through that stored lens. The panel's Encode row includes the grade and encoding costs, while the native stages and their profiling laps remain separate.

Skipping camera match changes the camera's look; skipping denoise retains grain. The editor draws the reader's document, so it differs from stored renditions by skipped stages. Grid tiles have no skip list: they use the camera JPEG or fall back to the `full` frame. Exports name their own size and quality and use no library skip list.

A composite recipe keeps the source geometry that aligns its frames. That geometry is part of the photograph's construction, not the optional lens match applied to a rendition after the recipe exists; removing it would move the sources apart rather than omit a correction.

**What each stage costs is measured here rather than quoted** (`render_benchmark.ts`). The panel opens on an estimate taken from `bench.budget.json`. The Measure button renders `assets/reference_frame.ARW` several times, once per configuration per round, and prices each stage as the difference in the fastest round. The fixed 9504x6336 Sony ILCE-7CR frame makes measurements comparable across machines and catalogues. Its distributed copy has no capture time, time zone, GPS position, owner name, serial number, copyright, user comment, or Sony MakerNote data. It keeps the camera and calibration tags that `rawler` needs to decode the mosaic. The container carries the frame; the desktop app downloads it into its data folder on the first Measure, checked against its SHA-256, which keeps 72MB of a button few press out of every install. A difference rather than a lap prices stages that share a dispatch. Coding and defringe are one pass, and resize, warp, and sharpen are another. The fastest round avoids contention, which only adds time. One round on a busy machine priced two stages at nothing.

The benchmark uses denoise amounts of 20 luminance and 30 colour, with defringe at 1, so the measured stages run regardless of the reference frame's noise estimate or the global setting. Colour's saving is the full match minus lens-only, and lens's saving is lens-only minus no match. Every other optional stage compares all-on against that stage skipped. A difference below the timing spread can still round to 0; the panel calls that “No measurable saving”. The initial estimates allot 55ms to lens and 375ms to colour for either rendition, with Encode at 188ms for `full` and 698ms for `max`.

**The figures belong to the machine, not to a catalogue, so they are scaled to one sensor before they are kept**: 6000x4000, a common full-frame mirrorless and the size behind the shipped estimates (`scaledToReference`). `readRawHeader` reads the reference frame's area, and `scaledToReference` normalizes the measured time to 24MP. A stage is usually a pass over the frame, so its cost follows the frame's area. Camera match is the roughest fit because its solver uses a fixed number of pairs for every sensor size.

Measurements live in `<data>/render_timings.json` beside renditions, not a table or `libraries` row: they describe this hardware, not replicated catalogue state. Merge each result into current disk contents at write time; a minutes-long `max` benchmark may overlap another rendition's measurement.

**Only `full` and `max` are ever HDR, and only they take the chroma setting.** The grid stays SDR whatever the library says: a wall of HDR tiles is punishing to look at, and it would put a linear decode and two encoder passes on every photo in an import rather than one AVIF encode. It is always 4:2:0 for a reason of its own - it is 800px among other tiles, and its usual source is the camera's already-subsampled preview, so `sdr_full_chroma` would buy it 0.0003 SSIM for a third again the encode. Neither is offered as a knob, and the two are refused differently because they arrive differently. **HDR is a caller's argument, so an HDR grid tile is a bad request and `processing_service.target` throws `VALIDATION_ERROR` rather than quietly building an SDR one** - a coercion would leave the mistake somewhere nobody reads, and the mistake is not benign: `renditionVariant` gives no HDR grid path, so a request honoured would encode HDR and file it as SDR, which decodes wrong rather than merely costing more. Chroma is a setting the service reads rather than something a caller asks for, so there is no request to reject there - only a policy that the setting covers `full` and `max` and not the grid.

`renderOne` is `async` for that throw: the grid-tile repair calls it fire-and-forget and clears its in-flight set in a `.finally()`, so a synchronous throw would skip both, leave the photo unrepairable for the life of the process, and turn a detail read into a 500.

That holds for the render fallback too. A body with no usable JPEG preview builds its tile by demosaicing, and it is still SDR and still 4:2:0: what makes full chroma pointless at 800px is the size and the wall, not where the pixels came from.

**An import builds `grid` always, and `full` only when the library renders.** A library serving the camera's JPEG has nothing to build for the photo view - it hands over the RAW's own bytes - so it pays one small encode per photo and no demosaic at all. `max` is built on request and only once, at native resolution when it fits AVIF's limits.

**Firefox needs no second file or encode.** It renders HDR stills dark and applies PQ only to video, so the page rewraps the shared AVIF into a one-frame AV1 MP4 (§10.7).

**Every rendition reports its weight, the stills included.** Reading it in the browser off the Resource Timing entry for the response that had already arrived costs the server nothing and describes what the reader actually paid, but only in Chromium: Firefox leaves `encodedBodySize` at 0 for a cross-origin resource whatever `Timing-Allow-Origin` says, and the app and the API are always separate origins, so the panel reads "unknown" there for every photo. It comes off the same stat that answers `built` - free for a stored rendition - and for the camera's JPEG, which has no file of its own, off lifting it out of the RAW: a header read and a copy, about a millisecond, on a single-photo read.

**The viewer sees a three-step quality ladder**: the camera's JPEG, `full`, and `max`. They are the same picture at different costs, so it treats them as interchangeable and `viewer_rendition_mode` (§13.6) decides which one a photo opens at: pinned to one of the three, or reopened at whatever was chosen last, either across the catalogue (`remember`) or for that photo (`remember_per_photo`, stored on `photos.viewer_rendition` and carried on the summary because that is what `shown_rendition` is resolved against, §18.5). Server-side rather than in the browser because the same catalogue is opened from a phone, a laptop and whatever is plugged into the good monitor, and "where I left off" is worth nothing if it only holds on one of them. All three stay on offer whichever is showing, the step back down to the camera's JPEG included: comparing a render against it is a reason to switch.

`I` and `O` switch directly to the camera JPEG and render. Hold the current frame until its replacement decodes, including slow replacements, to avoid flashes between cached renditions. Only a photo _change_ clears the stage: the previous frame then depicts the wrong subject.

The incoming frame is **mounted as a second, invisible element over the current one** and that element is then kept rather than replaced. Which the page can only do because the decode is its own: a frame is decoded once, at a size this chose (`DECODE_CAP`), and drawn into the canvas that holds it - where an element given a src decoded the file again at the size it was drawn at, so a 3840px AVIF flashed on the way in while the 1080px camera JPEG - the same swap in the other direction - did not. Firefox's rewrapped video swaps the same way, promoted on `loadeddata` since a `<video>` has no `decode()`; it is a rendition comparison like any other and would otherwise be the one path that still flashes.

**And the outgoing frame is not unmounted, it is hidden.** Every rendition this photo has decoded stays mounted, each on its own compositor layer so it keeps the raster an `opacity: 0` element would otherwise throw away; the picker then chooses between frames the page is already holding. Retiring the old element instead made the _second_ look at a rendition cost exactly what the first did - a request for bytes that had not changed and a decode of them - so a reader going back and forth between the camera's JPEG and the render, which is the comparison the whole ladder exists for, paid on every press. What survives from the retire is the few-frame hold: a frame that has _just_ decoded has no raster yet, so whatever it is revealed over stays opaque underneath it until it does. A frame that has been sitting hidden on its own layer needs no such cover, which is why going back to one is instant where arriving at it for the first time is not. Firefox's video twin is the exception: its blob is built from the still and revoked as soon as another rendition is asked for, so there is nothing to keep and that browser pays for the swap as it always did.

**A build the reader is waiting on says so in the corner of the stage**, whichever way it started: the reader choosing a rendition that is not on disk, or the frame the photo opened at 404ing and asking for itself to be built. Both raise the same thing - the set of `photoId:rendition` builds in flight, which is also what stops a stage that fails, remounts and fails again from queueing the same job on every report - and the pill is up while anything in it belongs to the photo on screen. A single flag was raised only by the first, so the ordinary way to meet a photo that has no rendition yet - opening it - sat on "no rendition yet" for the whole render, which is what the stage says when there is nothing coming. Nothing is what it says now only when nothing is being built.

**The same pill names a rendition the reader has just chosen, for a second and a half.** The picker is three keys and a menu in the bar, so the answer to "which one am I looking at" was a panel away, in a column that is off by default; said on the swap it costs nothing to read and nothing to dismiss. Only on the reader's own pick, not on what is on screen: which rendition a photograph opens at is the server's answer and it differs between neighbours - an album spanning a library that renders and one that does not - so keyed on that it named a rendition nobody had asked for, on a plain step and on a plain page load. It is drawn outside the pictures, which are what carry the zoom and pan transform, so it stays in the corner while the reader moves around inside the frame - and inset to the photograph rather than to the viewport, a portrait frame in a landscape stage leaving letterbox either side.

Against that, the file being the cache means a change to the pipeline is invisible on every photo already looked at. **"Re-render rendition"** (`?force=true`) removes the stored copy and renders it again. It sits under the Actions menu rather than in the ladder because it remakes a file rather than choosing between three, and it is for working on the renderer, not for looking at photographs. It remakes **whichever rendition is on screen**, that being the one the reader is judging - and the render behind the camera's JPEG, which is the RAW's own bytes and has no build to force past. It does not move the reader onto anything: the file is replaced under them. Where a photograph has no render on disk it is offered greyed out, there being nothing to remake.

Both renditions are versioned by one column, `renditions_built_at`, and a rebuild of either has to move it (§13.5). A `max` build (`markMaxBuilt`) writes that stamp and its own entry in `built_from`, and nothing else - not `needs_renditions`, since it renders neither `full` nor the tile and retiring the flag would drop the rebuild those still owe, nor `rendition_source`, which is what the viewer is served. The version stamp is not merely for a reload: the announcement moves the version in the row a client holds, and any read of that row afterwards is what the column answers, so a rebuild that leaves it behind puts the client back on the URL it started at. The page holds its decoded frames under those URLs, so landing on one it has already decoded shows the picture from before the rebuild and asks the server for nothing - which switching renditions cannot clear either, both frames being held the same way.

**A stored copy answers for its own freshness, which is why `built_from` is a map keyed by variant rather than a stamp per pass.** A stamp shared between two files lets whichever was written last vouch for the other, and both ways that happens are a couple of clicks away: re-render `full` after an edit the editor never got to report, or flip a library's HDR setting. `PhotoRenditionService.buildRendition` asks the variant's own entry before its `existsSync` early return, so a rendition asked for by name is rebuilt rather than served from a cache it has moved past; and `renditionsOf` reports a stale variant as unbuilt, which is what keeps the viewer from opening at one and what makes `rendition_to_build` name it - the only thing that rebuilds a `max`, since no queue ever holds one.

**A row served the cameras' own picture owes a `full` only once an edit makes it rendered.** Its stamp also moves without one: the camera match written beneath the history, a composite's framing. `queueEditedSince` asks `rendition_source` and whether edits render the row (`EDITS_RENDER`, `renditions::sourceFor`'s `edited`) before comparing stamps, since such a row records no `full` to be newer than; owed on the stamp alone, every read would queue a pass that builds nothing and sweeps its `max`.

`PhotoDetail.renditions` answers the client's questions from **disk rather than from a column** - what each one's path is, whether it is built, whether it is HDR, what it weighs - because settings are not retroactive and a library switched to HDR after an import still has SDR files. `shown_rendition` is what the viewer opens at, and `rendition_to_build` is what has to be made first when that is not yet what the setting actually asked for - both resolved server-side (§18.5), so the client never has to re-derive either.

**A missing grid tile is rebuilt when the photo is opened.** The queue only visits photos flagged for processing, so a tile deleted under a catalogued photo - a wiped cache, a sweep that went too far - is a hole in the grid that nothing ever fills; reprocessing the photo would fill it at the cost of every other rendition. Opening the photo is when someone is looking, so `GET /api/photos/:id` stats the tile and, if it is gone, renders that one rendition in the background from the source the import used (the photo's `rendition_source`, or the library's). A side effect on a read, deliberately: the file is the cache, and repairing a cache on the read that noticed it is empty is what a cache does. One repair per photo is in flight at a time.

**Reprocessing clears every rendition it does not rewrite.** Changed pixels invalidate all cached copies, including max-resolution exports that otherwise persist indefinitely. Exempt outputs this job writes so the sweep cannot delete its results.

**A run that owes only the tile sweeps nothing.** `POST /api/photos/rebuild-tiles` sets `needs_tile` alone, and a run that was never going to write a rendition neither stamps `rendition_source` nor sweeps: nothing said the pixels changed, so the viewer's copies are still of the file it has. Sweeping there made regenerating a grid rendition delete the render the photo view was holding, which the next look then paid for again.

Writers fail the whole job on a missing directory. The worker therefore creates every output directory before running; relying on callers previously left one missing and failed the still too.

### 10.2 Concurrency Model

Processing uses **Bun worker threads** for parallelism. The concurrency level is configurable (default: 4 workers).

**Process in grid order.** `listPendingProcessing` uses the gallery's clause, including NULL capture dates, for the library's `ordering` (`taken_asc` by default: oldest first). Filesystem insertion order left the first screenful near the end of a 50k-frame import while photos three thousand rows down rendered. Both passes use the same staged list.

Only applied when the run names a single library: a batch spanning several has no one ordering to follow, and those runs are always an explicit set of ids the user just asked to rebuild. Above one `IN (...)` chunk the order is per chunk rather than global, which affects only sets far larger than a scoped sync ever carries (the watcher falls back to a full sync past 256 paths, §9.8).

The orchestrator (`processing_service.ts`):

1. Queries for all photos owing either stage with `is_missing = 0` (a photo whose file went missing while processing was still pending must not be run against the absent file; excluding it leaves its flags set so it is generated on the sync that clears `is_missing`, §9.4 step 4).
2. Maintains a work queue.
3. Spawns up to N Bun `Worker` instances, each running `processing_worker.ts`.
4. Sends photo processing jobs to workers via `postMessage`.
5. Workers send completion/error messages back.
6. On a success message, the orchestrator clears the flag for the stage that landed and stamps its `*_built_at`; the renditions stage also writes `rendition_source` and clears `processing_error`. On a failure message, it clears _both_ flags (so the photo is not silently reprocessed on every subsequent sync, and a file whose tile could not be built is not asked for renditions), records the worker's `error` string in `processing_error`, leaves the stamps unchanged, and logs via `console.error`. Such a photo has no rendition on disk (the worker deletes any partial or stale output on failure, §10.3), so the image endpoints 404 (§13.5), but `processing_error` distinguishes a failed photo from an unprocessed one.

### 10.3 Worker Implementation (`processing_worker.ts`)

Each worker:

1. Receives a message naming the RAW, the targets it has to write, and the sizes and qualities for each (passed in from config).
2. Decodes the RAW once, through `native/rawshim` (§10.4) → an RGB bitmap **already rotated to display orientation** (the decoder applies the EXIF flip; the raw buffer carries no EXIF for a downstream library to auto-rotate from). Lazily, and a **tile job never reaches it**: the grid tile comes off the embedded JPEG, so a tile-only pass opens the file for its preview and demosaics nothing (§10.1).
3. Fits the camera-match profile once, if the library asked for it (§10.8), then denoises and defringes the decode once.
4. Grades, transfers and encodes each target off that shared base, at the target's own size and for the display it is meant for.
5. On any failure, deletes every output the job names, if present (best-effort unlink), before reporting - so a failed job leaves no partial rendition and a failed reprocess does not leave the prior run's stale ones on disk (both share the id-keyed path). This upholds the §10.2 no-rendition invariant.
6. Sends back `{ photoId, success: true, source }` or `{ photoId, success: false, error: string }`.

**Decoded pixels stay in Rust.** Steps 2-4 run inside one `bb_run_job`: TypeScript exchanges JSON, never a 60MP frame or pointer. A local owned `Vec<u16>` needs no manual free; the last rendition releases it before encoding allocates, freeing 366MB at 61MP during the longest stage (§10.7).

**There is one rendering pipeline, and SDR is an output stage of it.** Everything internal is one 16-bit base through one grade; what a rendition's dynamic range reaches is the peak that grade rolls into and the transfer and depth of the buffer that leaves - PQ at 16 bits, or the sRGB primaries and transfer at 8. A second path for SDR - an 8-bit sRGB decode, `fit::apply`, and no tone map at all - is slower and larger both. Measured on a 3840px Sony rendition:

|           | second path | one pipeline |
| --------- | ----------- | ------------ |
| whole job | 1805ms      | **1722ms**   |
| peak RSS  | 376MB       | **341MB**    |

Although a 16-bit decode doubles sample storage for an 8-bit encode, fitting during decode (§10.4) lowers job memory versus the 8-bit path's later resize. Peak RSS, multiplied by `processing_concurrency`, is the relevant measure.

**What the whole change costs and buys, measured end to end.** Medians of three, against the two-pipeline version:

| 24MP fixture          | time              | peak RSS        |
| --------------------- | ----------------- | --------------- |
| one SDR at 3840       | 1767 → 2048ms     | 600 → **486MB** |
| one HDR at 3840       | 1692 → 2144ms     | 529 → 558MB     |
| **SDR + HDR at 3840** | 3424 → **2222ms** | 634 → **487MB** |
| HDR at native         | 3463 → 4100ms     | 714 → **707MB** |

| 61MP body       | time            | peak RSS        |
| --------------- | --------------- | --------------- |
| **grid + full** | 3722 → 3940ms   | 567 → **546MB** |
| HDR at native   | 10297 → 12108ms | 1375 → 1377MB   |

Memory is no worse on five of six rows, 5% higher on the sixth. Multiple outputs share decode, fit and filtering; the second needs a dispatch. Thus 24MP SDR+HDR beats a single HDR job, versus the prior pair's 94% surcharge. Single-output jobs are 16-27% slower than their specialised paths.

**Where the remaining single-output cost is, and where it is not.** It was the perceptual round trips, and it was the larger half: every filter pass converted a buffer it was not in and converted it back, at two `powf` a sample on the way back, and a `powf` in the loop is also what stops it vectorising. Isolated by running the job with that conversion replaced by an identity, it measured 400ms of 2650 on the 24MP fixture and it scales with the sensor. §10.9 removes it: the base is _coded once_, into normalised PQ, and every stage below the decode is pointwise on what the buffer holds.

What is left is that this pipeline denoises ahead of the warp and sharpens after it - two `image::finish` passes where the specialised path made one - which is the ordering §10.9 argues for on its own grounds and is not being paid back.

**Where the memory is, measured rather than assumed.** Peak RSS at native on a 61MP body read 1730MB before this was looked at, and the guess was the GPU - the dispatch wrote a `u32` per component and read it back through a second buffer of the same size, 732MB each. That guess was wrong twice over. Sampling `VmRSS` through the job showed _no_ rise at all across the upload: a `wgpu` buffer lives in device memory, and on this adapter none of it is resident. What the peak actually held was two 366MB CPU buffers alive at once - the cut and the graded frame the AVIF encode was working from - on top of the decode's own transient.

Release the cut immediately after GPU upload (`job::run`), its last read. Peak falls to 1381MB, level with the two-pipeline version's 1375.

**Rawler's remaining decode working set is unmeasured.** Denoise and demosaic use 2048px tiles; whole-frame RCD would need 3.1GB of planes at 61MP (`decode_rawler.rs`).

For a single picture whose drawn frame, decode or straightened output exceeds 128Mi pixels, the job measures a small whole view for its levels and scene peak, then prepares overlapping windows of the held source. Each window carries the neighbouring pixels needed by denoise, resize, lens gather and sharpen. The grade writes output rows in bands of roughly 16Mi pixels, and libavif writes those bands as one-column AVIF grid cells. The reader uses the same window path at a level too large to prepare whole.

The output is packed to two `u16` components a word regardless, and it is worth having for a reason RSS cannot show: every value `encode` writes is already a `round` into 0..65535 or 0..255, so a word per component spent half of the job's largest _device_ allocation on leading zeroes, and device memory is the scarcer of the two on an iGPU sharing it with the system. Three `u16` a pixel do not divide a word, so an invocation covers two pixels and writes three whole words rather than read-modify-writing a half its neighbour owns.

**The check that the colour still lands is against the camera's own JPEG**, since an SDR rendition now takes it from the HDR fit graded down rather than from `fit::Profile` (§10.8.1 exists to make those agree). Mean ΔE76 to the embedded preview, before against after: 1.038 → 1.020 on the Sony fixture, 1.898 → 2.122 on the Canon one.

Read that as bounding _gross_ change and nothing more. A mean ΔE76 is the one measure this design has repeatedly caught being blind to the errors that ruin a render - it discounts near-neutral error, cannot see a systematic cast at all, and hides its own tail (`fit.rs`, the `deltaE` section). What it says here is only that the one path did not move the colour by an amount that would show up even to a bad instrument. The reason to believe the rest is that both fixtures were rendered and looked at, at full size and unmatched as well as matched. What it does not bound is that an SDR rendition is a scene-referred render - diffuse white at the BT.2408 anchor, highlights rolled off by BT.2390 - rather than an 8-bit decode with its own auto-brightness. Held against a plain `decodeRaw` the two differ by a whole tone curve, which is why `lossless_render.integration.test.ts` asks the preview rather than the decode.

**Production never moves samples across the boundary.** The TypeScript-to-ffmpeg scene-linear frame and HDR fit moved into Rust. Tests comparing decode and output retain `pixels()` (§10.4, "Handles, not pixels").

**A job is one render with a list of outputs.** `Target.output` names what a rendition is coded as - `pq` at the grade's peak, or `srgb` at diffuse white - rather than carrying a `hdr` boolean for the render to interpret, so the sharing below is what the input describes rather than something the implementation happens to do. The library's `hdr` still says where a rendition is _stored_; `processing_worker` maps the one to the other, which is the only place the two vocabularies meet.

**Everything that does not depend on a target is settled before its output is written.** Targets small enough to render whole share a decode bounded to their largest requested size. Its unresized levels and a GPU-measured scene peak anchor their grades. A banded target uses that analysis and peak, then prepares and grades each window at its own drawn size. Whenever a target is banded, a whole view of at least 3840px supplies the analysis and peak.

**Over the same pixels on both hosts**, which is the whole of the requirement. A rendition gathering a proportional scatter of the base _before_ the warp and the sharpen, on the CPU, while the editor reads whole rows of the frame it hands the shader, after both, is the same estimator, the same shader and the same rank over a different million pixels - so a thin specular one sampling catches and the other steps over moves `scene_peak`, and with it where the roll-off knee lands. Nothing can see it: at the parity fixture's 6144 pixels both degenerate to the maximum over every pixel.

Converged onto the editor's, because the editor's is the one that cannot be changed - it has to measure what it draws. So `gpu::Uploaded::measure_peak` reads the frame that is already up, every nth row, and `encode` reads the answer out of a buffer instead of being handed a number. Measured, that is _cheaper_ on a 24MP frame than the gather-and-upload it replaced and 3% dearer on a 61MP one at native resolution, where a strided read of 366MB costs more than a compact 6MB strip did.

Once per photograph, not once per size (`gpu::ScenePeak`): a job uploads once per size group, so a grid-and-full job measured it twice - two frames, two peaks, two different knees, and 12% of the job spent doing it.

**A whole frame goes up once per size, not once per rendition.** Two whole outputs of one size differ by two words of a uniform, so `gpu::Uploaded` holds the frame, the matrix, the lattice, the curves and the output pair, and a second target costs a bind group and a dispatch. Banded targets upload each window separately. Measured while the grade was moving onto the GPU and before the base was coded, the shared whole-frame upload took the 24MP two-output job from 3084ms to 2510; the table above is the finished pipeline and its rows are not comparable with those two numbers.

Sharing scene peak fixes **correctness** as well as cost: every pixel's roll-off uses it, so different size estimates compressed highlights differently. The 3840px and 800px grade pins now share a peak instead of 6585 and 6477.

**And the renditions themselves share a frame, not just the settings.** `hdr::Cut` is the photo carried to the point where only the display still differs: normalised PQ codes, after the fit-to-size, the warp and the sharpen, and _before_ the colour transform. Targets are ordered largest first; the first is cut off the base and every smaller one is a `downscale` of it, so it builds no warp table of its own. What is left per rendition is one dispatch - the colour transform, the roll-off into its peak and the transfer, which the shader does in a single pass - and then the encode.

The shared frame is stored **coded, as `u16` PQ**. §10.9 describes the coding and its precision. Downscales decode each tap through the inverse-PQ table, average linear light and code the result back into the compact frame.

_`u16`_ rather than `f16`, which is the opposite of what it looks like it should be. Half precision is right for **nits**, which span decades - a shadow at hundredths, a highlight at thousands - and 11 bits of significand is ~0.05% wherever the exponent sits. It is wrong for **PQ**, which already normalises to 0..1: the exponent then buys nothing and 11 mantissa bits leaves an ULP of ~0.001 near white, about 87 output levels. Measured while the intermediate was still nits, `f16` PQ cost the shared route mean 5.04 counts of 65535 where `f16` nits cost 0.71. A `u16` is the same width, uniform across exactly the range PQ occupies, and is what the HDR encode wants anyway.

`a_rendition_cut_from_a_larger_frame_is_the_picture_it_would_have_been` holds the shared route against the direct one: a rendition cut at 1600 and taken down, against one cut at 800 outright, both graded through the same dispatch. It bounds the mean rather than pinning it, because what it is guarding is that the two routes stay the same picture, not that they stay a particular number of counts apart.

**Downscaling a larger rendition changes the result.** A resolution-independent colour transform need not commute with averaging: it is nonlinear, so `mean(f(x))` differs from `f(mean(x))`. Grade-then-resize and resize-then-grade are different pictures.

The shared route is checked directly against a rendition resized and graded on its own terms.
Both averages are taken in linear light. Their remaining difference comes from applying a
nonlinear colour transform before or after the resize, so the comparison bounds the resulting
picture rather than requiring those operations to commute.

**A tile job does not demosaic.** Tiles and renditions are two passes, and the tile takes the embedded JPEG, so the only thing that reaches the shared base is one `full` or `max` - or a grid tile whose file embeds no usable preview, which falls through to the render rather than failing, since the decode is no longer gated on some _other_ target having asked for one.

**An import runs in two passes, tiles before renditions.** Both cover the same photos, so this is purely an ordering choice, and it is the reason the stages are split at all: a tile is 18ms where a rendition is 1518ms (§10.4). On a 2000-frame shoot the whole grid is browsable in about ten seconds rather than after the eleven minutes the renders take.

**The scan builds the tile, and the row that follows takes it on by rename.** The scan already holds each RAW open to read its header, and the camera's small preview sits in the pages that read faulted, so a tile built there costs ~0.4ms against the 8-10ms of opening the file a second time for it - about a fifth of an import, measured (§10.4).

The scan has no photo id to name the file with: the row is inserted after the whole library has been walked, and a file that turns out to be a move never gets one. So it writes the tile under a **freshly minted id, in `grid/` itself**, with the stacking descriptor beside it, and that name is carried in scope - on the `DiskFile`, then the `AddedEntry` or `ModifiedEntry` it becomes - until the insert mints the real one. `ProcessingService.adoptScannedTile` then renames it to the photo's own name **in the same directory**, which is atomic, cannot cross a filesystem, and is the whole of what adopting one costs. It writes the same flag, the same stamp and the same descriptor the tile pass writes, so a tile whose pixels came from the scan is indistinguishable downstream.

Carry the staged name in scope. Deriving it twice from the photo path would need to encode potentially changed settings and could let an unrelated pass adopt the wrong tile.

The creating run deletes unclaimed tiles: moves already having a tile, or files never inserted. Killed runs leave non-photo names in `grid/`, covered by the existing orphan sweep (§10.6).

**The pending flag is per stage, because everything that reads it wants to know which one.** `needs_tile` and `needs_renditions` each clear as their own pass lands, so a run interrupted between them resumes at the second rather than redoing a tile already on disk; the queue asks for either (`countPendingProcessing` counts photos owing one, since the sync strip counts photos rather than stages); and the detail panel can say which of the two it is waiting on rather than reporting one word for two rather different waits. A failure clears both: the failure is the file, not the stage.

A failure sweeps _every_ derivative of that photo, not just the stage that failed. A photo is being reprocessed because its pixels changed, so a rendition the failed run never reached is of the old file and would otherwise be served forever with nothing to notice. The exception is a run that owed the tile alone (§10.3): nothing there says the pixels changed, so a failed rendition rebuild leaves the viewer's copies where they are.

**Rendition source.** The job names where the pixels come from:

| Source     | What it does                                                                                     | Trade-off                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `render`   | Demosaics the RAW (steps 2-3 above)                                                              | Full sensor resolution, slow                                                                                                    |
| `embedded` | Lifts the camera's own JPEG out of the file (`decoder.preview_jpeg`, handed on still compressed) | Much faster, the maker's colour treatment, but only as large as the body embedded, which ranges from 640×480 to the full sensor |

The embedded JPEG carries its own EXIF orientation, so the decode reads tag 0x0112 out of IFD0 and turns the frame; a render is already baked upright by the decoder (§11.1) and must not be rotated again. A file with no JPEG preview (some bodies embed a bitmap, or nothing) is a property of the file rather than an error, so an `embedded` request falls back to a render. The result reports what was **actually** used and `photos.rendition_source` records it, so the client can state which pixels are on screen instead of leaving the user to guess.

### 10.4 The native layer (`native/rawshim`, `raw_decoder.ts`)

> **Status: the decoder described below is LibRaw's, and it is gone.** RAW decoding is our vendored
> `rawler` fork (`native/vendor/dnglab`), the demosaic is RCD on the GPU (`slang/rcd.slang`,
> specified in `docs/rcd-algorithm-spec.md`), and the mosaic denoise is GALOSH on the GPU beside it.
> Both are the only implementation there is: a host with no Vulkan reads nothing rather than reading
> a different reconstruction (§2.1). So `imgdata.image`, `user_qual`, the
> PPG-against-AHD table and the C accessors are all history. The half-size decision is _not_: the
> gate below still reads, only the collapsing of each Bayer quad is now ours (`decode_rawler.rs`)
> rather than a LibRaw flag. What is still true, and why this stays: the _shape_ of the boundary is unchanged - a command
> and a result over `bun:ffi`, no pointers held across calls - and the measurements here are what the
> numbers since are compared against. Read the mechanism as history and the reasoning as current.

Everything that touches pixels is in one Rust library, called from TypeScript over `bun:ffi`. It links LibRaw for the RAW decode, lensfun for the lens database and libavif for every AVIF, read or written (§10.1). Everything in between is the crate's own Rust: the resampling and filtering in `image.rs` and `fit.rs`, the JPEG in `jpeg.rs`. TypeScript orchestrates: it passes a path and a job, and gets back a written file, a struct of scalars, or a count.

Minimal FFI bindings for LibRaw:

```typescript
// Pseudocode for the FFI interface
const libraw = dlopen('libraw.so', {
  libraw_init: { args: ['i32'], returns: 'ptr' },
  libraw_open_file: { args: ['ptr', 'ptr'], returns: 'i32' },
  libraw_adjust_sizes_info_only: { args: ['ptr'], returns: 'i32' }, // applies flip swap to sizes.iwidth/iheight without decoding (§11.1)
  libraw_unpack: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_process: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_make_mem_image: { args: ['ptr', 'ptr'], returns: 'ptr' },
  libraw_dcraw_clear_mem: { args: ['ptr'], returns: 'void' }, // frees the mem-image buffer
  libraw_close: { args: ['ptr'], returns: 'void' },
  libraw_recycle: { args: ['ptr'], returns: 'void' },
});
```

The decoder function:

1. Calls `libraw_init(0)` to create a processor. LibRaw's default `user_flip = -1` already applies the camera's EXIF orientation during `dcraw_process`, so the output RGB buffer is upright (a raw bitmap carries no EXIF, so nothing downstream can rotate on its own). **Do not override `user_flip` to `0`**; that would emit unrotated pixels and misorient landscape/portrait renditions. Relying on the default also avoids poking a struct field by offset through FFI, which is version-fragile.
2. Opens the file with `libraw_open_file`.
3. Calls `libraw_unpack` and `libraw_dcraw_process`.
4. Calls `libraw_dcraw_make_mem_image` to get the processed image in memory.
5. Reads the image dimensions and pixel data from the returned struct.
6. Copies the pixels into a JS `Buffer`. The mem-image is heap-allocated by LibRaw and must be freed with `libraw_dcraw_clear_mem` on every path (see step 8), including if the copy in this step throws.
7. Returns `{ width, height, data: Buffer }` (raw RGB pixels).
8. Cleans up in a `finally` so every path (including a decode or copy error) releases resources: `libraw_dcraw_clear_mem` on the mem-image pointer if it was allocated (null-guarded, since an error before step 4 leaves it unset), then `libraw_recycle` and `libraw_close` on the processor.

**Memory-leak audit:** pair every LibRaw allocation with its free on all paths, including errors: mem-image (`libraw_dcraw_clear_mem`), unpacked data (`libraw_recycle`), processor (`libraw_close`). Audit the full FFI lifecycle.

**One copy, not two** - and for a while that claim was wrong. The frame is copied out with the masked-border crop applied on the way, rather than copied whole and then cropped out of that, which on a 60MP frame is ~190MB moved twice. But `dcraw_make_mem_image` is _itself_ a copy: `dcraw_process` leaves the frame in `imgdata.image` as four `ushort` planes in sensor orientation, and that call allocates a second whole frame to interleave it into. Measured on a 24MP frame it is 153-198ms, with the copy after it another ~80ms, against a ~535ms decode - nearly half the decode spent moving bytes that had already been computed.

**So the scene-linear decode reads `imgdata.image` directly**, interleaving, orienting and cropping in one parallel pass. On a 24MP frame that is 575ms to 372ms on a Sony and 593ms to 338ms on a Canon, ~40% off the decode.

Only the scene-linear one, and the reason is the output curve rather than caution. `copy_mem_image` **rebuilds `imgdata.color.curve` before reading it** - the table sitting in the struct is not the one LibRaw is about to use - so reproducing it means reproducing dcraw's `gamma_curve(gamm[0], gamm[1], 2, (t_white << 3) / bright)`. The _shape_ of that curve is standard: a linear toe of slope `ts` joined to a power law of exponent `pwr`, solved for continuity, which is the same construction as BT.709 (0.45, 4.5), sRGB (1/2.4, 12.92) and ProPhoto (1/1.8, 16) - LibRaw's default `gamm` is literally BT.709. What is _not_ standard is where its arguments come from: on the sRGB path `t_white` is scanned out of a histogram against `auto_bright_thr`, a dcraw heuristic this has no business shadowing, and shadowing it against a binary `.so` is the same "we believe this is right" bet the wrapper exists to avoid.

On the scene-linear path every one of those arguments is a constant set a few lines earlier: `no_auto_bright` pins `t_white` at 0x2000, `bright` is 1, and `gamm` is {1,1}. Solve dcraw's curve for those and the bisection takes g[3] to 1 with g[4] at 0, so the table collapses to `curve[i] = i`. There is therefore no lookup on this path at all - the identity is not an assumption about LibRaw, it is what those constants make the curve. The guard checks all four before taking the direct route and falls back to `dcraw_make_mem_image` otherwise, which is what the 8-bit path always does.

`native/rawshim/src/fixture_tests.rs` pins the reasoning: both decode routes must match byte-for-byte on both fixtures, full and half size, covering both flip orientations and inset cases.

**The fit to the rendition's size happens here too**, in the same pass. A 3840px HDR rendition off a 24MP frame wants 59MB, and building the whole 145MB decode only for the grade to box-average it down meant that buffer coexisting with LibRaw's 194MB working set. Averaging straight out of the decoder's own buffer is the same filter over the same source pixels in the same order, so `hdr::shrink` then finds the frame already at size and declines - the intermediate simply never exists. Measured on the 24MP fixture at 3840, the decode's transient falls from **420MB to 338MB** and what it leaves resident for the rest of the job from 188MB to 106MB, which is the figure that multiplies by `processing_concurrency`.

A differential test pins bit identity: its reference applies the fit separately and SHA1s must match. Verified at 3840, 800, 640 and native, including composed half-size cases.

The fit is only applied to the scene-linear path. The 8-bit one is reduced by a different filter (Lanczos3, against the box average here), so shrinking it here would change the picture rather than just move where the work happens.

**PPG rather than LibRaw's default AHD** (`user_qual = 2`), overridable with `BOWERBIRD_DEMOSAIC`. Whole-decode wall time, and the mean difference each algorithm shows against AHD once resized to a 3840px rendition:

| `user_qual` |         | 24MP      | 61MP       | vs AHD at 3840 |
| ----------- | ------- | --------- | ---------- | -------------- |
| 2           | **PPG** | **511ms** | **2202ms** | 0.85% / ΔE 2.6 |
| 3           | AHD     | 623ms     | 2463ms     | -              |
| 0           | linear  | 664ms     | 2631ms     | 1.00% / ΔE 3.1 |
| 11          | DHT     | 904ms     | 3221ms     | 1.04% / ΔE 3.3 |
| 4           | DCB     | 2327ms    | 7148ms     | 0.86% / ΔE 2.5 |
| 1           | VNG     | 2377ms    | 7067ms     | 0.82% / ΔE 2.4 |
| 12          | AAHD    | 4783ms    | 13340ms    | 0.87% / ΔE 2.6 |

PPG stays: cheapest, not worst. This is no quality ranking: AHD distance measures disagreement without synthetic-mosaic ground truth. At 61MP, renditions under 4864px halve the decode and bypass demosaic entirely (below).

Note also that quality 0 (linear) is _slower_ than AHD, and worse - strictly dominated, which is not what the name suggests.

**A demosaic benchmark has to force a full decode.** The PPG/AHD difference is ~0.8% on both a 24MP and a 61MP frame. Measuring it through the app's normal path instead puts `half_size` in the way on a large frame, and a half-size decode bypasses demosaic entirely - so the two algorithms get compared while neither is running, which is how the same measurement reads 0.18%, one 8-bit level in four.

**Half-size decoding, when the caller can afford it.** `decodeRaw` takes an `atLeastLongEdge`: the longest edge the caller is going to need. When halving the frame still clears that, LibRaw's `half_size` runs instead, collapsing each Bayer quad into one output pixel rather than interpolating. On a 61MP frame that is 1592ms of decode down to 956ms - the demosaic 594ms to 128ms and the copy 183ms to 46ms, while the unpack is raw decompression and does not move - and it makes every downstream resize a quarter of the work. End to end an import of that frame goes from 3414ms to 2580ms.

It is a genuine quality trade, not a free one: dark edges pick up a faint checkerboard, visible when pixel-peeping at 100%. Hence the gate. A 61MP sensor halves to 4864 and still clears the 3840 a full rendition wants; a 24MP one halves to about 3012 and does not, so it decodes whole. A native-resolution rendition passes 0, which means the whole frame rather than "no preference". The 4k rendition is a triage view and the artefacts do not survive being looked at normally; the max rendition exists to be pixel-peeped and never takes this path.

**The one decode takes it.** Passing 0 unconditionally demosaics a 61MP frame in full, only for the grade to box-resize it to 3840 as its first act (§10.8.1) - fifteen sixteenths of the most expensive stage in the pipeline, thrown away. So it asks for the largest edge any of the job's render targets wants, and a `max` target reports 0 and is never halved. Two _jobs_ over one photo therefore anchor their grades on decodes of different resolutions, and since the grade's anchor comes from the frame, a `full` and a `max` built separately can land on slightly different tone curves. Measured by grading both to the same output size: a **0.32% difference in mean brightness**, 0.2% RMS. Within one job it cannot happen at all, the levels being read once off the shared decode (§10.3).

The measured 0.32% sits below the accepted ΔE 0.21 crop-search trade (§10.8) and a just-noticeable difference. Exactness would require resolution-independent level measurement, not disabling halving.

**There is no 8-bit decode in the job at all** (§10.3). One scene-linear decode serves the camera-match fit and every rendition, whatever their dynamic range.

**`half_size` has no setter in the C API**, and that is why the decode lives in Rust (`native/rawshim`) rather than in TypeScript. The FFI could only reach the field by locating `libraw_output_params_t` at runtime and writing at an offset; that worked, and was cross-checked from two directions, but its neighbours are `four_color_rgb` and `use_auto_wb`, either of which silently changes the picture when written to by mistake while leaving the dimensions perfectly plausible. bindgen resolves the field from the same headers the runtime library was built from, so the offset is the compiler's problem and stops being ours.

The wrapper owns the whole decode, because it is one job: as-shot white balance, the PPG demosaic, the half-size decision and the masked-border crop. **The decode itself buys no speed** - measured against the TypeScript path it is 0.99x on a 61MP frame and 1.07x on a 24MP one, pixel-identical, because the time is inside LibRaw's unpack and demosaic either way. That was a correctness change. What it also did was put the boundary in the right place for everything else to follow.

#### Commands, not handles

**Rendition jobs exchange JSON.** `bb_run_job` reads UTF-8 and writes UTF-8 into a caller-owned buffer. No library-owned pointer crosses: no inter-call handle, manual free or conventional lifetime.

That last point is why it changed. The previous boundary passed an opaque pointer to a bitmap Rust owned, and each operation took a handle and returned another - which reads as safe and is not, because a raw pointer carries no lifetime. `hdr_source<'a>(image: *const BbImage, ..) -> Option<(Source<'a>, ..)>` had a **free lifetime parameter**: `'a` was constrained by nothing, so the caller picked it and a borrow of the pixels could outlive them by any amount. The compiler accepts a use-after-free written that way; it was held off by review and by runtime null checks, not by the type system.

`job.rs` owns orchestration: two lazy decodes, camera fit, shared base and target loop. Each decode is a local owned `Frame`, borrowed through references and dropped when unused.

**Three things ownership manages that a handle API leaves to hand.** There is no `open` list and no `finally`, because a value is dropped when its scope ends - two of the three ways that shape leaks a 366MB frame. There is no `release_pixels` and no `release_source` flag: freeing the decode before the encode allocates is the peak that matters, and `hdr::Decode::Owned` says it to the compiler, where a flag says it to a reader and needs a nulled pointer and a re-check at every accessor to be safe. And `Frame` holds `Vec<u16>` for a 16-bit decode rather than bytes every reader reinterprets, which a boundary handing over one `*mut u8` to be freed as one allocation cannot do.

Measured across the change: HDR at 3840 peaks at 343MB against 339, native 577MB against 582, SDR at 3840 424MB against 421. Within noise, which is the claim - this is a safety change and it had to cost nothing.

**Unsafe is denied crate-wide** and exempted one operation at a time, by three lints that only work as a set. `deny(unsafe_code)` stops new unsafe appearing unmarked; `deny(unsafe_op_in_unsafe_fn)` stops an `unsafe fn` body being one blanket over its contents, so the count means operations rather than functions; and `deny(unfulfilled_lint_expectations)`, paired with `#[expect(unsafe_code)]` rather than `#[allow]`, makes a marker that no longer covers anything an error too - so unsafe that is refactored away takes its marker with it in the same commit. `grep -rn "expect(unsafe_code)" native/rawshim/src` is the audit. What remains is irreducible: reading the command buffer at an entry point, and calling libavif and libjxl, which are C.

**There is no handle API.** The case for one is that the pins have to assert on what the library produced and reading samples back is the only way to do it. It is not: everything those assertions check is a digest, a statistic or a comparison, and each is cheaper to compute where the pixels already are. `bb_for_testing_debug` answers those questions in the same shape as `bb_run_job` - JSON in, JSON out. Nine entry points, none of which returns a pointer, and no `bb_free` of any kind because nothing is handed over to be freed.

Getting this wrong the first time is worth recording, because the wrong version looked reasonable. Each call took a pixel pointer and returned a buffer, so `bb_fit` copied the render out of JS into a `Vec`, having already copied it _into_ JS at the end of the decode: three ~45MB moves of pixels no JavaScript ever read. The same mistake shaped the libvips calls, one function per operation, each materialising its result for the next to copy back in - which threw away the lazy pipeline that is the whole reason libvips is fast, and is why the first native version _lost_ to sharp on a 61MP fit, 915ms against 423ms. Chaining the operations into one graph and borrowing rather than copying closed most of it; moving the boundary closed the rest.

The rule that falls out: **pixels cross only on their way into an HTTP response.** Nothing else. `GET .../embedded` hands the camera's preview to a `Response` unchanged, and `GET .../download` hands over a transcoded JPEG where the library is SDR (an HDR one streams the AVIF from disk and crosses nothing); both are bytes bound for a socket, and both are copied into a buffer this side allocated rather than handed over as an address. Every other path - the decode, the fit, the grade, the warp, all four encoders - begins and ends on the Rust side.

The door in the other direction is **`rawshim_for_testing.ts`**, and lint keeps it shut: `.oxlintrc.json` bans it from `src/**`, allowing it only under `test/` and `**/tests/**`. Everything it exposes is prefixed `_for_testing_`, including the entry point it travels through, so reaching it from production code means typing the word.

It is small, because most of what would use it is not about TypeScript. **A test that asserts on Rust belongs in Rust**: the decode pins, the halving gate, the camera-match fit and the HDR grade are `native/rawshim/src/fixture_tests.rs`, where an FFI round trip would buy nothing but a JSON encoding of the answer - and keeping them here costs nine entry points and most of the debug commands. What is in TypeScript is what is genuinely about TypeScript: a job through a real worker thread, a rendition through the service, the settings round-trip, and the encodes verified with `ffprobe`.

**There is no exception, and there was nearly one.** The last candidate was `raw_header`'s black-border check, which reads four specific pixels, one per edge: a masked border that was not cropped decodes as black bars, and that shows up in no aggregate at all, because the frame is mostly picture and a bar barely moves a mean. It looked like the one assertion that needed bytes, and a guarded write-to-disk door was built for it. It is not - four triples is a summary like any other, so `pixelsAt` returns them and the door is gone. A point outside the frame comes back null rather than black, so a wrong coordinate cannot pass for a dark pixel.

Lint blocks plausible-looking TypeScript sample processing that would duplicate colour models and move loops into the slower language. `src/**` reaches only `rawshim_job.ts`: commands, results and encoded download bodies.

Getting there took removing three round trips that each looked reasonable. The embedded preview was extracted into a `Buffer` - 5-14MB, since a 61MP body embeds a full-resolution one - and handed straight back to be decoded. The fit took that preview _and_ the whole RAW, 60-120MB, so TypeScript could find one maker-note tag in the first few kilobytes. And a rendition being transcoded was read off disk into JavaScript only to be passed back down; `decodeFile` takes the path instead.

#### Two Rust suites

`cargo test` runs on synthetic inputs and finishes in 0.04s, which is what makes it worth running on every edit. The tests that decode a real RAW sit behind a `fixtures` feature - `bun run test:native --features fixtures fixture_tests`, ~8s - and that is the pass before calling something done. A cargo feature rather than `#[ignore]`, so the two have names and the slow one cannot be run by accident.

Missing committed fixtures fail and name `git lfs pull`. The uncommitted 61MP halving fixture prints SKIPPED when absent; the opt-in suite must never silently run nothing.

The grade on a real 3840px photo is pinned as pictures (`snapshot.rs`, `test/fixtures/snapshots/hdr-grade/`): the whole frame downscaled and a 1:1 crop, held to a tolerance rather than to bytes, because the grade runs on a GPU and a hash of GPU output pins the adapter that produced it. The **mean** difference is the bound that says the grade moved - it agrees to a fraction of a count across adapters and moves by hundreds when a matrix row is wrong - where the worst sample is one the last ulp of a steep transfer decides, and is bounded loosely.

The differential decode pin lost its machinery on the way. `BOWERBIRD_REFERENCE_COPY` existed because the route was read from the environment inside the library, which meant a subprocess per case to set it. In one process it is just a parameter.

#### What it bought

An import job - decode, fit, grade, and write a 3840px view plus an 800px tile - against the sharp pipeline it replaced. That was one job doing both; the tile is its own pass off the embedded JPEG now (§10.3), so read the tile column as history rather than as what a tile costs today:

| Frame                | sharp  | native |      |
| -------------------- | ------ | ------ | ---- |
| 24MP, no halving     | 3478ms | 1560ms | 2.2x |
| 61MP, halved to 15MP | 2701ms | 2135ms | 1.3x |
| 61MP, halved to 15MP | 3425ms | 2620ms | 1.3x |

By stage on the 24MP frame, which is the clearest because nothing is halved: decode 499→490 (identical code), fit 844→466, grade 1542→307, 3840px AVIF 563→280, 800px tile 30→21.

The grade is where the boundary shows: it was a JS loop over 72MB with a sharp resize round-trip on either side, and is now one pass in Rust. The encoders are roughly 2x, which is not our work but the system libvips 8.15.1 build against sharp's bundled one. **The fit is not where it shows** - it was already in Rust before the handles, at 451ms, so removing its copy is inside the noise. Worth stating plainly, because "we removed three 45MB copies" invites the assumption that the copies were the cost; on the fit they were not.

The embedded-preview and header paths (§11.1) stayed on the C API through `bun:ffi` for a while after this, on the grounds that they touched no struct lacking an accessor and so had nothing to gain from crossing into Rust. They crossed anyway when the decoder changed: rawler hands back named fields, which is what the six tables of hardcoded offsets in TypeScript were the alternative to (`bb_extract_embedded`, `bb_read_header`).

`bun run build:native` builds it, at cargo's stock release profile; the Docker build does so in its own stage and copies only the `.so` forward, keeping rustc, cargo and libclang out of the shipped image.

**`opt-level` and LTO are not levers here.** Measured end to end on the rendition job, `opt-level = 2`, `opt-level = 3` and `opt-level = 3` with fat LTO and one codegen unit are indistinguishable - every stage inside noise across two frames. Structural rather than incidental: the expensive work was inside libvips and LibRaw, both precompiled shared libraries no profile of ours reaches and LTO cannot cross into, and this crate's own hot loops (`warp`, `pairs`, `score`, `apply`) already vectorise at `opt-level = 2` and are all in one crate, so there is nothing for LTO to inline across. A pinned `opt-level = 2` was removed for saying nothing; a full rebuild is 0.4s either way. Most of the premise has since moved - the resize, the blur and the JPEG are this crate's dependencies now, not libvips' - so the measurement is due a repeat; each replacement carries its own SIMD kernels rather than relying on the profile to vectorise them, and all are separate crates that LTO still cannot inline across at `codegen-units = 16`, which is the reason to expect the conclusion to hold rather than a reason to assume it.

The Docker image ships one `librawshim.so`, built with `-C target-cpu=x86-64`. It runs on
Goldmont Celerons in low-end NAS boxes, which have no AVX. `native/entrypoint.sh` sets
`BOWERBIRD_NATIVE_LIB` to the packaged library, reports the GPU adapter and starts the app.

#### What an import costs, by stage

A shoot import is three different jobs with three different costs, measured over 23 real ARWs (a 24MP body and a 61MP one):

|                                     | per file | at concurrency 8 |
| ----------------------------------- | -------- | ---------------- |
| A, header read for the catalogue    | 2ms      | -                |
| A, sha256 of the file               | 107ms    | I/O bound        |
| B, grid tile from the embedded JPEG | **18ms** | **137 img/s**    |
| C, full render and 3840px AVIF      | 1501ms   | 3.08 img/s       |

B is measured separately, over 50 61MP ARWs on a network mount at concurrency 4 (`examples/import_fuse.rs`), because it is the row that moved: it takes the smallest embedded preview that covers the tile rather than the body's own full-resolution one (below).

**B has forty times C's throughput.** Tiles-first makes a 2000-frame grid browsable in about ten seconds; interleaved jobs need C's eleven minutes to reach the last tile.

**Opening the RAW is not a time sink, so B and C need not share one.** The suspicion was that a fused pass would be needed to avoid opening each file twice, but extracting the embedded preview - the open plus the thumbnail - was **5ms of B's 124ms** when that was LibRaw's. A RAW reader parses headers lazily and the embedded preview is a few MB, which is as true of rawler's `preview_jpeg`, so B never touches the sensor data C needs. They can be scheduled independently, which is the whole point.

Asked again of rawler, over a corpus already in memory, A and B fused into one source and one decoder come out **within 1% of the two passes**, because A is 0.1-1.2ms of tag walk when the bytes are there. That answer is an artefact of the corpus being warm, and it is the wrong one.

**Evicting the page cache does not make that number cold.** A NAS answers an evicted client out of its own ARC, which `POSIX_FADV_DONTNEED` cannot reach: measured on the mount a library lives on, the first 256KB of a file untouched for a month takes **32ms**, the same file a second later 1.8ms. A corpus that is built and then read repeatedly is timed entirely in the 1.8ms world - so a cold reading needs a corpus per arm, each file read exactly once.

What does not depend on a cache is _where_ each pass reads, which `mincore` answers after evicting the file (`examples/import_fuse.rs`). **On the a7CR over the mount, all three passes read one 1.05MB run at the head of the file and nothing else** - A, B and the fused pass have the same map, and B wants not one page A had not already taken. The tag walk and the small preview are inside the same readahead window, so A is a second trip over ground B covers anyway.

Timed over the product's own pipeline - the real `ScanPool` over the real `scan_worker` in `inodeOrder` at `scan_concurrency`, the whole corpus scanned before the first tile, then the real `ProcessingService` over the real `processing_worker`, against one pool of the same width doing both per file (`scripts/bench_import.ts`) - **fusing is worth about a fifth of an import.** Three pairs of untouched directories on the NFS mount, an arm each, the a7CR's ~81MB files:

| files per arm | pass 1 | pass 2 | split  | fused  |            |
| ------------- | ------ | ------ | ------ | ------ | ---------- |
| 430           | 27.3ms | 8.3ms  | 35.6ms | 27.7ms | **-22.2%** |
| 299           | 28.2ms | 8.7ms  | 36.9ms | 30.7ms | **-16.7%** |
| 173           | 35.1ms | 10.0ms | 45.1ms | 35.2ms | **-22.0%** |

**The shape of it is that the fused pass costs what the scan alone costs.** Pass 2 is 8-10ms of a 36-45ms pair and essentially all of it disappears: the tile is a JPEG that sits in the pages the tag walk already faulted, so once the file is open the picture is nearly free. What the second pass buys is a second `stat`, a second open, a second decoder, a second walk of the same tags, and a second worker handoff, for bytes that are already there.

That the _seek_ is paid once either way is why this is a fifth rather than a half: within one import the tile pass reaches a file the scan pass brought into memory, which at ~1MB faulted per file stays resident for libraries far larger than this one.

**A 61MP body embeds a full-resolution preview**, 9504x6336 and 5-14MB of JPEG, not the small preview the name suggests - only the 24MP body in the corpus embeds something small (1080x1616). Decoding that whole to make an 800px tile was most of stage B: 458ms per file, of which 230-540ms was the JPEG decode and, on portrait frames, half of _that_ was the EXIF rotation shuffling 60MP. Shrinking during the decode instead (`Decoder::scale`, then a reduce for the rest, and the rotation last where it moves a 1280px frame) takes B to 105ms. B asks for the smallest preview that covers the tile (`decode_rawler::Preview::SmallestCovering`), which on that body is the 1MB one rather than the 5-14MB one, and that is what puts it at 18ms.

**The DCT is asked to go all the way to the target**, rather than stopping a factor of two short and leaving the reduce something to work with. It is a quality trade, because libjpeg's scaling and a Lanczos3 reduce are different filters: measured against decoding whole and reducing once, an 800px tile moves from deltaE 0.29 mean to 0.63, and its worst pixels from 7 to 24. The error is confined to fine detail where the two filters disagree - foliage, not sky - and at tile size it is invisible even under a 1:1 crop, which is the whole argument for taking it. Worth 105ms per file against 125ms.

A quarter of the output pixels saves only a fifth of the time: Huffman decoding still visits every coefficient block. Only inverse DCT, chroma upsampling and colour conversion shrink.

#### Where the time actually goes

Single-image latency is the wrong measure for an import, and the difference is large enough to change decisions. Throughput on a 24MP frame, 8 cores:

| concurrency      | 1    | 2    | 4    | 8    | 12   |
| ---------------- | ---- | ---- | ---- | ---- | ---- |
| img/s            | 0.53 | 1.04 | 1.69 | 2.40 | 2.35 |
| effective ms/img | 1897 | 964  | 590  | 417  | 425  |

It saturates at ~2.4 img/s: 4.5x the single-image rate, and flat past 8. An import is already throughput-bound with every core busy, so per-photo latency work only pays if it reduces total CPU. With the thread pools pinned to one, that budget is decode 495ms (26%), fit 675ms (36%), grade 364ms (19%), the two AVIF encodes 353ms (19%). Measured before the renditions moved to 4:2:0, which roughly halves the encode share (§10.1) and makes the fit a larger fraction of what is left rather than a smaller one.

**Rayon buys ~3% of the fit** (505ms against 490ms with it disabled), which is worth knowing before optimising the scan further. The parallel candidate scan is genuinely parallel but small; what dominates is the sequential refine, a hill-climb whose every step depends on the last. That is also why a GPU is not the obvious answer it looks like - see below.

#### Why not a GPU

Revisited after an overly narrow first answer: per-pixel grading suits GPUs, and thousands of independent import frames suit their width. Per-image latency alone cannot decide.

**Fixed-function AV1 cannot do 4:4:4**, which on its own settles the hardware question. NVIDIA's support matrix gives AV1 as "YUV 420 8-bit and 10-bit" on Ada and Blackwell only; 4:4:4 exists for H.264 and HEVC but not AV1, and neither AMD's VCN 4.0 nor Intel's Arc QSV documents it. Vulkan's `VK_KHR_video_encode_av1` maps to the same silicon, so it inherits the same limit. No hardware _decoder_ takes 4:4:4 either.

**That wall moved when 4:2:0 became the default** (§10.1, §10.7). Everything shipped by default is now a profile the video engines encode, so the profile objection no longer rules the fixed-function path out - it only rules out the two settings that turn 4:4:4 back on. What remains is untested here rather than answered: fixed-function encoders are tuned for video at a bitrate rather than a still at a quality, the quality-per-byte comparison against libaom `allintra` has not been run, and it would be a per-vendor dependency for a stage that is already a fraction of an import. Worth revisiting deliberately if encode time ever dominates again; not a settled "no" any more.

**A compute-shader AV1 encoder would sidestep that, and does not exist.** Running the encoder on shader cores rather than the video engine means implementing whatever profile you like, so it is the right question to ask. The state of the art is FFmpeg's Vulkan compute codecs, and the list is FFV1 and ProRes - chosen precisely because they use table-based coding. The barrier is AV1's multi-symbol arithmetic coder: the next symbol depends on the previous one, so a bitstream is a serial dependency chain, and speculation does not go deep.

Batching across images is the right counter-argument and still loses, for a reason that is about the hardware rather than the algorithm. N images give N independent coders, but GPU lanes execute a warp in lockstep, and entropy coding is maximally branch-divergent, so lanes serialise against each other and most of the width is lost. The per-image RDO working set also bounds how many can be resident. The architecture that does work is a hybrid - GPU for transforms, prediction and RDO scoring, CPU for entropy coding - which is what the research does, and which no open-source AV1 encoder implements.

**Demosaic on GPU is real but buys the wrong thing.** NPP's `nppiCFAToRGB` is bilinear with chroma correlation, which is the `linear` quality in the table above - both slower than PPG _and_ further from AHD, so the vendor-supported kernel is the algorithm this deliberately does not use. Good GPU implementations exist (darktable's OpenCL kernels, GPL3; Fastvideo's commercial CUDA) but neither is a drop-in. And the stage is smaller than it looks: any rendition under 4864px decodes a 61MP frame at half size, which skips demosaic altogether. **This one was overturned outright.** The premise it rests on is that a GPU demosaic would be somebody else's CUDA; RCD is written here, in WGSL, on wgpu, so neither the vendor lock nor the drop-in question arose.

**The RAW unpack is the part that cannot move at all.** ARW and CR2 carry Bayer data in lossless JPEG, whose Huffman decoding is bit-serial - the same objection as the AV1 coder. nvJPEG does not apply, being a baseline DCT decoder. Only Fastvideo claims GPU lossless-JPEG for these formats, proprietary. From the half-size measurements, unpack is roughly half the decode.

So the reachable target is the grade (19% of the CPU budget), plus a demosaic that would be worse, against CUDA as a hard NVIDIA-only dependency and a second implementation of the pixel maths kept in agreement with the CPU one - which has to stay, since the baseline exists for machines with no AVX at all.

**The cheaper lever is the fit**, 36% of the budget and dominated by a sequential refine, so parallelising its axis probes or cutting evaluation count attacks the largest share with no new dependency. The AVIF encoder is _not_ a lever: the alternatives were measured and neither beats libaom (below).

**libaom, after measuring the alternatives.** This was settled while the AVIF encode still went through libheif, which can be built against libaom, rav1e, SVT-AV1 or x265 and picks between them by plugin priority. All three AV1 encoders were installed and compared on the 3840px rendition. The encode has since moved to libavif (§10.1), which is libaom and nothing else - so this measurement is what makes that not a narrowing, and the rest of this subsection is why.

| Q   | libaom |        |       | rav1e |         |       |
| --- | ------ | ------ | ----- | ----- | ------- | ----- |
|     | ms     | bytes  | PSNR  | ms    | bytes   | PSNR  |
| 60  | 272    | 1.06MB | 33.53 | 1634  | 1.99MB  | 34.73 |
| 80  | 404    | 3.50MB | 37.19 | 2300  | 4.80MB  | 38.74 |
| 88  | 511    | 5.67MB | 40.13 | 2731  | 6.82MB  | 41.50 |
| 95  | 602    | 9.66MB | 44.66 | 3422  | 10.15MB | 45.45 |

rav1e's higher scores at every Q also cost more bits. At libaom's 5.67MB, interpolation gives ~39.9 PSNR versus 40.13: equivalent rate-distortion within measurement error, with libaom **5-6x faster**. Keep libaom.

**rav1e is not slow for want of configuration.** The obvious suspects were checked. The `effort` mapping is not inverted - effort 0 is the fastest for both encoders, so libvips' polarity survives the trip through libheif into rav1e's `speed`. And it is not a missing thread count: measured as CPU time over wall time, rav1e uses _more_ cores than libaom (3.7-3.9 against 2.2-3.6) and is still 5x slower, so it is doing more work per output bit rather than doing it on fewer cores. There was also nothing left to set: libvips' `heifsave` exposed no threads, tiles or jobs parameter, so how a plugin parallelised was entirely libheif's business - one of the things calling libavif directly bought back.

The import pool already saturates CPU at ~2.4 img/s; more encoder threads add contention. They could help single-photo `max` and lossless exports, where only 2.2 of 12 threads are busy.

**SVT-AV1 wrote a 201-byte broken file and reported success.** §10.7 records that it implements AV1 Profile 0 only and converts 4:4:4 down silently; through libheif 1.17.6 it did not even manage that - `vips_heifsave` returned 0, and what landed on disk had no valid stream (`missing mandatory atoms, broken header`). Unusable, and unusable in a way that no error surfaced. libheif's `auto` picks by plugin priority, so that was one deployment's package ordering away from a silently corrupt rendition; naming the encoder guarded it, and linking libavif removed the choice.

**The resize and the blur are Rust, and that is a correctness fix before it is a speed one.** libvips did both until the RAW editor needed the same pipeline in the browser, where there is no libvips: the wasm build got a bilinear gather for the reduce and an f64 convolution for the blur, and the two targets then fitted _different lens profiles from the same frame_. Measured against libvips' Lanczos3 on the 6000x4000 -> 1280 reduce a fit actually performs, that gather was **mean 12.4 of 255 off, worst 241** - it reads four of every hundred source pixels and aliases the rest - which is enough to pick a different lens tier on IMG_5360. That was answered first by one `image::resize` (`fast_image_resize`, Lanczos3) and one `fit::blur` (`libblur`, stack blur), both pure Rust and compiled into both targets, which made `fit_from_preview` a single function rather than a native one and a wasm one that were supposed to agree. Both are now `fit_grids.slang`, which is the same answer taken one step further: the fit's grids are built where the frame already is, so there is no host resampler for the two targets to disagree about at all.

Neither replacement is a compromise made for the browser's sake; both are cheaper than what they replace **and** land where libvips landed:

|                                 | vs libvips                | CPU    | libvips' CPU |
| ------------------------------- | ------------------------- | ------ | ------------ |
| `resize`, 6000x4000 -> 1280x853 | mean 0.87 of 255, worst 6 | 15ms   | 255ms        |
| `resize`, 1280x853 -> 640x426   | mean 0.11, worst 2        | 1.3ms  | 3.8ms        |
| `blur`, sigma 6 on 1280x853     | mean 0.60, worst 6        | 1.75ms | 6.5ms        |

The 17x on the big reduce is SIMD integer kernels against a general tiled float pipeline, and it is CPU rather than wall time, so it is 17x less machine rather than 17x less waiting. The blur number is against the f64 convolution the wasm build had, which cost 338ms - more CPU than the entire rest of the fit. Only the `matched` grade pin moved, by at most 0.09% of peak on any sample; the `neutral` rows are byte-identical, because no fit runs on that path.

With both gone libvips was down to three calls, and **one of them was not JPEG at all**: an SDR rendition is an AVIF, so the download that asks for JPEG had libvips decoding a file libavif wrote a few lines away. So libvips is gone entirely. `jpeg.rs` decodes and encodes JPEG (`jpeg-decoder`, `jpeg-encoder`), `avif::decode` reads a rendition back with the library that wrote it, and `image::decode` sniffs which of the two a file is - the callers that need it hold a path, and a library holds more than one format.

What that removes from the runtime image is 29 packages and ~34MB: ImageMagick, poppler, OpenEXR, HDF5, NSS, cfitsio and matio, none of which the app ever reached, plus libheif and a second AV1 implementation behind it. What it costs is close to nothing, because the shape of the work suits an ordinary decoder:

|                          | vs libvips                | CPU    | libvips' CPU |
| ------------------------ | ------------------------- | ------ | ------------ |
| decode to 800px          | mean 0.25 of 255, worst 4 | 38ms   | 32ms         |
| decode to 1280px         | mean 0.26, worst 7        | 38ms   | 34ms         |
| decode whole (6000x4000) | mean 0.02, worst 4        | 230ms  | 303ms        |
| encode 1280x853 at q92   | byte-for-byte within 0.2% | 10.0ms | 6.7ms        |
| encode 6000x4000 at q92  | same                      | 197ms  | 70ms         |

Single-threaded against a libvips that spread over the machine, which is why the whole-frame decode wins on CPU and loses on wall time. Neither end of that is on a hot path: every production decode is a shrink-on-load to the fit grid or a tile, where the two are a wash, and the full-size encode happens once per manual download - behind an AVIF decode that costs more than it does. Only the `matched` grade pin moved, worst 0.055% of peak.

**`jpeg-decoder` rather than the faster `zune-jpeg`, because DCT scaling matters more than throughput here.** libjpeg can scale by 1/2, 1/4 or 1/8 during the transform, and a 61MP body embeds a _full-resolution_ preview - 9504x6336 - that a grid tile needs at 800px, so decoding it whole spends ~250-540ms producing pixels 99% of which are discarded. `Decoder::scale` is the pure-Rust exposure of that, and `zune-jpeg`, quicker on a whole frame, has no equivalent. Full chroma on the encode, no subsampling, which is where libvips also landed above quality 90 and where every caller here sits.

**One decoder on both hosts.** Separate server/browser decoders would repeat the divergence addressed by `image::resize`. The page fetches the RAW and runs `edit::fit`, reading its preview through this module compiled to wasm, never a JavaScript JPEG decoder (§21).

### 10.5 Lossless export

`POST /api/photos/:id/lossless` renders one photo at the largest size AVIF can decode into a file kept beside the renditions. It exists because a 3840px rendition is not what you check focus or gradients on, and it is opt-in per photo because it takes real time to build. It stays at native resolution when that fits AVIF's edge and area limits; larger pictures are reduced proportionally before the grade. The file is the cache: a second request finds it already there, and `PhotoDetail.renditions.max.built` is a `stat` rather than a column, so it cannot disagree with the disk.

It follows the library's HDR setting. Firefox rewraps it as video at rendition size, without encoding (§10.7).

**Format.** This was JPEG XL, and the swap to AVIF cost bit depth to buy simplicity. JXL keeps 16 bits where AVIF tops out at 10 here, and at matched quality the files are comparable: 3.42 MB against 2.97 MB on a 24MP frame, 0.34s against 0.48s. What decided it was delivery. No browser decodes JXL without a 1.6 MB wasm module, and the transcode that module needs to hand an `<img>` something it accepts cost more than the entire encode:

|                         | build               | decode | total      |
| ----------------------- | ------------------- | ------ | ---------- |
| AVIF, native everywhere | ,                   | 136 ms | **136 ms** |
| JXL, native (flag)      | ,                   | 619 ms | 619 ms     |
| JXL, wasm polyfill      | 5.2 s PNG transcode | 518 ms | **7.5 s**  |

The polyfill's cost was almost entirely the PNG it had to produce: a 121 MB 16-bit intermediate, deflated with dynamic Huffman to save 18% on a buffer that never leaves the tab. A stored-deflate PNG would have cut that to 805 ms, but `jxl-oxide-wasm` exposes no raw framebuffer; only `encodeToPng()`; so there was nothing to hand a faster writer. Deleting the format deleted the problem, along with the wasm, the cICP splicing and the ICC sniffing.

`max_rendition_quality` is perceived quality, 0-100 and higher is better, set tight rather than "visually lossless" and kept inside a ~20MB budget on a 60MP frame. It is one number for both dynamic ranges because `processing/quality.ts` holds the two curves: 8-bit 4:4:4 and 12-bit PQ do not reach the same picture at the same quantizer, and which quantizer each needs is the mapping's business rather than the reader's (§10.1).

#### 10.5.1 Export

`POST /api/export` produces a one-off file from seven dialog choices, unlike an app-defined cached rendition. Render into a scratch directory, read the output, then remove the directory; keep no export file.

**Every setting comes from the request rather than the library**: the size, the perceived quality, whether the edits apply, whether the decode halves, the dynamic range, the container. Only the grade stays the library's, because that is what the photograph _looks like_ rather than how it is written.

**One photograph per request; the client loops over selections.** Bulk Export opens the same dialog over a `PhotoTarget`, resolved by `POST /api/photos/ids`. Other bulk routes resolve targets internally; export returns ids because only the client knows each file's destination. A server zip cannot replace these three paths.

|                 | Where it writes                            | Picked with                                  |
| --------------- | ------------------------------------------ | -------------------------------------------- |
| Desktop shell   | A folder, straight from the shell's Rust   | `rfd`, the crate `tauri-plugin-dialog` wraps |
| Chromium        | A directory handle the page writes through | `showDirectoryPicker`                        |
| Firefox, Safari | The downloads folder, a file at a time     | Nothing to pick                              |

**Starting closes the dialog and queues the run.** The library stays usable while the sidebar shows "Exporting N photos" and progress. The Exports page lists active and queued runs above history. Run serially: concurrent decodes slow both. Cancelling an active run stops after its current file; cancelling a queued run drops it entirely.

**A queued run is listed as the rows it is about to become**, through the same row component and from the same joins: `POST /api/exports/queued` answers the ids with the photograph's path, its library and shoot, and the develop settings the file will carry where the run was asked to take them. So a reader checking what is in the queue asks what they ask of the history and gets it in the same shape - a run of one is the photograph, a run of several is a line that opens onto them - with the destination the one field missing, because nothing has written anywhere yet. The picture beside a waiting row is the **grid tile**, which is the photograph as the library draws it and the picture the reader picked it by; a written row keeps the export's own render (§10.5.2). Best effort: a describe that fails costs the run its rows and not its files. The picker is still answered inside the click, since `showDirectoryPicker` needs that transient activation, so the dialog stands until a folder is chosen and a reader who dismissed it keeps the settings they filled in.

**The shell fetches and writes the render itself** (`src-tauri/src/export.rs`) rather than letting the page fetch it and hand it to a writer command. A command's _arguments_ are JSON, so the page-to-shell leg of that alternative would put a 60MP TIFF through as an array of decimal numbers. `tauri-plugin-dialog` is not what opens the picker for the same reason nothing else here is a plugin: it takes `tauri` from crates.io where this build takes it from git, and cargo does not unify two sources - so it is `rfd` directly, which is what the plugin is.

**Neither folder is written over.** A name already in the destination is numbered rather than truncated, checked against the folder rather than tracked across the run, so a second export into the same place is safe too. Two bodies both number their frames from one, so a selection spanning cameras holds `DSC02981` twice, and an export is a reader's own files - the one place a silent overwrite cannot be undone.

**No zip anywhere.** A reader who asked for JPEGs wants JPEGs, and on the two browsers with no picker a zip would be a second thing to undo before they have them.

**What each container can carry is a table rather than a rule restated per caller** (`schemas/export.ts`). `honoured()` returns the options as the picked format can actually meet them, and both the dialog - which greys a control out - and the route - which must not trust that it did - ask it. HDR is whether the format can _signal_ high dynamic range that a viewer honours, which is not the same question as bit depth: TIFF stores 16-bit and 32-bit float and has no signalling anything reads, where PNG earned its yes in the Third Edition, whose `cICP` chunk states BT.2100 PQ in four bytes.

**Half-size decode is asked for rather than inferred.** The decode already halves on its own where the caller's size floor allows it, which is right for a rendition - that is a size request and halving is an optimisation inside it. An export is not: a reader ticking the box has chosen the trade, and on a frame small enough that the floor would never have triggered, inferring it would silently ignore them. So `Job.half_size` crosses to `decode_rawler::into_frame`, where it joins the floor in one condition; the even-crop requirement still refuses, since an odd origin puts the colours in a halved frame one site over.

**A gain map export is a second render, not a tone map of the first.** The SDR arm is the same grade with its peak at diffuse white - what `gpu::Output::mastered` gives every SDR rendition - so the base a viewer without gain map support sees is the picture this app would have served it anyway. For whole-frame targets of one size, `job::run` uploads the frame once and pays a dispatch for the second; large single pictures render windows at that size. `avifRGBImageComputeGainMap` derives the per-pixel ratio and the ISO 21496-1 metadata; reimplementing that here would be a second answer to a specification the _reader_ half already takes from libavif, and the two would drift.

**The base is the SDR picture and the alternate is the HDR one, which is the opposite way round from the renditions** (§10.7). An export asking for a gain map has asked for compatibility: the file is going somewhere unknown, so what a viewer that ignores the map sees has to be a correct ordinary photograph. A rendition is served to a browser this app can detect, where keeping the PQ base means nothing that already works regresses - and where `avif-hdr-video`'s Firefox rewrap reads the primary item, so an SDR base would pin Firefox at 8 bits down a path no gain map can ever reach.

The map is written at the base's own size rather than the conventional half. Measured on the `/hdr` scenes, the gain lives on 2.4-2.6% of pixels and all of it on highlight edges, so halving smears exactly the content the map exists for: a full-resolution map reconstructs the SDR arm at 54-64 dB against 40-52 dB for a half-resolution one, for 8-31kB on a 1200px frame.

**A JPEG carries the same map, and states its terms twice.** Two whole JPEGs concatenated: an ordinary baseline primary that any decoder since 1992 shows, and the map appended past its `EOI`, which a decoder that has never heard of any of this stops before reaching. MPF - the multi-picture index in an `APP2` segment, whose offsets are counted from the byte after its own `MPF\0` tag - is what binds them. ISO 21496-1 is what Apple and Android 15 read and rides with the map, the primary carrying only the two version words that say the standard is in the file; Google's `hdrgm:` XMP is what everything older reads, and what the sharing pipelines that never moved still parse. Writing one and not the other renders flat somewhere the file is likely to be sent. This map is single channel where the AVIF's is three, for the same reason its base is eight-bit: the format is picked when the destination is unknown, and one channel is what every reader of either spelling handles.

That placement is also a reader bug this fixed. `jpeg_gain::terms_of` read the primary's segments and stopped, which finds the version-only stub and parses nothing - so a libultrahdr-written file fell through to Apple's maker note and then to no map at all.

**JPEG XL is the fifth container, and libjxl is pinned like libavif.** The distributions ship 0.7, which predates the encoder API settling in 0.10 and whose defaults produce a visibly different file from the same request; an export is bytes a reader keeps, so which machine wrote them must not be visible in them. `bun run get:codecs` builds it statically with highway, brotli and lcms2 under it (§23.7), and `build.rs` refuses naming that command rather than falling back. What JXL adds over the other four is that its distance parameter reaches zero, so the top of the quality scale is mathematically lossless rather than nearly so - `uses_original_profile` follows it, since coding the samples as they arrived is what lossless needs and what makes every lossy file several times larger for nothing. No gain map arm yet: libjxl 0.11 has the metadata box but the second image is still ours to assemble.

**Every rendition and every export carries the camera's EXIF, less anything that names somebody or somewhere** (`exif.rs`). The camera, the lens, the exposure and the capture time go; the artist, copyright, owner, serials, GPS, comments and maker note do not, and neither do the orientation and the colour space, which describe the camera's picture rather than this one. It is an allow-list written fresh, where the bug report's scrub (§18.8.1) is a deny-list over a file it must not move a byte of: a tag reaches a rendition only because an `exif::Group` names it. The block is built once per job from the RAW's decoder, a finished picture's own EXIF, or a composite's first frame, and written into every AVIF the job encodes; the other four containers are transcodes of that AVIF and carry its block across - a JPEG's `APP1`, a PNG's `eXIf`, a JXL `Exif` box, and a TIFF's own IFD0 and Exif IFD. Which groups a file carries is a list (`exif::NON_IDENTIFYING` today), so a choice offered in the export dialog is a list the job is handed.

**Encoding.** Both go through libavif in this process (§10.1, §10.7); the resize is `image::resize` (§10.4). Both start from the same 16-bit scene-linear decode, the export included: an 8-bit decode was kept for the SDR one on the grounds that the encode is 8-bit whatever goes in, and it turned out to cost the _job_ more memory rather than less, having never been given the fit-during-decode the linear path has (§10.3). Nothing leaves the process to be encoded any more.

A WebGPU canvas carries this, where a 2D or WebGL2 one could not: neither of those accepts a `rec2100-*` colour space, only `srgb` and `display-p3`, and `configureHighDynamicRange` is absent. `rgba16float` with `colorSpace: display-p3` and `toneMapping: { mode: 'extended' }` is the surface the editor already opens (§7), and the viewer draws onto the same one (§19.6) - so a value above diffuse white reaches the panel rather than being mapped back down to it.

**The frame is decoded here rather than imported.** Every way of handing an encoded picture to WebGPU converts it into the colour space asked for, and the only ones on offer are SDR: measured on a real PQ render, sampling it through `importExternalTexture` peaks at 0.81 and copying it through `copyExternalImageToTexture` into a float16 texture peaks at 0.71, and _neither has a single sample above one_. The headroom is gone before any shader sees it. So a PQ frame's ten-bit planes are taken off `VideoFrame.copyTo` as they are and `stage_gpu.ts` does the work the import would otherwise have done wrong - limited-range BT.2020 YUV to RGB, the PQ curve to nits, nits against BT.2408's 203, and the primaries onto the canvas's - which is the shape `frame.slang` has always had, that path never importing a picture either.

On the wasm path HDR signalling rides on a PNG **cICP** chunk (9/16/0/1 = BT.2020 + PQ), inserted after IHDR without touching IDAT; on the native path the tagging already inside the JXL does the same job. Chrome honours both identically: a flat 50% grey reads 128 untagged and 131 tagged, the same shift through the cICP PNG and through a PQ-tagged JXL. A neutral patch is what isolates this, since a primaries change is identity on the achromatic axis and an earlier test against a coloured gradient could not tell colour management from encoder noise. The PNG tag is applied only when the decoded ICC profile actually declares PQ or HLG, since tagging an SDR image would stretch it into HDR range.

**Firefox ignores HDR image tagging entirely**; that same grey reads 128 both tagged and untagged, through cICP PNG and through native JXL alike. Two ways to borrow the HDR video pipeline instead, and 153/Windows closes both, separately - measured against an actual HDR display, which earlier notes here could not be.

**A live track has nowhere to go.** `VideoTrackGenerator`, `MediaStreamTrackGenerator` and `MediaStreamTrackProcessor` are all absent, in window scope and in a worker alike, so there is nowhere to put a `VideoFrame` even after building one. Not a depth problem: the path is closed by construction.

**An encoded file has nothing to carry.** That route needs no sink - encode, mux, blob, `<video src>` - and `VideoEncoder` does exist. But `VideoFrame` takes only `I420`, `NV12`, `RGBA` and `RGBX`: every 10-bit format is rejected (`I420P10 is unsupported`), 4:4:4 with them, and `P010` is not in the enum at all. So the encoder can only ever be fed 8 bits, which is the same 8-bit ladder the pack dithers for, and it would cost an AV1 encode per slider tick to find out whether Gecko routes the result to the compositor. Canvas is no way round either, since `display-p3` silently resolves back to `srgb` and `rec2100-pq` is not in `PredefinedColorSpace`.

That machine reports `(dynamic-range: high)` **false** and `(video-dynamic-range: high)` **true**, which is the whole situation in two media queries: Gecko composites HDR for video and only video (bug 1889288), so the sole thing that reaches the panel is a video file its own pipeline decoded - which is why the viewer rewraps the stored AVIF as one rather than encoding anything (§10.7). A PQ-tagged AV1 shows the same flat-grey value as a BT.709-tagged one, so the tag buys nothing beyond that.

The default for newly indexed photos is the library's `rendition_source` (§10.1). Changing it is deliberately not retroactive: rebuilding an existing catalogue is a job the user asks for explicitly, not something a preference does to thousands of files in the background. `POST /api/photos/:id/renditions/:r?force=true` is that explicit request, one photo at a time, from the viewer that is showing it - there is no bulk re-render, because a selection's worth of RAW renders is minutes of work for pixels nobody has asked to look at.

#### 10.5.2 Where the files went

An export leaves the app entirely, so the only record of one is a row in `exports`: one per photograph, grouped by the run id the client mints, written by the render and completed by the client (below). `GET /api/exports` is what the Exports page lists, newest run first. `DELETE /api/exports/:id` drops one row and `DELETE /api/exports/runs/:runId` drops a whole run - which is what the page offers over a selection's export, that being one row there. Neither touches a file, the files being the reader's.

**The client supplies the destination:** shell path, directory-handle folder and filename, or downloads filename. That finishes the row. Failure to record history must not report a failed export: the file is already on disk, and retrying would duplicate it.

**Every column is a copy taken at the time**, including the develop settings the render carried. A row that read the photograph's _current_ edits would answer the one question this page exists for wrongly: exporting, moving a slider and exporting again lists two files, and what each was written with is what tells them apart. The `edits` column follows the request's own `includeEdits`, so an export that deliberately left them out records none rather than the ones it ignored.

**No photograph foreign key.** Export history must survive removal of its RAW from the catalogue.

**Left-join the photograph's current library and shoot.** These describe its location, not exported contents. Later moves update the links; absent photographs are labelled instead of linked.

**`export_history_limit` (1000) is where the history stops**, and the cull takes _whole runs_, oldest first, after each record. Counted in files the cut would land inside whichever run straddles it, and half a run listed as "Exported 40 photos" over the twelve that survived is a worse history than one that stops earlier - so the limit is a floor rather than a ceiling, and the newest run is never culled however large it is. The picture is a column rather than a file, so the row leaving takes its thumbnail with it and the orphan sweep has nothing to find.

**The tile beside a row is the export again, small - and it is a second target of the same render**, not a second render and not a downscale of the finished file. `renderExport` writes the export and a 400px SDR AVIF from one decode, the way the grid tile and the full rendition are built together, so the tile costs a dispatch and a small encode. Downscaling the encoded export instead would be wrong on the path that matters most here: an HDR export is a PQ frame, and reading one back as if it were sRGB gives a flat, dark tile. A picture of the _photograph_ rather than of the export would be wrong too - a black and white crop listed under the colour frame it came from is not what anybody exported.

It is a blob on the row rather than a file for the same reason there is no foreign key: the row owns it, so a delete takes it rather than leaving something for the orphan sweep, and `GET /image/exports/:id` serves it immutable.

**So the row is written by the render and finished by the client.** `POST /api/export` takes the run id, writes the row with the tile, and answers with the file; `POST /api/exports/landed` names the run and the photograph and says where the file went. Until it does the row has no destination and is not listed - and if it never comes, because the write failed or the reader stopped the run, the cull sweeps it after an hour. The alternative was sending the tile out to the client so it could hand it straight back, which is a picture crossing the wire twice to tell the server something it already knew.

### 10.6 Orphaned files

Generated files are named `<photoId>.<ext>`, and photo ids are minted per insert, so a catalogue rebuilt over the same folder gives every file a new id and strands the old ones. Nothing in the normal write path notices: processing rewrites renditions in place, and the only unlink is a failed job cleaning up its own partial output.

Two things close that off:

- **Removing a library removes its data directory**, `<DATA_DIR>/<library id>` (§6). Re-adding the same folder can never reuse the renditions (new ids), so keeping them is dead weight. The RAW files are not ours and are left alone: the directory is outside every library root, and the Bin is beside the photographs (§12.3). The removal still refuses outright while anything under there looks like an original - not as a trigger for a rescue, but because `rm -rf` is the one call here that cannot be undone and an original under there means the directory is not what it is believed to be.
- **A scheduled sweep** (`PRUNE_EVERY_DAYS`, default 7, 0 disables) walks each generated directory and deletes any file whose id has no row. The directories and the extension each is supposed to hold both come from the path helpers that write the files, so changing an output format cannot leave the sweep looking in the wrong place. A file whose extension no longer matches goes too, even when its photo is alive: a format change writes the new render beside the old one rather than over it, which the PNG-to-JXL switch made real at ~100 MB per photo ever opened. That rule is also what empties a **retired directory** - one nothing writes to any more, listed by `retiredRenditionDirs()` and swept alongside the live ones, where every file is by definition the wrong extension. `<rendition>-hdr-video` is the one there is: an MP4 per HDR photo for Firefox, which the browser now makes for itself (§10.7). The directory is `rmdir`'d once it comes up empty, and a file that would not go keeps it until a later sweep. Only `renditions/` and `hdr/` are swept, so a stray the user left is untouched (and the Bin is not in the data directory at all). Ids are checked against the whole `photos` table, not one library's, because the id space is global. Soft-deleted rows count as live, since their renditions are what make the Bin browsable (§12.1).

**Merge working layers have no photo row.** `drafts/<layerKey>/` holds session-keyed assembly analysis
planes while the page is open, so the orphan sweep's `live` check cannot apply. `PruneService` separately
removes `drafts/*` older than seven days by mtime; draft ownership is a TTL.

### 10.6.1 One place that deletes

All disk removals go through `src/utils/deletions.ts`. `no-restricted-imports` in `.oxlintrc.json` bans `rm`/`unlink`/`rmdir` and sync forms from `node:fs` elsewhere except tests. Central guards prevent path refactors from confusing disposable renditions with irreplaceable RAWs.

Each entry point states what it will not do:

|                                              | Guard                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deleteGeneratedFile(dataPath, target)`      | Target must resolve under `<dataPath>/renditions`, `<dataPath>/hdr` or `<dataPath>/drafts`, and must not carry a supported RAW extension. `dataPath` comes from the caller's own library, so a path from elsewhere cannot satisfy it.            |
| `deleteGeneratedDirectory(dataPath, target)` | Same containment test, and `rmdir` rather than a recursive remove: a directory still holding a file it would not delete keeps it until a later sweep.                                                                                            |
| `deleteGeneratedTree(dataPath, target)`      | Same containment test, and `rm` recursively - the one generated tree removed as a unit, for a draft's several layers at once rather than one file at a time.                                                                                     |
| `deleteDataDirectory(dataPath)`              | Refuses while any supported file exists anywhere beneath, symlinks excluded.                                                                                                                                                                     |
| `deleteEmptyBinFolder(library, target)`      | Target must be exactly this library's bin (§12.3), and `rmdir` again, so anything at all inside it stops the removal. Runs on the error path of a library create, where what it is about to delete is a directory the app believes it just made. |
| `unlinkMovedFile(from, movedTo)`             | Removes the source half of a move only once the destination exists, so a failed link or copy can never leave the move having consumed the file.                                                                                                  |

Sweep on an interval, not startup: restarts imply no orphaning and development reloads would repeat the work.

### 10.6.2 The disk space limit

`disk_space_limit_gb` (default 200, and 50 in the mobile app, whose shell starts the server with
`BOWERBIRD_DEFAULT_SETTINGS`) caps everything the disk usage row measures (`StorageUsageService`):
the data directory, the catalogue and its backups, printer profiles and caches. Only renditions are
deleted to meet it. `DiskSpaceLimit` checks at startup, hourly and whenever the limit changes; over it,
it evicts renditions least recently used first. `renditions.used_at` is set by a build and by a serve
of anything but a grid tile (at most once a minute per copy), and is null where no copy is on disk.

Grid tiles are never evicted: nothing stamps them on a scroll, so by build time they would go first and
be repaired on every pass. An evicted copy keeps its `built_at`/`built_from`: clearing them would have
`queueEditedSince` re-render every evicted copy of an edited photo, refilling the disk. Readers already
treat a missing file as not built (`renditionsOf`), so the viewer rebuilds it on the next open. A file
that will not delete keeps its `used_at` and is retried on the next pass.
