# Fusing the HDR warp into the grade

An HDR rendition walks its whole frame twice for work that could happen once. This is
what the second walk is, why it is not simply deletable, and what it would take.

The SDR side already had exactly this shape and no longer does, `fit::apply` fuses its
warp, falloff and colour into one sweep as of `37c9916`, which took a 24MP frame from
1076ms to 656ms. HDR is the same problem one layer down, and harder in one specific way.

## Where the two passes are

`hdr::encode_still` (native/rawshim/src/hdr.rs, around the `let warped = { … }` block)
does:

1. `hdr_fit::apply_lens(samples, width, height, matched)`, warps the frame through the
   lens, applying the falloff in the same sweep (as of `da3d067`), into a **new 16-bit
   buffer**.
2. `tone::grade(&mut frame, …)`, reads that buffer back and transforms every pixel in
   place.

Nothing between them needs a neighbourhood. The warp is a gather; everything `grade` does
afterwards is pointwise on what the gather returned. So the intermediate exists only to be
handed from one loop to the next.

At a 3840×2560 rendition that buffer is 59MB, written once and read once. A 61MP source
still warps at the *output* size, the model is in normalised radii, so warping 61MP to
make a 3840px rendition is the same picture for sixteen times the work; so 3840 is the
size that matters, not the decode's.

## Measured, at 3840×2560 on three cores

| stage | cost |
|---|---|
| `apply_lens` (warp + falloff) | 99ms |
| `grade`, peak prepass | 30ms |
| `grade`, main sweep | 247ms |
| **total** | **376ms** |

Fusing does not remove the warp's arithmetic; it removes the intermediate's write and
read. Expect something in the tens of milliseconds here and proportionally more on larger
renditions, but **measure it rather than trusting that estimate**. Every performance guess
made during this branch's work was wrong until it was measured, including several of mine
that sounded far more certain than this one.

## Why it does not fuse trivially

`grade`'s matched path is not one sweep. It is:

1. **A peak prepass.** It samples `QUANTILE_SAMPLES` (2^20) strided positions, applies the
   full colour transform to each, takes the brightest channel, and selects the
   `PEAK_QUANTILE` order statistic to get `scene_peak`.
2. **Table building**, which needs `scene_peak`: the EETF roll-off table and the
   per-channel curve LUTs.
3. **The main sweep**, which needs those tables.

So the prepass needs post-colour values from *across the whole frame* before the main sweep
can transform a single pixel. Feed `grade` the unwarped frame and it computes its peak from
the wrong pixels, and the peak sets the roll-off, so that is a visible difference in the
highlights, not a rounding one.

The comment on the prepass explains why it is a strided subsample rather than a full
reduction: keeping every pixel's nits wanted a 720MB buffer on a 60MP frame. That reasoning
still holds and should not be undone.

## The shape of the fix

Give `grade` the warp rather than the warped frame, and let it gather in both places:

- **In the prepass**, warp only the sampled positions. It reads 2^20 of them, so this is a
  million gathers against the ~10M the main sweep does; cheap, and it is the whole reason
  this is tractable.
- **In the main sweep**, warp each pixel as it is transformed, exactly as `fit::apply` now
  does on the SDR side.

`image::Warp` (native/rawshim/src/image.rs) is the SDR precedent: the radial table resolved
once, handed out so a caller can drive it per pixel. The spline is never evaluated per
pixel in either path, `ratio_table` bakes it into a radial lookup up front, and a pixel
does a lookup plus a bilinear read. HDR needs the 16-bit planar equivalent, which is what
`warp_planar` already is internally; it wants the same treatment `warp` got.

## Constraints that must survive

- **Sample the same positions.** The prepass strides over *output* pixels. Warping on the
  fly must keep those same output positions, not stride over source pixels, otherwise the
  peak is measured from a different set and the roll-off moves.
- **Out-of-frame gathers.** Where the warp lands outside the source, `apply_lens` leaves
  the pixel at zero. The prepass currently reads those zeros and they count toward the
  quantile. Preserve that, or justify the change: excluding them raises the measured peak.
- **Quantisation.** `da3d067` made the falloff land on the interpolated value rather than
  on an already-rounded `u16`. Fused, the colour transform should likewise see the
  interpolated value, so the frame is quantised once at the end. This is a real
  improvement, and it will move the pinned output, see below.
- **The buffer story.** `hdr.rs` currently leans on the warp's output being the buffer
  `grade` mutates in place: "whichever stage last allocated *is* that buffer". Fused,
  `grade` reads the source and writes somewhere else, so make sure the result is still one
  owned buffer and not a third 366MB allocation at 61MP. The `Decode::Owned` path that
  hands the decode back before the encode allocates is the thing to keep intact.
- **The unmatched path.** `grade` returns early when there is no colour match, using a
  single 65536-entry LUT. A frame can have a lens but no colour match, so that path needs
  the warp too.

## Checking it

- `test/fixtures/hdr_grade.pin.txt` pins the graded output by hash. The quantisation change
  above will move it. Regenerate with `BOWERBIRD_UPDATE_PINS=1 cargo test --release
  --features fixtures`, and confirm the diff is only the rows you expect.
- The 35-frame corpus comparison used throughout this work lives in `/tmp/hdrcheck`
  (`corpus.py` compares rendered output against each camera's own JPEG in Lab). A fusion
  should move it by nothing; if it moves, the peak or the sampling changed.
- Measure interleaved, minimum-of-N, pinned to fixed cores. Sitting-to-sitting drift on
  this machine is ±20ms on a whole-frame timing, which is wider than several of the
  differences worth chasing.
