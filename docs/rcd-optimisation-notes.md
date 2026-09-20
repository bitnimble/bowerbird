# RCD, optimisations found in existing implementations

Companion to `rcd-algorithm-spec.md`. Nothing here changes what the algorithm computes, with two
flagged exceptions. This is a survey of the engineering the deployed CPU and GPU versions apply on
top of the mathematics, and why each one pays, so that a fresh implementation can adopt the ones
that transfer and knowingly skip the ones that do not.

---

## Tiling and the working set

The dominant CPU optimisation is tiling. The frame is cut into fixed-size overlapping square tiles
(around 194 pixels on a side in one implementation; a build-time constant tuned per architecture in
the other), and the whole six-stage pipeline runs to completion on one tile before moving to the
next.

The reason is not parallelism, which tiles happen to also give; it is residency. The algorithm
carries five or six intermediate full-plane quantities: the conditioned mosaic, three colour planes,
the axis field, the low-pass image, the diagonal field, and two diagonal high-pass buffers. At full
frame that is tens of megabytes streamed repeatedly, and every stage reads its inputs with a reach
of several rows, so each row of the mosaic is touched by every stage. Sized to a tile instead, the
entire set of intermediates fits in a core's private cache and is read from there six times over. On
a 24-megapixel frame this is worth several times the arithmetic cost, which is why the tile size is
documented as a significant performance parameter rather than an arbitrary choice.

The overlap follows directly from the dependency reach: 10 pixels, per the spec's margin analysis.
Each tile computes a 194-wide square and contributes only its interior; neighbouring tiles
recompute the overlap independently, which is pure duplicated work traded against the cache win.
Roughly a tenth of all pixels are computed twice at that tile size, so shrinking tiles is not free; too small and the duplicated border dominates, too large and the working set spills.

One asymmetry is worth noting because it is easy to get wrong: tiles on the outside of the frame
discard a *smaller* margin (9) than interior tiles do (10). Interior tiles must discard the full
dependency reach because a correct answer exists there and a neighbouring tile will supply it. Edge
tiles have no neighbour, and the outermost pixel of the reach is the one that merely degrades
(the neighbourhood mean of the blend field reaching one row beyond the field's valid region) rather
than being wrong, so one row is reclaimed. The remainder of the frame edge is filled by a cheaper
demosaicer.

## Scratch buffer strategy

Scratch is allocated once per worker thread outside the tile loop and reused for every tile that
thread processes, rather than per tile. With tiles numbering in the thousands this removes all
allocator traffic from the hot path.

Reuse is pushed further: the low-pass image and the diagonal blend field are never live at the same
moment, the low-pass is dead as soon as green is complete, and the diagonal field is not needed
until after that, so one allocation backs both. Same size, disjoint lifetimes, half the footprint,
and the second use finds the memory already hot.

The cost of reusing buffers across tiles is staleness: a partial tile at the frame edge writes fewer
pixels than a full one, leaving the previous tile's values in the remainder. Since the blend-field
refinement deliberately reads one pixel outside the region the field was computed for, those stale
values would leak in and make the result depend on tile traversal order. The fix is to clear the
affected buffers, but only for partial tiles, the common full-tile case skips the clear entirely.

## Restructuring stage A

Stage A as specified computes a high-pass response per pixel per axis and then sums three squares.
Written literally that is two full-plane intermediate buffers.

Neither is materialised. The vertical responses are kept in three rolling line buffers holding rows
`r−1`, `r`, `r+1`; after each output row the three are rotated so the oldest becomes the destination
for the next row's fresh values. Only one new row of vertical responses is computed per output row,
so each response is computed once despite being consumed three times. The horizontal responses need
even less, a single row buffer, since the three summands for a given output pixel are its immediate
neighbours within the same row. The two sub-steps of the stage (response, then energy and ratio) are
fused into one row-oriented pass over the tile.

This turns two full-plane buffers into four line buffers, and turns three reads of a plane into
three reads of registers or L1. It is the single largest structural difference between the original
reference implementation and the deployed ones.

## The factored energy form

The original expresses the directional energy as an expanded quadratic form in nine samples: about
45 coefficient-weighted products per direction, four directions per pixel. The deployed versions use
the algebraically identical form as a sum of three squared 7-tap responses, roughly a tenth of the
arithmetic. This is exact, not an approximation, the two forms agree in real arithmetic, and the
spec gives both so the equivalence can be checked. It is listed here because it is presented as an
optimisation in the sources, but a fresh implementation should simply treat the factored form as the
definition.

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

The three colour planes are kept as separate contiguous planes rather than interleaved triples. Two
reasons. First, the stages are per-channel: stage F runs the same computation twice with a different
plane each time, and a plane can be selected by choosing a base address once outside the inner
computation, whereas interleaving would require a stride-3 gather. Second, the vector units want
consecutive same-channel samples.

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

The CPU implementations enable aggressive floating-point transformations for this code only, not
globally: fused multiply-add contraction, an assumption that no infinities or NaNs occur, and
suppression of `errno` handling around maths calls. The justification given is precisely the guard
analysis in the spec, because every denominator is provably bounded away from zero and every input
is clamped non-negative, the code cannot generate a non-finite value, so the transformations that
would be unsound in general are sound here. The transformations are scoped and then explicitly
reverted, on the grounds that enabling them project-wide has caused problems elsewhere.

Alongside that: allocations are 64-byte aligned and the buffers declared non-aliasing, and the
functions are annotated so the compiler generates vector clones. The inner loops are written to be
trivially vectorisable, no branches, no early exits, unit stride over the packed or full-density
buffers.

## Thread parallelism

The two tile loops are collapsed into a single iteration space so that a frame only a few tiles tall
still saturates a many-core machine. Scheduling differs between implementations: one uses static
scheduling on the theory that tiles cost the same, the other dynamic with a tunable chunk size on
the theory that they do not (edge tiles are smaller and skip work). Progress reporting, where
present, updates a shared counter only every 32 tiles, so the lock it takes is amortised to
irrelevance.

## The GPU path

The OpenCL implementation is structured differently, and the differences are instructive for a
compute-shader port.

**No tiling.** Buffers are full-frame. GPU memory bandwidth and the sheer number of resident threads
make the CPU's cache-residency argument moot; what would have been tiles becomes simply a large
launch grid.

**One kernel per stage,** dispatched in dependency order, with the queue providing the barriers. The
stages that operate on a checkerboard launch at half width in x, one work-item per *site* rather
than per pixel, with the row's phase offset applied when the work-item computes its column. This
halves the launch for those stages instead of launching everywhere and having half the threads
return immediately.

**Local-memory staging for stage A,** which is the GPU analogue of the CPU's tiling and rolling line
buffers. Each workgroup cooperatively stages its region of the mosaic plus a halo of 4 pixels on
every side into local memory, synchronises once, and then every work-item computes its six
high-pass responses out of local memory. Without this, each mosaic sample would be re-read from
global memory by many neighbouring threads. The halo fill clamps coordinates to the frame, so the
staging never reads out of bounds, and the two sub-steps of stage A are fused into this one kernel
specifically so that the two full-frame high-pass buffers are never materialised in global memory; the same saving the CPU gets from rolling line buffers, achieved by a different mechanism.

**Workgroup sizing is negotiated, not fixed.** A preferred shape of 64×64 is requested along with a
description of the per-work-item local-memory cost and the halo overhead in each dimension; a helper
reduces the shape until it fits the device's local memory budget and work-group limits, and the
launch is rounded up to the resulting shape. Hard-coding a workgroup size is the failure mode this
avoids, the same kernel must run on integrated and discrete parts with very different local memory.

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

Briefly, since the reason for cataloguing all of the above is to decide what to keep:

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
