# RCD, optimisations found in existing implementations

Companion to `rcd-algorithm-spec.md`: deployed CPU/GPU optimisations, their costs and portability.
Results unchanged except for two flagged exceptions.

---

## Tiling and the working set

The dominant CPU optimisation is tiling. The frame is cut into fixed-size overlapping square tiles
(around 194 pixels on a side in one implementation; a build-time constant tuned per architecture in
the other), and the whole six-stage pipeline runs to completion on one tile before moving to the
next.

Main gain is cache residency, with parallelism secondary. Mosaic, three colour planes, axis,
low-pass, diagonal field and two diagonal high-pass buffers otherwise stream tens of megabytes
repeatedly. Tile-sized intermediates fit private cache for all six stages. On a 24-megapixel
frame, saved traffic outweighs arithmetic several times over.

The overlap follows directly from the dependency reach: 10 pixels, per the spec's margin analysis.
Each tile computes a 194-wide square and contributes only its interior; neighbouring tiles
recompute the overlap independently, which is pure duplicated work traded against the cache win.
Roughly a tenth of all pixels are computed twice at that tile size, so shrinking tiles is not free; too small and the duplicated border dominates, too large and the working set spills.

Interior tiles discard margin 10; frame-edge tiles discard 9. Interior neighbours supply exact
answers; at frame edges, blend-field means reading one row beyond validity degrade tolerably,
reclaiming one row. Cheaper demosaic fills the remaining border.

## Scratch buffer strategy

Allocate scratch once per worker, outside tile loop; reuse across thousands of tiles.

Low-pass dies when green completes, before diagonal blend field is needed. Equal size and
disjoint lifetimes let both share one allocation, halving footprint and retaining cache warmth.

Clear affected buffers for partial edge tiles: blend refinement reads one pixel beyond its
computed region, where previous-tile values would make output traversal-order-dependent.
Full tiles need no clear.

## Restructuring stage A

Stage A as specified computes a high-pass response per pixel per axis and then sums three squares.
Written literally that is two full-plane intermediate buffers.

Use three rotating vertical-response rows (`r−1`, `r`, `r+1`), computing one new row per
output row. Each response is computed once, consumed three times. Horizontal responses need
one row. Fuse response, energy and ratio into one row-oriented tile pass.

This turns two full-plane buffers into four line buffers, and turns three reads of a plane into
three reads of registers or L1. It is the single largest structural difference between the original
reference implementation and the deployed ones.

## The factored energy form

Original nine-sample quadratic uses about 45 weighted products per direction, four directions
per pixel. Three squared 7-tap responses give identical real arithmetic at roughly a tenth
the cost. Spec includes both for verification; use factored form for new implementations.

## Half-density packing of checkerboard quantities

Three quantities are defined only on a checkerboard sub-lattice: the low-pass image, the diagonal
blend field, and the two diagonal high-pass buffers. Stored at full density they would waste half
their memory and, more importantly, halve the useful fraction of every cache line fetched.

All are packed to half density by halving the linear pixel index, which works because the lattice
alternates column parity with row parity in exactly the way that halving an index does. Neighbour
addressing in the packed layout is a straightforward remapping, a step of two columns becomes a
step of one slot, a step of two rows becomes a step of one packed row. For the low-pass image and
the diagonal blend field this packing is exact, and the neighbours the spec calls for are the
neighbours actually read.

**This is one of the two flagged exceptions.** For the diagonal high-pass buffers it is not exact.
Those buffers are filled by scanning every row at a fixed column parity, whereas the lattice the
statistic needs alternates parity by row. The consequence is that for half the rows, one or two of
the three responses summed into the diagonal energy are taken from the column next to the one the
statistic calls for, and, since the parity is fixed, from a green site rather than a red or blue
one. The result is a slightly different statistic, not a wrong result: the responses being summed
are still valid high-pass responses of the same kernel in the same direction over almost the same
neighbourhood, and the energy is only used to form a soft blend weight. Both major deployed
implementations share this behaviour, so anyone reconciling output against them pixel-for-pixel will
need to reproduce it; anyone implementing from the spec should not.

## Data layout for colour

Separate contiguous colour planes let stage F select a base address per channel and give
vector units consecutive samples. Interleaved triples require stride-3 gathers.

The load pass exploits this with a small branchless trick. For each row, the colours at the row's two
column parities are determined once; every sample in the row is then written into *both* of the
corresponding planes as well as the mosaic buffer. Half of those writes are wrong, but each wrong
one lands exactly where a later stage will overwrite it; a red site's green slot is filled by stage
C, a green site's chroma slots by stage F, so no wrong value survives to the output. This replaces a
per-pixel branch or table lookup on CFA phase with two unconditional stores, and it is the reason
the later stages need no phase test to know whether a sample is available.

What this does *not* initialise is the third plane: a row carries only two of the three colours, so
one whole plane is left untouched across every pixel of that row. Every such slot is written by
stage E or stage F before anything reads it, but that is a property of the read footprints rather
than an obvious invariant, and it is worth confirming rather than assuming when porting. One
implementation carries an explicit note that it clears these buffers for partial tiles without
having established which reads made that necessary.

## Common subexpression hoisting

Small and mechanical, but pervasive enough to matter given the arithmetic density:

- Each opposing pair of gradients shares its leading absolute-difference term. It is computed once
  and added to both. In stage F, where the same gradient shape is evaluated for red and for blue,
  the green-difference terms depend only on the site and are hoisted out of the per-channel loop
  entirely, along with the four adjacent green values used to form the colour differences.
- The centre sample and the centre low-pass value are loaded once and reused across all four
  directions.
- The refined blend weight is computed once per site in stage F and shared by both chroma channels,
  since it depends only on the axis field.

## Compiler and vectorisation directives

CPU versions locally enable FMA contraction, finite-value assumptions and suppressed maths
`errno`. Spec's positive denominators and non-negative input justify those assumptions.
Revert flags afterward; global enablement has caused failures elsewhere.

Alongside that: allocations are 64-byte aligned and the buffers declared non-aliasing, and the
functions are annotated so the compiler generates vector clones. The inner loops are written to be
trivially vectorisable, no branches, no early exits, unit stride over the packed or full-density
buffers.

## Thread parallelism

Collapse both tile loops into one iteration space to saturate cores on short frames.
Implementations choose static scheduling for equal-cost tiles or tunable dynamic chunks for
cheaper edge tiles. Progress counters update every 32 tiles to amortise locking.

## The GPU path

OpenCL's structure informs compute-shader ports:

**No tiling.** Full-frame buffers and a large launch grid use GPU bandwidth/thread residency.

**One kernel per stage**, dependency-ordered with queue barriers. Checkerboard stages launch
at half x-width, one work-item per site, applying row phase when computing columns.

**Local-memory staging for stage A,** which is the GPU analogue of the CPU's tiling and rolling line
buffers. Each workgroup cooperatively stages its region of the mosaic plus a halo of 4 pixels on
every side into local memory, synchronises once, and then every work-item computes its six
high-pass responses out of local memory. Without this, each mosaic sample would be re-read from
global memory by many neighbouring threads. The halo fill clamps coordinates to the frame, so the
staging never reads out of bounds, and the two sub-steps of stage A are fused into this one kernel
specifically so that the two full-frame high-pass buffers are never materialised in global memory; the same saving the CPU gets from rolling line buffers, achieved by a different mechanism.

**Negotiate workgroup size.** Start at 64×64; shrink using per-item memory and halo overhead
until device memory/workgroup limits fit. Round launch up to that shape. Fixed sizing fails
across integrated/discrete GPUs.

**The margin** is handled by running a simple full-frame demosaicer first and having the final
write-back kernel skip the outer 9 pixels, leaving the cheap result in place there.

**Scaling** is folded into the endpoints: the load kernel applies the reciprocal white level as it
converts, the write-back kernel applies the white level as it stores, so no separate normalisation
pass exists.

## Numerical shortcuts

Only three, all minor, all listed in the spec's variation section:

- The `ε` in the low-pass ratio is kept in the denominator only rather than also appearing in the
  numerator as the exact algebra requires. A one-in-10⁵ difference on a near-zero value.
- Intermediate per-stage clamping to the unit interval is dropped; only the blend weight and the
  final output are clamped. Saves two clamps per pixel per stage and cannot matter unless the input
  conditioning has been skipped.
- The low-pass kernel is left unnormalised (four times the binomial weights) since the normalisation
  cancels in the ratio it feeds. Free, but it does scale the effective `ε` by four.

## What transfers to a compute-shader implementation

Porting choices:

Worth keeping: one dispatch per stage; half-width dispatch for the checkerboard stages; the
achromatic-lattice packing for the low-pass and diagonal field (exact, halves bandwidth); fusing the
high-pass computation into the energy stage so the response planes never exist; hoisting the shared
gradient terms and the per-site blend weight; folding the scale into load and store.

Not worth keeping: CPU tiling and its overlap (replaced by the launch grid); rolling line buffers
(replaced either by workgroup-shared staging or by simply re-reading, since the mosaic is small and
cached); the branchless double-store at load, which trades a branch for bandwidth, a poor trade on
a GPU, where the phase test is uniform across a row and cheap; the packed layout for the diagonal
high-pass buffers, which buys little and costs the accuracy noted above.

Worth deciding deliberately: whether to stage the mosaic in workgroup-shared memory for the energy
stage. Its reach of ±4 in four directions means a naive version re-reads each sample many times,
but a texture cache may absorb that; measure before adding the barrier and the halo logic.
