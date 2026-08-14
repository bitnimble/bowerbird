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
- [ ] **Decide about threads.** rawler's decode is 92ms across twelve cores. Single-threaded wasm
      is the alternative to `SharedArrayBuffer` and the cross-origin isolation that was
      deliberately deleted.
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
- [ ] **Do not tile GALOSH into many tiles - run one rectangle.** A stage-sized region is 423ms
      against 5286ms for the frame. Seventy tiles is still 7382ms, and the gap is the halo's
      redundant area, which is inherent to overlapping.
- [ ] **`pass12`** is now 82% of GALOSH (4326ms of 5286). The next real optimisation, and unlike
      the table it is genuine per-pixel work.
- [ ] **Check whether `TILE_HALO = 64` is measured or a safe guess.** It is the whole of GALOSH's
      tiling tax - 1.5x the area at 1024 tiles.

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
