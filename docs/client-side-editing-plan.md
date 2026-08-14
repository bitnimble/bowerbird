# Client-side editing: what to build

Investigation is not finished; this is the list as it stands, so nothing measured gets
forgotten. Numbers are a 61MP ARW (9504x6336) on a Radeon 780M iGPU unless stated, from
`native/rawshim/examples/open_bench.rs`.

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
- [ ] **Decide about threads, and it looks like single-threaded wins.** The part in question is
      purely the entropy decode and bit-unpack into the sensor's `u16` grid - `raw_image`, which
      is rayon-parallel inside rawler (Sony's lossless is tiled in two dimensions). At 61MP it is
      92ms on twelve cores and **389ms on one**, 4.2x; `condition` is 26ms against 193ms, 7.4x.
      So the whole irreducibly-CPU half is 582ms single-threaded, and `condition` is a third of
      that and is already on the list to become a kernel. Against that, `SharedArrayBuffer` and
      the cross-origin isolation the page would carry for it.
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

- [ ] **sharpen, 2967ms** - 37% of the whole open, the single largest item, and nothing had
      measured it. `image::finish_in_strips` already carries a halo and a one-strip-vs-many test.
- [ ] **code and defringe, 1124ms**
- [ ] **noise measure, 988ms**
- [ ] **lens warp, 650ms** - `geometry.wgsl` already does this gather for the draw
- [ ] **levels quantile, 167ms** - `peak.wgsl` already does a sampled quantile

## Tiling

- [x] **Keep the inverse-GAT table** (`40def3d`). The 395ms per-call fixed cost is gone; a denoise
      is now 85-91ms/MP flat from 0.04MP to 60MP.
- [ ] **Tile RCD at 1024.** 1040ms whole-frame against 467ms, bit-identical over 180,652,032
      samples. Faster because 3.1GB of planes costs more than a 4% halo saves.
- [ ] **Tile GALOSH for progress, not for throughput.** A stage-sized region is 423ms against
      5286ms for the frame, and seventy tiles is 7382ms - so tiling costs about 40% in total work
      (the halo's redundant area) and buys the picture arriving in pieces instead of all at once.
      Worth it for a whole-image slider, where perceived speed is the point; use one rectangle
      wherever the answer is wanted whole.
- [ ] **`TILE_HALO` can be 32, and is worth less than it looks.** `examples/halo_seams.rs` cuts a
      region four ways at each halo against the same region cut as one tile, and measures the join
      as a *line*: each column averaged down the whole region, the two columns straddling the join
      against columns 24-48 out. A maximum cannot tell one hot pixel from a line and a mean over a
      band divides a line by the band's width, so both rank regions wrongly - the first table here
      was built on a maximum and said 16, which is not what the line says.

      The join's excess over its own neighbourhood, of 255: halo 0 is 0.61/0.70 against a 0.13
      baseline, 8 is 0.44/0.57, **16 is 0.12/0.20 against 0.06 - still a line at 2-4x**, and from
      **24** up it is at or under the baseline and stays there to 128.

      **Confirmed against a pattern built to be worse than any photograph**
      (`examples/halo_pattern.rs`): a chroma zone plate on flat luma, random chroma at the
      pyramid's own scale, a luma zone plate and blown speculars, all under fitted
      Poisson-Gaussian noise with the structure held near it - a denoise only has to guess where
      signal and noise are comparable, and a seam is a disagreement about a guess. It reaches 3.8
      of 255 at halo 0 against the worst photograph's 0.70, and **it is at the baseline from 32 in
      every configuration, while 16 is still 5-9x above it**.

      So 32, being past the knee and a multiple of four for the chroma pyramid. Measured over a
      61MP frame, as the area actually put through the denoise and the wall clock beside it:

      | tile | halo 16 | halo 32 | halo 64 |
      |------|---------|---------|---------|
      | 512  | 1.12x, 6148ms | 1.26x, 6761ms | 1.54x, 8113ms |
      | 1024 | 1.06x, 5595ms | 1.12x, 5868ms | 1.26x, 6619ms |
      | 2048 | 1.03x, 5396ms | 1.06x, 5526ms | 1.12x, 5816ms |

      Whole frame is 5311ms, and the wall clock tracks the area to within a percent or two - the
      per-call floor is gone, so tiling costs area and nothing else. **The tile size decides how
      much the halo costs**: at 2048 the whole 16-to-64 range is 9%, at 512 it is 37%. So take the
      halo the seam asks for and buy it back with a larger tile, rather than the other way round.
- [ ] **`pass12`** is now 82% of GALOSH (4326ms of 5286). The next real optimisation, and unlike
      the table it is genuine per-pixel work.

## Open, and found while measuring the halo

- [ ] **A region denoised on its own differs from the whole frame denoised, in its interior, by
      about 1.15 of 255 on a real photograph.** Not the halo - it holds at every halo up to 512,
      and it is as large well away from a seam as at one. Not the decode either: `tile_check` puts
      a tile against the same region of the frame at `mean 0.0 worst 0` with the denoise off. And
      not `Fit::Given` against `Fit::Measure`, which `open_bench` measures at `worst 0e0`.
      Whatever it is, the loupe rests on it - a tile is handed the frame's fit so that it predicts
      the export, and the export denoises the frame whole.

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
