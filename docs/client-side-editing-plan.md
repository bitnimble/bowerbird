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

- [x] **The RAW is what crosses, and the prepared frame is gone** (`b8646f2`, `a549964`). 72MB
      against 361MB, and the RAW is immutable per photograph where `/prepared` was `no-store` and
      rebuilt on every open. The route, `servePrepared`, `rawshim_edit.ts` and the
      `bb_prepare_edit_*` C ABI are deleted; `web/e2e/local_decode.spec.ts` asserts the editor
      never asks for `/prepared`, and that assertion was confirmed red before being trusted.
- [x] **The client does the open** (`b8646f2`). `prepareRaw(bytes, request)` returns `edit::encode`'s
      own framing, byte for byte what `/prepared` served, so the client's parse never changed.

      **The desktop shell has no path of its own**, and the one it had is deleted: the shell runs
      CEF on Linux and Chromium everywhere else, so its webview has WebGPU and there is nothing the
      shell could open that the page cannot. `src-tauri/src/edit.rs`, the `get:prepared` branch and
      the HTTP tile round trip are gone, and the shell proxies everything again. The cost is the
      measured one - a single-threaded webview decode, about +582ms an open - and it buys one
      implementation instead of two. A browser that cannot run the module now has no editor, which
      is the consequence agreed when this was scoped.

      **The decode itself is done and proven in a browser** (`3542685`): `web/e2e/local_decode.spec.ts`
      fetches a real ARW in the tab, decodes it through the wasm module, and asserts the frame -
      both assertions confirmed red before being trusted. `openGpuDevice()` really does return a
      `GPUDevice` in Chromium.

      **wgpu cannot adopt a device from JS.** There is no `from_webgpu` and wgpu-hal has no WebGPU
      backend, so there is no seam to inject one through - only `Device::as_webgpu()` outward. The
      module therefore requests the device and the page borrows *its* one, which is the same
      single-device requirement read the other way round.

      **A browser now runs RCD and GALOSH** (`4b72aaa`). The frame stays on the device across the
      chain and the one readback left is the demosaic's output per tile, so the blocking
      `Device::poll` that WebGPU answers without waiting is no longer in the way: `gpu::device()`
      returns the page's device and the tab walks the *same* `decode_source` a server does, with
      no `#[cfg]` fork.

      **The evidence is the absence of a complaint, which is why each fall-through now makes one.**
      A CPU decode produces a picture too, so no assertion on the frame's shape can tell RCD from
      the PPG it replaced. `eprintln!` is dropped on wasm32 - that std has no stderr - so
      `crate::warn` routes to `console.warn`, and `local_decode.spec.ts` asserts nothing declined.
      GALOSH had no announcement at all before: a frame carrying no fit and no filtering was
      indistinguishable from a filtered one.

      Native, 61MP, quiet box: condition + fit 1022-1072ms to 757-778ms, the whole decode
      2367-2407ms to 1947-2002ms, the open 6947ms to 6225ms. `condition` stopped losing to the CPU
      because it no longer pays a 241MB return trip.

## What blocks that

- [x] **The wasm build**, which was two things and not more: `uuid` needed its `js` feature, and
      `gpu.rs`'s `static GPU` was `!Send + !Sync` under wgpu's WebGPU backend
      (`pollster::block_on` cannot block a browser thread either). Everything else, rawler
      included, already compiled for `wasm32-unknown-unknown`.

      `bun run scripts/cargo.ts build --no-default-features --target wasm32-unknown-unknown
      --manifest-path native/rawshim/Cargo.toml` links a `.wasm` now. `gpu::device` is `None`
      there, because the page owns the `GPUDevice` and this crate's wasm half ends at the fit.
      Only `Gpu`'s own construction is gated, so nothing native moved.
- [x] **A wasm decode runs, not merely compiles** (`a7bfbf1`). Both blockers were found by reading
      `decode_rawler::decode_source` after it compiled, not by a compiler - a decode that links and
      then panics on its first frame is what a build alone can tell you nothing about.

      - **The clock, answered by `clock::Mark`.** `std::time::Instant::now()` panics on
        `wasm32-unknown-unknown`, and four paths read it for `BOWERBIRD_DECODE_PROFILE`'s laps
        before deciding whether anyone asked for them. `Mark` is `Instant` off wasm and a
        stopped clock on it, and `clock::laps` is the one lap closure those four had copied
        between them. `edit`, `galosh`, `demosaic` and `decode_source` all take it, and
        `wasm_build.rs` fails the moment a new one appears - by a source scan rather than a
        compile, since the regression it guards compiles clean on both targets.

        Two more were in rawler itself, which no reading of this crate would have found: the
        CRX decoder (already patched) and **PPG**, which is what the fall-through below runs.

      - **The demosaic's fall-through, routed.** `decode_source` took `gpu::device()?` with RCD
        behind it, so `None` there was no frame at all rather than a worse one. `demosaic::cpu` is
        rawler's PPG - the algorithm RCD replaced, already a dependency - held against RCD by
        `the_cpu_demosaic_reconstructs_what_rcd_does` on the one field both are exact on. It
        **logs when taken**: PPG is a different picture, not a slower one, and a fall-through
        nothing announces is how the chain's 8x regression passed a whole fixture suite.

        `is_bayer` is now shared by both. They refused different things - RCD checked 2x2
        structure, PPG *panics* on what it cannot read - so a sensor the GPU turned away came back
        through the CPU, and which files the product opened depended on whether the host had a GPU.

      **Threads are not a third blocker.** rayon 1.13 detects that the target cannot spawn and
      configures a single-threaded fallback pool, so `par_chunks_mut` runs sequentially rather
      than panicking. Nothing else on the decode path spawns: `ffi.rs` does, but a browser
      reaches `edit::open` rather than the C ABI, and `hdr.rs`'s scope is `renditions`-gated.
- [x] **Threads: single, and no wasm threading is to be built.** The part in question is purely
      the entropy decode and bit-unpack into the sensor's `u16` grid - `raw_image`, rayon-parallel
      inside rawler (Sony's lossless is tiled in two dimensions). At 61MP it is 92ms on twelve
      cores and 389ms on one, 4.2x; `condition` is 26ms against 193ms, 7.4x. So 582ms once per
      photograph, and a third of that is `condition`, which becomes a kernel anyway. Not worth
      `SharedArrayBuffer` and the cross-origin isolation the whole page would carry for it.
      `wasm-bindgen-rayon` stays available if something measured later says otherwise.
- [x] **One thread, but not the page's.** Single-threaded was costed above as 582ms; what it also
      meant, unnoticed, is that the whole open ran where the editor draws. Measured with a
      `longtask` observer over one open: **a single 8377ms task**, from the moment the panel
      mounted to the frame arriving - eight seconds in which nothing renders, no key is heard and
      no pointer moves. `raw_editing.spec.ts` found it first, as a Playwright query that could not
      be answered inside its five seconds and a different editor test failing each run.

      The module has no seam to yield through, so it runs in a dedicated worker
      (`local_open_worker.ts`) and `LocalDecoder` is the proxy: the RAW is `hold`-ed once and
      transferred, so a tile carries a request rather than 72MB, and the results come back
      transferred too. Longest main-thread task over the same open afterwards: **143ms**.

      **The page never did borrow the module's device**, which is what made this possible: the
      presenter opens its own through `navigator.gpu`, the module opens its own for the decode, and
      what crosses between them is samples. A `GPUDevice` cannot cross a worker boundary at all, so
      the claim above is now structural rather than aspirational; `openGpuDevice` is what the
      worker asks to know whether it got an adapter, and nothing hands one out.
- [x] **The camera match is served** (`9e11861`), at `/image/:id/camera-match`, immutable under a
      per-photo URL because a match is a function of the file alone. Bytes, opaquely: a build that
      cannot read a blob ignores it and refits, so there is no version to negotiate at that
      boundary.
- [x] **The RAW is already cacheable, and this item was aimed at the wrong function.** `download()`
      does send `no-cache`, but `/download/original` does not go through it - it goes through
      `serve`, which carries an ETag off the file's size and mtime and answers a conditional GET
      with a 304. So a client that revalidates never re-fetches the 72MB. `immutable` would save
      the revalidation round trip and is not worth it: it would also let a RAW replaced in place go
      unnoticed, which is a stale picture in exchange for one small request.

## Memory, if the RAW is decoded in a tab

- [x] **rawler decodes a region into a region, and a frame a band at a time** (`ee72430`).
      `raw_image_region_tight` returns the tile-aligned rectangle it actually covered rather than a
      frame with a hole in it, and `raw_image_band_height` lets a caller loop it over full-width
      bands - a band *is* a region, so one extra method beats a second decode API with a closure
      through it. Whole frame 232MB/187ms becomes 118MB in strips; `raw_image` is untouched in
      result and slightly faster (187 -> 161ms).

      **The frame-sized allocation was never the cost.** `vec![0; n]` is calloc, so the untouched
      pages never fault in - the 122MB was virtual. What a loupe tile actually paid was
      `read_params` calling `file.as_vec()`, copying the whole 78MB mmap to decrypt a few kilobytes
      of it: **83 of its 89ms**. Now a borrow, and the tile is 104MB/6ms.

- [x] **`MAP_POPULATE` stays** - decided, not done. `RawSource::new` prefaults, so opening a 72MB
      RAW is 78MB resident before a sample is decoded, a floor under every figure above. The floor
      only matters in a tab, and in a tab there is no mmap at all, so removing it would trade
      cold-cache sequential read for demand paging and buy nothing where the cost lands.
- [x] **`condition` as a kernel** (`f81b69b`). The samples go up packed two to a `u32` - 120MB at
      61MP rather than the 241MB `f32` plane.

      **The kernel does no arithmetic, deliberately.** Vulkan requires only 2.5 ULP of `OpFDiv` and
      RADV lowers the divide to a reciprocal and a multiply, so `(raw - floor) / range * gain` in
      WGSL cannot be bit-identical to the host's however it is spelled. A conditioned sample is a
      function of sixteen bits and a 2x2 position, so the host evaluates its own expression over
      all 262144 of them and the shader is a lookup - one spelling of the arithmetic, and equality
      rather than a tolerance, because this frame is what every rendition is built from.

      **It is 3x slower here and the open does not move**: 26-30ms threaded on the CPU against
      86ms, on an integrated adapter whose memory is the CPU's. The halved upload is a memcpy
      either way while the mosaic still has to come back for `galosh::fit` and the tiled demosaic
      to read on the host. It pays in a tab, where the mosaic never comes back, and it pays
      natively only once the readback goes.

## Move the open onto the GPU

73% of the open is CPU work with a GPU sibling already in the tree. This has to happen whether or
not the client does the open, and it has to happen *before* wasm runs any of it single-threaded.

**The prize is the transfers, not the stages.** RCD leaves the frame in VRAM and reads it back;
the grade uploads it again. At 61MP that is 361MB each way to run pointwise arithmetic on a CPU.
So a stage is worth moving even where the stage itself is cheap, and the last one to move is
worth more than its own timing.

> **Read every number in this section against the machine that produced it: the GPU is
> integrated.** `open_bench` names it - `AMD Ryzen 7 7800X3D (RADV RAPHAEL_MENDOCINO)
> (IntegratedGpu)`. There is no discrete card and no PCIe bus, so the "361MB upload" is a memcpy
> into the same DRAM the CPU is already reading, and a kernel gets no memory bandwidth the CPU did
> not already have. That cuts both ways and neither is the naive one: a transfer is far cheaper
> here than the "361MB each way" framing suggests, so the *prize above is smaller than it sounds*;
> but a bandwidth-bound kernel has nothing to win with either, so a stage that is a plain sweep
> over the frame will keep losing to a threaded CPU no matter how the transfers are arranged. What
> does win here is arithmetic density - RCD, GALOSH's pass12, the sorting network - where the work
> per byte is high enough that shader lanes beat cores. The levels quantile is the counter-example
> and the reason this box is worth writing down: a million atomics over one byte each, which is
> exactly the shape that cannot win on an iGPU.
>
> A discrete card would change these conclusions, not just these constants. Re-measure before
> porting anything on the strength of a number here.

- [x] **the coding** (`2743056`). Within a count of the CPU over every level a sample can hold.
- [x] **defringe** (`7f02072`). Composing it with `recombine` leaves one add per channel; the
      1170ms was the planar split, the strips and the interleave, none of which a shader needs.
- [x] **noise measure** (`8ecfd9a`). Within 0.2% relative; the quantiles stay on the CPU, where
      they run over ~941k block sigmas rather than pixels.
- [x] **lens warp** (`fcd4577`). Within 2 counts, mean 0.167. Uploads the ratio table rather than
      evaluating the spline, because the CPU gather reads that table and its 4096 buckets are part
      of the answer a rendition already committed to.
- [x] **~~levels quantile~~ - ported, exact, and then deleted unwired.** It came back exact and
      still lost, for reasons that were never about the kernel; see the entry below. Kept here
      because the index arithmetic was the hard part and is the thing to re-derive if anyone ports
      it again: `tone::sample_at` is `(k * pixels / counted) * 3`, 52 bits at 61MP where WGSL has
      no u64, so with `whole` and `rest` taken on the host it splits as
      `k * whole + (k * rest) / counted`, and splitting `k` at bit 10 keeps every intermediate
      inside `u32`.

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
- [x] **The chain's 8x regression, root-caused and fixed.** Two causes, both ours, neither the
      driver, and `examples/chain_probe.rs` could reproduce neither - which is what said to look at
      the caller rather than the chain.

      **The defocus pair was measured off the *uncoded* frame** (`cf4288a`). `measure_defocus`
      declined, the defringe was silently skipped, the whole fixture suite still passed, and
      `noise::measure` on a frame with its fringing left in took 7910ms against 983ms. `prepare`
      measures its own pair off the frame it has just coded now, which is also the only honest
      place for it.

      **wgpu frees on a poll, not on a drop** (`952f841`). `read_back` polls and *then* the frame
      and its warped copy go out of scope, so 722MB sat queued for destruction until something
      polled next - after the sharpen, which ran 3197-3467ms against 2386-2926ms. `reclaim`
      destroys and polls before returning.

- [x] **Wired, both paths** (`952f841`, `97522f3`). `edit::open` and `job::Base::build` both take
      `prepare`. On a 61MP frame, against the CPU path: code + defringe + warp **1695ms to 956ms**,
      and the open after its levels **5201ms to 4709ms**. 279 fixture tests green, pinned renders
      unmoved, and `decode_bench`'s checksums identical to before any of this existed.
- [x] **The noise measure is wired**, once its median stopped being a selection sort. It had gone
      in once before (`e19350f`) and come back out (`6f02531`) at 987ms against the CPU's 958ms; it
      is now **221ms against 910ms** on a 61MP frame, and **227ms** in the open's own lap rather
      than alone, behind the same `gpu::device().and_then(base::device)` fall-through the other
      stages take. It remains the one stage paying an upload and no readback - which is why the
      number to watch is the lap, not the standalone: measured immediately after a run that had not
      yet released a gigabyte of buffers, the same call took six seconds longer.
- [x] **The block reduction's median is a sorting network.** That was where the whole of the noise
      measure's time went, and the transfer was never it: at 61MP the frame is 1188 x 792 blocks,
      each taking the CPU's exact order statistic by partial selection - 48 passes over 96 laps,
      twice over, so about 8.7 billion comparisons, every one of them indexing a private array
      dynamically and spilling to scratch. Measured whole, that was **8089ms**; as a bitonic
      network over the same bit patterns it is **221ms**, and the same order statistic to the
      element. `noise.wgsl`'s `median96`, pinned by `the_median_network_takes_the_rank_the_cpu_takes`.
- [x] **~~The levels quantile is ported but deliberately not wired~~ - deleted, and the CPU threaded
      instead.** The blocker recorded here was wrong twice over, and both are worth keeping straight.

      **`prepare`'s upload was never the wrong one.** This said it "codes a frame a rendition may
      have resized". It does not: both callers hand it `(width, height) -> (width, height)` -
      `edit::open` never resizes at all, and `job::Base::build` codes at the decode's size and
      fits per target further down. So the seam existed, and `prepare` even has the pattern for it,
      swapping its encoder mid-chain to fence for `measure_defocus_into`.

      **The seam stopped being worth taking once the CPU was threaded.** `tone::levels` was a
      serial gather on one core of twelve; per-thread blocks make it **156-170ms to 12ms**, against
      **222ms (175-247)** for the ported kernel paying its own upload. So folding the histogram onto
      `prepare`'s upload can save at most 12ms - and cannot save all of it, since it adds a
      submit-and-fence. Against that: `prepare`'s signature changes for both callers and
      `chain_probe`, `edit::open`'s too-dark refusal has to move after the chain, and a CPU path has
      to stay anyway for every frame `prepare` declines. Matching is not earning, so `base::levels`,
      `wgsl/levels.wgsl` and `the_levels_match_the_cpu` are gone.

      **And it could never have served a browser anyway**, which is the part that holds whatever
      the hardware does: `gpu::device()` returns `None` on wasm32, so the CPU quantile is not the
      fallback there but the only path there is. Threading it is the only way that number moves.

      Timings taken on a loaded box (four agents, load average ~24). Contention makes threading
      look worse, not better, so 12ms is pessimistic and the ratio is not what the argument rests
      on - the ceiling is.
- [x] **The block reduction sorts its median instead of selecting it** (`4a4329a`), **8089ms to
      221ms**. At 61MP the frame is 1188 x 792 blocks, each taking the CPU's exact order statistic
      by partial selection - 48 passes over 96 laps, twice over, about 8.7 billion comparisons,
      every one indexing a private array dynamically and spilling to scratch. A bitonic network
      holds the same order statistic without the dynamic indexing.
- [x] ~~**sharpen, 2926ms**~~ - **exempted, not done.** A GPU sharpener is replacing it, so its
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
- [x] **GALOSH reports its progress** (`galosh::denoise_in_tiles` takes a `done` callback,
      `PROGRESS_TILE = 2048`): 20 updates at ~236ms for +22%. Finer is worse and was measured -
      1024 costs 73% of the frame for an interval already below what a reader resolves.

      **The premise was stale: the frame already arrived in 20 pieces.** The decode was tiled at
      this same 2048 for memory after this item was written, so what was missing was the report,
      not the tiling.

      **And tiled GALOSH never reproduced the frame denoised whole.** `pass12` shrinks inside a
      tile indexed from the region origin, so a region off that grid shrinks every pixel against a
      neighbourhood the whole-frame answer never uses: 94% of a 61MP frame's samples differ by up
      to 1.6e-3, spread across the frame rather than banded at the seams, and identical at halo 64
      and halo 512. Rounding each origin down to `2 * PASS12_TILE` fixes it exactly for ~5% extra
      area. `decode_rawler` had the same geometry without the rounding and now delegates
      (`8ba748f`), so every rendition carried this until tonight.
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
- [x] **`pass12` sorts its median instead of bisecting for it** (`f978344`), **4354ms to 2979ms**.
      It was 82% of GALOSH and, unlike the table, genuine per-pixel work.

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

- [x] **The loupe's own decode tiles too** (`8860019`). Past one `RENDER_TILE` on either axis it
      takes `denoise_in_tiles` / `demosaic_in_tiles`; below that it keeps the single pass verbatim.
      RCD holds 13 planes at 52 B/px, so a single pass cost 52 B times the whole window - unbounded
      in how far `db0e726` grows it. Tiled it caps at 2068² × 52 B = **222MB** whatever the window,
      against **3.13GB** for one grown to a full frame. No speedup, and none was the point.

      **`spans` splits evenly, and the far edge rounds outward to even.** Splitting into whole
      2048s leaves a runt column on an arbitrary width, which the demosaic declines outright; but
      an even split puts boundaries on odd columns, where the window's origin aligns down to a
      whole CFA site and trimming inward stole a pixel of RCD's margin. `tile_check` read
      `worst 25081` at 3000 while every size whose rectangle missed the frame's own odd seam read
      `worst 0` - including the default 512, which never reaches the tiled path at all.

## Falls out of the above

- [x] **Loupe tiles become local**, so no server round trip per pointer move. They are already 12x
      faster from the kept table: 425ms to 35ms per tile.

      **A local tile is pixels, and the grade stays the page's.** What crossed the wire was an HDR
      AVIF because bytes had to survive a wire; nothing does here, so `renderTile` hands back the
      window the grade reads - coded, denoised on the mosaic, warped and sharpened - plus its
      `gpu::uniform_words`, and the tick's own shaders draw it onto the glass. Encoding a picture in
      the tab to decode it again in the same tab would be the round trip in miniature, and grading
      it in the module would be a third copy of a rule two hosts already share.

      **One tile path, two hosts.** `tile.rs` is everything from the rectangle to the window -
      `grown`, the decode, the coding, the lens gather, the sharpen - and both `job::graded` and the
      wasm export call it, so `a_tile_is_graded_as_the_rendition_is` covers the tab as well.
      `Base::build` is a rendition's again: its tile arm, its `asked` field and the levels branch
      that only a tile took are gone.

      **And now one host.** The shell's AVIF tile went with its native open: `GET /:photoId/tile`,
      `serveTile`, `bb_render_tile` and `job::tile` are deleted, `TileArt`'s `<img>` arm collapsed
      to the window the page decoded, and `job::graded` stays as the native side of the same claim.

      Proven in a browser by `local_decode.spec.ts`: the tile route is never requested, nothing
      announces a fall-through, and the glass reports that it is holding the export's own pixels.
      Both halves were confirmed red before being trusted - forcing the server arm fails on the
      request, refusing the local one fails on the glass.
- [x] **The colour Detail slider is interactive** (`f453757`). A colour-only tick runs `yuv_loess`
      and `yuv_join` and none of the eight passes beneath them: `luma` is the only amount entering
      the chain before the regression - `ridge` and `blend` are the regression's own - and nothing
      from `loess` on writes a plane the earlier passes read, so those planes still hold this
      frame's luma. Pinned by a recording device rather than an adapter, since which passes run is
      decided before any of it reaches a driver.
- [x] **A Detail slider draws its answer a band at a time.** `DenoiseChain.record` takes a band and
      `EditPipeline.stepDenoise` submits one per draw, so a 61MP frame arrives in strips instead of
      after seconds of black-box work. The bands land *final* - the levels, the warp and the camera
      match are all cached by the time a Detail slider is touched, so nothing a strip shows is
      re-graded or shifted by the strips below it.

      Six kernels took a `start`, `pass12` a `tile_y0` and `yuv_loess` a `y0`, all trailing so the
      native host keeps sending a zero and dispatching the whole frame. A band is 112 rows because
      that is a whole number of `pass12` tiles *and* of regression workgroups: a band that split
      either would re-anchor a grid, which is the same defect `decode_rawler`'s tiled denoise
      carried until its origins were rounded (above).

      Pinned on a GPU by `native/rawshim/tests/galosh_band.rs`, which runs `pass12` and `yuv_loess`
      over a textured plane twice - once whole, once in bands - and demands exact equality. Both
      were confirmed red by dropping the offset each takes. The per-pixel kernels are left to the
      TypeScript side, where a band is a range and the test reads the pushes back.

      **The flat passes are not all idempotent, which decides the halo's shape.** `yuv_sigma_norm`
      scales in place, so the rows two bands' neighbourhoods share cannot be run twice: each band
      sweeps from where the last one stopped to its own end plus seven rows, and the union is the
      frame exactly once. That, the tile anchoring and the pair alignment of `yuv_join` are what
      `denoise_chain.test.ts` reads back out of the pushes.

      Found on the way, and older than the banding: `yuv_sigma_scale`'s `start` had been added
      *ahead* of `sigma_slot`, so both hosts were silently normalising against `params[0]` - not a
      sigma at all. The editor's denoise had stopped denoising; a crop of the ARW fixture reads 1.56
      roughness undenoised, 0.17 at Detail 60 with the field back in its place.
- [x] **Delete what only exists to cross a wire**: `bb_prepare_edit_*`, `rawshim_edit.ts`, the
      `/prepared` route, `edit::prepare` and its `raw_file_path`, and the refusal frame the FFI
      raised. All of it is gone now that the shell has no open of its own either. What stays is
      `edit::prepare_bytes`, `prepare_bytes_async`, `edit::encode` and `PreparedHeader` - the wasm
      export's own framing, which the client parses and the fixture tests hold.

## Stale, noticed on the way

- [x] `raw_edit_presenter.ts` said a matched header is 11KB; it measures 32KB.
- [x] DESIGN.md's stack table and §10.4 named LibRaw as the decoder.
- [x] **DESIGN.md's remaining stale decoder claims** (`32f91da`). 77 mentions read, 24 corrected,
      53 left as genuine history under existing status markers. Two surprises: `orientation` is the
      **EXIF tag 1-8**, not LibRaw's `flip` encoding as this plan asserted - only the catalogue's
      older rows hold 0/3/5/6 - and §7 carried a "CR2 is not in the set" line flatly contradicting
      the two paragraphs above it. The `decode_with_libraw` peak figures are deleted rather than
      restated: no current whole-decode memory figure exists, and inventing one would be worse than
      naming the absence.
