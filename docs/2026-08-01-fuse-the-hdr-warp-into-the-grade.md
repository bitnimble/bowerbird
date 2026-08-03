# Fusing the HDR warp into the grade

An HDR rendition used to walk its whole frame twice for work that could share one
sweep: warp (with falloff), then pointwise colour. The SDR side already fused that
shape (`fit::apply` as of `37c9916`). HDR is the same problem one layer down, and
harder because the matched grade needs a scene-peak prepass before its main sweep.

## What shipped

`prepare` no longer materialises the lens. The one-shot encode builds a
`PlanarWarp`, measures the matched scene peak on the **unwarped** source (cheap
`u16` reads), then gather+colours through `PlanarWarp::map_u16` in one sweep.

The editor still calls `apply_lens` once into `Prepared` and re-grades in place on
every slider tick, peaking the warped buffer.

Falloff can move the peak versus the warped frame; that tradeoff is accepted. Means
on the fixture barely moved; max channel dropped a few counts; matched pins were
regenerated.

## What did not ship

Warping the peak prepass (bicubic ~1M samples) **lost** 30–80ms on IMG_8789 → 3840,
3 cores. Routing gather through a per-pixel `PlanarWarp::sample` was itself tens of
ms slower than the tight inline loop in `map_u16`. Peak-unwarped + fused main sweep
won about 33ms (−5%) against the old two-pass baseline on the same machine.

## Why the peak prepass exists

`grade`'s matched path is not one sweep. It is:

1. **A peak prepass.** It samples `QUANTILE_SAMPLES` (2^20) strided positions, applies
   the full colour transform to each, takes the brightest channel, and selects the
   `PEAK_QUANTILE` order statistic to get `scene_peak`.
2. **Table building**, which needs `scene_peak`: the EETF roll-off table and the
   per-channel curve LUTs.
3. **The main sweep**, which needs those tables.

The prepass must finish before any output pixel can be coloured. Keeping every
pixel's nits wanted a 720MB buffer on a 60MP frame; the strided subsample stays.

## Constraints that must survive

- **Quantise before colour on the fused path.** The materialising warp truncates to
  `u16` (`as u16`); `map_u16` does the same before the colour mapper, so editor and
  encode cannot drift on the gather.
- **Out-of-frame gathers** leave zeros; the editor's peak (warped) still sees them.
  The encode's unwarped peak does not - accepted with the peak tradeoff.
- **One owned buffer.** `grade_owned` takes the source, writes the result, drops the
  source; no third full-frame allocation.
- **Neutral + lens.** A frame can have a lens but no colour match; that path LUT-maps
  inside `map_u16` too.
- **API split.** `grade_prepared` is in-place on an already-warped frame.
  `grade_prepared_owned` is the encode path that may carry a lens.

## Checking it

- `test/fixtures/hdr_grade.pin.txt` - regenerate with `BOWERBIRD_UPDATE_PINS=1 cargo test
  --release --features fixtures` when the peak or gather changes.
- Measure interleaved, minimum-of-N, pinned to fixed cores. Sitting-to-sitting drift
  on this machine is ±20ms on a whole-frame timing.
- Microbench: `cargo run --release --example bench_graded -- <raw> [rounds]`.
