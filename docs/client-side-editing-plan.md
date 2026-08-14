# Client-side editing: what to build

Investigation is not finished; this is the list as it stands, so nothing measured gets
forgotten. Numbers are a 61MP ARW (9504x6336) on a Radeon 780M iGPU unless stated, from
`native/rawshim/examples/open_bench.rs`.

**Two things want settling before any of it is built**, and neither is about the client:

1. The interior discrepancy under "Open" below. A region denoised alone is not the frame denoised
   whole, by more than a seam is, and the loupe already rests on the assumption that it is. That
   is a correctness question about what ships today, and tiling anything makes it wider.
2. Whether the CPU stages move to the GPU *first*. They are 73% of the open, they are needed
   whether or not the client ever opens a RAW, and going to wasm before they move means
   single-threading 5.9s of work that should not be on a CPU at all.

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
- [x] **The halo is two constants, 32 and 64** (`RENDITION_TILE_HALO`, `EDITOR_TILE_HALO`), chosen
      at the call site. 64 is where a tiled denoise is bit-identical to the frame denoised whole;
      32 is where the seam stops being measurable. A rendition is kept and looked at later, so it
      takes the exact one - and so does the loupe, whose whole purpose is to predict a rendition.
      Nothing in production moves today: the loupe is the only thing that tiles, and it was
      already on 64. What 32 is for is the editor's own tiling, below.
- [ ] **Pick the tile size from this, not the halo.** The halo is settled; what is not is how big
      an editor tile should be. Over a 61MP frame, as the area actually put through the denoise
      with the wall clock beside it, against 5311ms for the frame whole:

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
