# Client-side editing: what to build

Investigation is not finished; this is the list as it stands, so nothing measured gets
forgotten. Numbers are a 61MP ARW (9504x6336) on a Radeon 780M iGPU unless stated, from
`native/rawshim/examples/open_bench.rs`.

**Order, decided.** The CPU stages move to the GPU first, because parity is checkable there: the
WGSL is held against the CPU it replaces by fixtures that already exist, where a wasm port is a
second thing to trust at the same time. Then the client move, single-threaded - no
`wasm-bindgen-rayon`, no `SharedArrayBuffer`, no cross-origin isolation, none of it until
something measured says the 582ms is the problem.

## The move

- [ ] **Send the RAW, not the prepared frame.** 72MB against 361MB (5.0x; 5.8x at 24MP), and
      the RAW is immutable per photograph where `/prepared` is `no-store` and rebuilt on every
      open.
- [ ] **The client does the open.** rawler decode and `condition` in wasm; everything after it
      on the page's own WebGPU device, where the shaders already are.

## What blocks that

- [ ] **The wasm build**, which is two things and not more: `uuid` needs its `js` feature, and
      `gpu.rs`'s `static GPU` is `!Send + !Sync` under wgpu's WebGPU backend (`pollster::block_on`
      cannot block a browser thread either). Everything else, rawler included, already compiles
      for `wasm32-unknown-unknown`.
- [x] **Threads: single, and no wasm threading is to be built.** The part in question is purely
      the entropy decode and bit-unpack into the sensor's `u16` grid - `raw_image`, rayon-parallel
      inside rawler (Sony's lossless is tiled in two dimensions). At 61MP it is 92ms on twelve
      cores and 389ms on one, 4.2x; `condition` is 26ms against 193ms, 7.4x. So 582ms once per
      photograph, and a third of that is `condition`, which becomes a kernel anyway. Not worth
      `SharedArrayBuffer` and the cross-origin isolation the whole page would carry for it.
      `wasm-bindgen-rayon` stays available if something measured later says otherwise.
- [ ] **Serve the stored camera match.** `camera_match_store.ts` holds it; nothing exposes it. The
      client needs the 5KB blob to skip a 600-700ms fit.
- [ ] **Make the RAW cacheable.** `image_api.ts`'s `download()` sends `Cache-Control: no-cache`.

## Memory, if the RAW is decoded in a tab

- [ ] **Fork rawler to yield strips** rather than a whole `RawImage`. The open peaks over a
      gigabyte today; streaming strips straight into VRAM leaves the file plus one strip, so tens
      of megabytes against wasm32's 4GB address space.
- [ ] **`condition` as a kernel.** Per-sample over four black levels and four gains, so the upload
      becomes packed `u16` and the mosaic plane halves: 120MB rather than 241MB.

## Move the open onto the GPU

73% of the open is CPU work with a GPU sibling already in the tree. This has to happen whether or
not the client does the open, and it has to happen *before* wasm runs any of it single-threaded.

**The prize is the transfers, not the stages.** RCD leaves the frame in VRAM and reads it back;
the grade uploads it again. At 61MP that is 361MB each way to run pointwise arithmetic on a CPU.
So a stage is worth moving even where the stage itself is cheap, and the last one to move is
worth more than its own timing.

- [x] **the coding** (`2743056`). Within a count of the CPU over every level a sample can hold.
- [x] **defringe** (`7f02072`). Composing it with `recombine` leaves one add per channel; the
      1170ms was the planar split, the strips and the interleave, none of which a shader needs.
- [x] **noise measure** (`8ecfd9a`). Within 0.2% relative; the quantiles stay on the CPU, where
      they run over ~941k block sigmas rather than pixels.
- [x] **lens warp** (`fcd4577`). Within 2 counts, mean 0.167. Uploads the ratio table rather than
      evaluating the spline, because the CPU gather reads that table and its 4096 buckets are part
      of the answer a rendition already committed to.
- [ ] **levels quantile, 158ms.** Parked: the sampling index is `k * pixels / counted`, 52 bits at
      61MP, and WGSL has no u64. Soluble with a split product, but it would also cost the exact
      integer parity that made this one attractive, for the smallest stage on the list.

**Ported is not wired, and wired is not faster.** `apply_lens` takes the GPU now (`7b39847`, 277
fixture tests green with the pinned renders unmoved) and it is **588-610ms against the CPU's
639ms** - no faster, because a stage on its own uploads 361MB and reads it back, which is what the
CPU never had to do. The stage timings were never the prize; the transfers are. Until the stages
share one buffer this whole section buys correctness and nothing else.

- [x] **Chain them over one resident frame** (`442112a`). `base::prepare` uploads once, records
      encode -> defringe -> warp into one encoder and reads back once: six transfers become two.
      Pinned bit-identical against the three called in sequence, which is the right bound here -
      the same shaders on the same data, so any difference would be plumbing rather than tolerance.
- [x] **`measure_defocus` on the GPU** (`dc77d63`), which was the gate: `prepare` takes the pair as
      an input and the CPU measured it from the *coded* frame, so a caller had to code, read back,
      measure and upload again. Within 0.5% relative.
- [ ] **Find out why the chain makes the next CPU stage eight times slower.** This is the blocker,
      and it is measured rather than suspected. Wired into `edit::open`, `prepare` runs the coding,
      the defringe and the warp in **1097ms** against the CPU's 1706ms, with all 279 fixture tests
      green and the pinned renders unmoved - and `noise::measure` after it goes from **983ms to
      7910ms**. It is not the GPU noise port: the *CPU* measure shows the same 7910ms behind the
      chain, and both return to 983ms when the chain is removed. It is not the machine: 23GB free.
      A 61MP open is 11.5s chained against 5.5s unchained, so the call site is reverted and
      `prepare` sits tested and unused until this is understood.

      The guess, written down as one: a chained open holds three 361MB buffers - the frame, its
      warped copy, the readback - and wgpu reclaims on a later poll rather than on drop, so the
      CPU's own 241MB plane is allocated against a process that has not given them back yet.
- [x] **The noise measure is wired** (`e19350f`), being the one stage that pays an upload and no
      readback. Correct - the fixture suite passes with it live - and **not faster**: 987ms against
      958ms.
- [ ] **Give the block reduction a median that is not a selection sort.** That is where the noise
      measure's time goes, and the transfer is not: at 61MP the frame is 1188 x 792 blocks, each
      taking the CPU's exact order statistic by partial selection - 48 passes over 96 laps, twice
      over, so about 8.7 billion comparisons, every one of them indexing a private array
      dynamically and spilling to scratch. A bitonic pass over 96, or a histogram, held to the
      same order statistic.
- [ ] ~~**sharpen, 2926ms**~~ - **skip it entirely.** A GPU sharpener is replacing it, so its
      parity, its performance and the round trip through system memory it currently forces are all
      about to stop existing. Do not design the residency around it: reading back before it and
      uploading after is fine in the meantime, because both go when it does.

## Tiling

- [x] **Keep the inverse-GAT table** (`40def3d`). The 395ms per-call fixed cost is gone; a denoise
      is now 85-91ms/MP flat from 0.04MP to 60MP.
- [x] **The whole decode tiles at 2048, renders included** (`decode_rawler::denoise_in_tiles`,
      `demosaic_in_tiles`). A render is now assembled from the same regions at the same halo as
      the loupe that predicts it, rather than two routes that ought to agree. Output is unchanged
      - the 266-test fixture suite passes with the pinned renders untouched, same decode checksum
      - and it is *faster*: 1068ms against 1385ms at 61MP, 56.4 MP/s against 43.5, because 3.1GB
      of RCD planes costs an integrated GPU more than a halo saves. It also bounds the GPU, which
      is what makes a 61MP open viable on a phone or in a tab.

      One trap, found by the fixtures: the halo has to be grown in the **sensor's** coordinates
      and clamped to the sensor, not to the crop. The crop is inset from the readable area, so
      there is real mosaic outside it and the whole-frame demosaic read it. Clamping to the crop
      border-fills the frame's own edge - it moved the first six samples of a pinned render and
      nothing else in the row.
- [ ] **Tile GALOSH finer for progress, not for throughput.** A stage-sized region is 423ms
      against 5286ms for the frame, so a whole-image slider can show the picture arriving in
      pieces. That is a latency-against-throughput call and separate from the decode's own tiling
      above, which is sized for memory and parity.
- [x] **The halo is two constants, 32 and 64** (`RENDITION_TILE_HALO`, `EDITOR_TILE_HALO`), chosen
      at the call site. 64 is where a tiled denoise is bit-identical to the frame denoised whole;
      32 is where the seam stops being measurable. A rendition is kept and looked at later, so it
      takes the exact one - and so does the loupe, whose whole purpose is to predict a rendition.
      Nothing in production moves today: the loupe is the only thing that tiles, and it was
      already on 64. What 32 is for is the editor's own tiling, below.
- [x] **The tile is 2048** (`decode_rawler::RENDER_TILE`), which is where the halo stops mattering.
      Over a 61MP frame, as the area actually put through the denoise with the wall clock beside
      it, against 5311ms for the frame whole:

      | tile | halo 16 | halo 32 | halo 64 |
      |------|---------|---------|---------|
      | 512  | 1.12x, 6148ms | 1.26x, 6761ms | 1.54x, 8113ms |
      | 1024 | 1.06x, 5595ms | 1.12x, 5868ms | 1.26x, 6619ms |
      | 2048 | 1.03x, 5396ms | 1.06x, 5526ms | 1.12x, 5816ms |

      The clock tracks the area to within a percent or two, so tiling costs area and nothing else
      now the per-call floor is gone. **The tile size decides what the halo costs**: the whole
      16-to-64 range is 9% at 2048 and 37% at 512. 2048 at halo 32 costs 1.06x, which is cheaper
      than 512 at *any* halo - so the only reason to go smaller is finer progressive updates, and
      that is a latency-against-throughput call rather than a quality one.

      The evidence behind the halo itself is in `examples/halo_seams.rs` and
      `examples/halo_pattern.rs`, and in `29f8200`, `4287c03`, `1697656`, `df9f86a`.
- [ ] **`pass12`** is now 82% of GALOSH (4326ms of 5286). The next real optimisation, and unlike
      the table it is genuine per-pixel work.

## Found while measuring the halo

- [x] **~~A region denoised on its own differs from the whole frame~~ - answered by `db0e726`.**
      This sat here as "about 1.15 of 255 in the interior, not the halo, not the decode, not
      `Fit::Given` against `Fit::Measure`, cause unknown". It was five stages reasoning about "the
      frame" when the frame was a crop, and that commit enumerates them with the mean difference
      each was worth, in counts of 65535: the levels everything is coded and graded against 9333,
      the scene peak the roll-off rolls into 1343, the sharpen never run on a tile at all 213, the
      lens applied at the crop's radius 153, the blur the presence sliders read 27.

      Three are numbers the editor already holds and a crop cannot measure, so they travel with
      the request beside the noise fit; two are the shape of the tile itself.
      `a_tile_is_graded_as_the_rendition_is` now asserts equality rather than closeness, and it
      passes with the render assembled from tiles.

- [ ] **Tile the loupe's own decode too.** `decode_rawler::decode_tile` still does its region in
      one pass, so it does not use the 2048 tiling the whole-frame path got. That was harmless
      while a loupe window was the glass; `db0e726` grows it by the reach of everything after the
      gather - 42px for the deconvolution, ~216px for the guided filter - and measured 4x the
      decode with a presence slider off zero. A window that large wants the same bound on the GPU
      as a frame does, for the same reason. Additive, not a correctness problem.

## Falls out of the above

- [ ] **Loupe tiles become local**, so no server round trip per pointer move. They are already 12x
      faster from the kept table: 425ms to 35ms per tile.
- [ ] **The colour Detail slider becomes interactive.** The two sliders enter the chain at one
      dispatch each; everything after `smoothstep_blend_3p` is ~140ms of the 5.7s, so keeping the
      run before it makes a colour-only tick full-resolution.
- [ ] **Delete what only exists to cross a wire**: the framing in `edit.rs`, `PreparedHeader`,
      `bb_prepare_edit_*`, `rawshim_edit.ts`, `src-tauri/src/edit.rs`, the `/prepared` route.

## Stale, noticed on the way

- [ ] DESIGN.md still describes LibRaw as the decoder throughout (§ lines 28-30, 37, 52, 58).
- [ ] `raw_edit_presenter.ts` says a matched header is 11KB; it measures 32KB.
