# Persisted photo edits, cross-session undo, and edited renditions

Status: **phase 0, §2-§6, §7/§8 and §9 are done and shipped; §10 is superseded.** Every slider in
the panel now renders, in the editor and in a rendition: the tonal five and the colour two as
terms in `adjust.wgsl`, the presence three off a blur `detail.wgsl` builds once per frame, and the
crop, straighten and turn inside the cut's own gather.

What is left is the interactive crop tool (the render side is built; nothing draws a handle yet),
XMP import as an endpoint - `editsFromXmp` exists and nothing calls it - batch edits, and the
white balance pair, which stores and reloads but has no baseline to move against until the
prepared header carries the shot Kelvin. Plus one thing outside this document: §10.2's deployment,
which is a blocker for the *render* half and is unstarted.

Read §0.4 before anything else - it says what phase 0 became, which is more than it was scoped as,
and why the crate extraction §10 designs is no longer the way to get what §10 wanted.

Build order, revised: ~~phase 0~~ → ~~§2-§6 (persistence and undo)~~ → ~~§7/§8 (requeue and grid
tiles)~~ → ~~§10 (crate extraction)~~.

**What §7 and §8 became, in the tree.** Both were smaller than written, because the render rework
had already done their hard halves:

- A job carries `exposure` as a *gain* (`2^EV`), converted once in `processing_service` on the way
  in - the uniform is a multiplier and the document is stops, and converting in two places is how
  they come to disagree. `job.rs` refuses a non-positive gain rather than clamping, because that
  can only arrive by a caller sending stops where a multiplier belongs and grading the library
  black is a worse answer than saying so.
- The batch path reads the document off a `LEFT JOIN` on the pending query, so a thousand-photo
  batch is one query and not a thousand. The one-off path - which is what a `max` export takes -
  reads it through a defaulted seam, so the rendition a reader asks for by name is not the one
  that ignores their edits.
- A write requeues both stages and kicks a drain, fire-and-forget, but only when the revision
  moved: a no-op save or an undo at the start of the history rebuilds nothing. `processUnprocessed`
  widens an in-flight run rather than starting a second, so twenty slider releases are one batch.
- The renditions job now carries a `grid` target beside `full`, so the tile is rebuilt from the
  render rather than staying the camera's JPEG. The tile is stamped *twice* per photo by design -
  once at the JPEG's pace so the grid fills, once from the render - and the second stamp is what
  makes a client re-fetch it.

`libraries.grid_hdr` from §8 is deliberately not built: it is a toggle that defaults off, and the
SDR/HDR merge means an HDR tile is now an output-stage argument rather than a pipeline. Add it
when someone wants it.

Everything from §0 to §0.3 is kept as the record of how phase 0 was argued and priced. It is
written in the present tense about a tree that no longer exists; §0.4 is the correction.

The three probes it cites - `filter_domain_delta`, `sdr_vs_hdr`, `denoise_before_warp` - were
deleted with phase 0 rather than carried. Each asked something this now answers, and each was
written against the pipeline that had two of everything: there is no CPU grade to compare
against, no separate SDR path to price, and the filters no longer convert a domain at all.
Their numbers are quoted below and their code is at `ef8dade`.

## 0. Review outcome, 2026-08-06

Reviewed by four independent passes: citation fact-check, storage/undo design, GPU architecture,
and implementation gaps. §1-§6 survived with corrections, applied below. §7/§8/§10 did not.

**The two findings that reopen the GPU sections:**

1. **The tick's frame and the job's frame are not the same pixels.** `edit::prepare`
   (`native/rawshim/src/edit.rs:173-209`) materialises the lens warp and then filters in PQ
   *before* any grade. `hdr::graded` (`hdr.rs:302-334`) fuses the warp *inside*
   `tone::grade_owned` (`tone.rs:247-283`) and filters *after* it (`hdr.rs:588-589`). So the
   crate cannot simply run over the job's frame: the warp must be materialised first - a full
   extra ~366MB at 61MP, which is exactly the intermediate the fusion exists to avoid
   (`hdr_fit.rs:2180-2182`) - the scene peak changes because `grade_owned` deliberately peaks the
   *unwarped* source (`tone.rs:242-246`), and the filters end up on opposite sides of the grade in
   the two hosts. That last one means the editor would still not show what the export contains,
   which is the failure §10 exists to prevent.
2. **The SDR rendition path has no grade to replace.** `tone.rs`'s grade is reached only through
   `hdr::encode_still` (`job.rs:373`), i.e. only when `target.hdr`. SDR renditions are an 8-bit
   decode plus `fit::apply` plus `image::finish` (`job.rs:271-330`), and a default library is
   `rendition_source: 'embedded'` (`src/schemas/libraries.ts:43-44`) so it renders nothing at all.
   As written, an exposure edit would show in the editor and appear in no rendition for most
   libraries.
   **Resolved by §0.2.2**: the separate SDR implementation is deleted rather than taught about
   edits, so there is one grade and it is on every rendered path. What remains of this finding is
   only the embedded-source case, priced above at 124ms to ~1.7s.

**Priced, since finding 2's fix turns on it.** `sdr_vs_hdr` (deleted with phase 0; at `ef8dade`) runs a whole
`job::run` both ways at the shipped settings (`full_rendition_quantizer` 13, `hdr_crf` 10, and
`hdr_preset` 8, which `processing_service.target` hands to *both* paths), 3840px on the Sony
fixture, medians of three:

| | SDR | HDR |
| --- | --- | --- |
| whole job | 1805ms | 1722ms |
| decode alone | 442ms | 361ms |

**An HDR rendition costs the same as an SDR one**, marginally less. Where the time goes at
2566x3840: `image::finish` 648ms, the camera fit 431ms, the decode ~400ms, the grade 106ms,
`encode_pq` 24ms. So the HDR-only stages are ~130ms of a 1.7s job - 7% - and everything expensive
is shared.

Two intuitions the measurement refuses. `image::finish` is not cheaper on 8-bit samples: 667ms on
u8 against 648ms on u16. `job.rs`'s reason for the 8-bit SDR decode is *memory*, not speed, and
that claim stands. And the SDR path has no speed advantage to trade away at all.

**So the gains attributed to SDR are not SDR's**; they belong to the embedded-JPEG source - DESIGN
§10.4's stage B at 124ms against a render's ~1.5s, a 12x gap that is `rendition_source` and has
nothing to do with dynamic range. Which prices finding 2's fix exactly: forcing an edited photo to
render costs **124ms to ~1.7s**, and taking the HDR path while there is free.

(An earlier run of this benchmark reported HDR at 4.9x SDR. That was a benchmark error - a
`preset: 0`, which is libavif's *slowest* speed and where 10-bit encoding dominates everything -
not a property of the pipeline.)

**Decided: (b).** `prepare` and the job are reconciled onto one frame definition first, as its own
phase, before any crate is extracted. The alternatives were (a) forcing edited photos onto the
scene-linear HDR path regardless of library settings, and (c) sharing the edit stage alone and
leaving the grade duplicated; (b) was chosen to remove the duplication in one go rather than build
on top of it.

Re-reading the two paths directly narrows the work considerably from what the review implied - see
§0.1.

**Corrections applied to §1-§6 from the same review:** the delta shape (one path per delta could
not express a multi-field commit, so an XMP import would take ten undos), the missing transaction
between the two tables, `PUT`'s lost-update hole, `version: z.literal(1)` not actually giving
migrate-on-read, the `at` field nothing reads, `cursor` welded to the largest blob, and
`temperature` nullable while `tint` is not.

### 0.1 What reconciliation actually costs, having read both paths

Three of the four divergences the review named are not divergences.

- **`levels` already match.** Both call `hdr::prepare`, which takes `tone::levels` from
  `source.samples` before any resize and before any warp (`hdr.rs:271`). The editor passes
  `fit_to: None` and the job `Some(target_size)`, but the anchor is measured on the source either
  way - deliberately, per the comment at `hdr.rs:268-270`. So `white` and `peak` derive
  identically today.
- **`fit_to` is a parameter, not a conflict.** The editor decodes to `long_edge` and does not
  resize; the job decodes large and resizes. Same function, different argument.
- **The warp is already picture-equivalent.** `image::apply_u16` is `map_u16` with the identity
  sampler, so the editor's materialise-then-grade and the job's fuse-into-grade produce the same
  pixels. Which one a host picks is a memory-versus-recompute tradeoff - materialise once for a
  host that re-grades per tick, fuse for a host that grades once - and it stays a parameter of the
  shared entry point rather than something to unify.

**The one real divergence is the filter, and it is a difference of signal, not just of order.**

- The job runs `tone::encode_pq` then `image::finish` (`hdr.rs:588-589`) - filtering the *fully
  graded* PQ picture, tone curve, matrix, chroma and roll-off included.
- The editor runs `filter_once` (`edit.rs:285-323`), which takes
  `pq(sample * reference_white_nits / levels.white)` - a plain exposure normalisation into PQ,
  with no grade in it - filters that, and inverts back to scene-linear.

Same functions on both sides (`image::measurements` + `image::finish_with`, which is what
`image::finish` wraps), different input. And `measurements` derives sigma *from the data*, so the
denoise radius and the sharpen strength are computed against two different pictures. The editor
and the export are filtering differently, which is the DESIGN §21.1 failure class exactly.

**Which side moves is already settled in the tree.** `hdr.rs:582-587` argues the post-grade
position on the merits: a difference against a blur "taken in linear light follows absolute
luminance rather than what the eye reads", and the grade-to-encode gap is where such a stage
belongs. DESIGN §10.9 line 2033 states it generally - the guided filter's `eps`, the single global
measured noise sigma, the coarse chroma pass's 2%-of-full-scale cap and the deconvolution's
anti-ringing range are all thresholds on differences, and only have one meaning in a
perceptually-uniform bounded domain. `edit.rs:206` offers only "Filtered here, so a tick is the
grade alone" - which reads as a tick-cost compromise. **§0.2.1 revises this**: the requirement
§10.9 states is a *perceptual* domain, not the grade's output, and the editor's normalised PQ is
one. The editor's position was also measured rather than assumed (`88d84eb`) and bought a 43x
per-tick win (`0ef4487`). So the job moves, not the editor.

### 0.2 Measured: the divergence is visible, and it is not recoverable after the fact

`filter_domain_delta` (deleted with phase 0; at `ef8dade`) runs one decode and one camera match through all
three candidate domains - linear, the editor's exposure-normalised PQ, the job's graded PQ -
with the lens warp left out so the only variable is where `finish` ran, and compares the resulting
PQ frames in ΔE ITP (BT.2124, where 1.0 is nominally the threshold of visibility). Both LFS
fixtures, all four strengths at 1.0, 1600px long edge:

| N normalised-PQ vs G graded-PQ | Sony ARW | Canon CR3 |
| --- | --- | --- |
| mean ΔE ITP | 1.080 | 1.288 |
| p95 / p99 | 3.31 / 5.74 | 3.99 / 6.34 |
| share of pixels over 1.0 | 33.9% | 42.7% |
| **after an ideal 1D curve in I** | **1.076** | **1.288** |
| after ideal per-level I+Ct+Cp | 1.015 | 1.240 |

**Visible.** The mean pixel sits at or above the visibility threshold and a third to a half of the
frame is over it. This is not a rounding difference between two orders; the editor misrepresents
what the export contains.

**Not recoverable.** The two correction rows are *upper bounds*, not attempts: each subtracts the
exact per-level mean computed from the answer itself, so nothing shippable can beat them. An ideal
1D curve in I removes 0.4% of the error on one fixture and none at all on the other. An ideal
per-level correction of all three channels removes 4-6%, and on the Canon it *raises* the share of
pixels over threshold (42.7% to 43.7%) while lowering the mean - the signature of fitting a
structure that is not indexed by level. Which it is not: the divergence is the two filters making
different noise-versus-structure decisions per neighbourhood, so it is per-pixel and depends on
local context. No curve applied afterwards can address it, by construction. **Phase 0 has to
actually unify the domain; there is no cheap offset.**

**And linear is the worst of the three**, which settles the one open argument against §10.9. A
Richardson-Lucy deconvolution inverts a point spread, and the point spread here is the resample's,
which happens in linear light inside `hdr::prepare` - so there is a physical case for filtering
there. The measurement refuses it: L vs G is mean 2.03 (Sony) and 3.99 (Canon), two to four times
further from graded PQ than the editor's normalised PQ is, with a p95 of 15.9 on the Canon. So
graded PQ is the target and the physics argument loses on the numbers.

Caveats worth carrying: two frames, one strength setting, and a 1600px long edge rather than a
rendition's native size - so this establishes the *shape* of the answer rather than a constant.
The probe takes a path and a long edge as arguments, and separating the denoise's contribution
from the sharpen's is a matter of zeroing strengths.

**One route considered and rejected: making the filter a per-tick GPU stage.** raw-edit-gpu.md §5
rates `finish` "Yes, guided filters + Richardson-Lucy are classic image kernels" and "**Yes**,
dominates settle", and §6's per-tick design is written as "dispatch **grade → PQ → finish** over
resident textures" - so the note's original plan was the job's order, running per tick.

That plan did not survive contact. §0 of the same note records it as one of four things the note
got wrong: "`image::finish` is not a per-tick stage. It runs once, at the open, in the PQ domain
(`edit::filter_once`). A tick is the grade alone." `filter_once` is the *correction*, not a
deviation from the plan - and §0.2.1 below has the measurements behind it. Reinstating the per-tick
version would undo a 645ms-to-15ms result and re-add a client `finish` port that was deliberately
deleted. §5's observation that `finish` is a *shared* stage still stands, but it argues for one
implementation rather than for that one.

### 0.2.1 Correction: there are three arrangements, and the history matters

An earlier draft of §0.3 described the HDR still's order as though it were the only one. It is not,
and DESIGN §10.9 leads with a different one:

| path | defringe + denoise | sharpen |
| --- | --- | --- |
| SDR render (`job.rs:324`, `render_base:196-203`) | before the fit, on the 8-bit decode | after the warp, alone |
| HDR still (`hdr.rs:588-589`) | after the transfer | after the transfer |
| Editor (`edit.rs:285-323`) | at open, normalised PQ | at open, normalised PQ |

The SDR split is measured (§10.9 line 2013-2015): the denoise runs before the fit because a colour
transform fitted against a frame the denoise then cleans is calibrated on colour that will not
exist - 22% of mean chroma - and the sharpen runs last because it deconvolves *the resample's*
blur and ahead of the warp would invert a point spread not yet applied. The HDR arrangement is
§10.9's own "compromise" (line 2024), taken because its warp is in scene-linear and there is no
display-referred slot ahead of it.

**And the editor's position was measured, not inherited.** Two commits:

- `88d84eb test(raw-edit): denoise before the grade, and measure whether it survives` probed the
  same three domains as §0.2. Linear was catastrophic - 4247 counts of 65535 out in the shadows,
  shadow texture flattened forty-fold, "because in linear light shadow noise sits far below an eps
  set by the bright end of the frame". Normalised PQ tracked what ships: mid-tones, 29.5M of 29.6M
  samples, within 20 counts; grain within a few percent at +2, 0 and -2 EV.
- `0ef4487 feat(raw-edit): filter once at open, in PQ, and let a tick be the grade alone` took
  **645ms to 15ms at 9.9MP** and deleted the client's whole `finish` port - the guided filters, the
  deconvolution, the plane algebra.

**§0.2's framing was too strong.** "Visibly misrepresenting the export" does not survive next to
`88d84eb`. The two measurements agree once read carefully: §0.2's p50 is 0.70 and 0.83 ΔE ITP, so
the *median* pixel is under threshold, and the mean is carried by a tail `88d84eb` also saw and
named. A real divergence worth removing; not one a reader would point at.

**So phase 0 should move the job, not the editor.** As first written it moved the editor to the
post-grade order, which undoes a deliberate 43x per-tick win and re-adds a port that was
explicitly deleted. §10.9's requirement is a *perceptual* domain, and `88d84eb` makes the point
directly - "the filter never needed the *grade's* output, it needed a perceptual domain".
Normalised PQ is one. So: move `encode_still`'s `finish` to pre-grade normalised PQ and delete the
post-transfer call. No per-tick cost, no GPU `finish`, the editor untouched and authoritative.

The costs to accept: every existing HDR rendition changes and wants rebuilding, and the filter
constants want re-checking in the new domain - though §10.9 line 2037 already concedes they were
tuned on an sRGB rendition and that "nobody has measured whether they are the right ones" for PQ.
Still open is whether the HDR path should also adopt the SDR split (denoise before the fit,
sharpen after the warp), which is the arrangement §10.9 argues for on measurement and which
neither the job nor the editor currently uses.

### 0.2.2 Decided: one internal pipeline, and SDR becomes an output stage

There is no second implementation. Everything internal is 16-bit scene-linear through the grade;
**SDR versus HDR is only the final transfer and the bit depth of the buffer that leaves.**

Both standing objections to this were measured and neither survives:

| 3840px, Sony fixture | SDR path | HDR path |
| --- | --- | --- |
| whole job | 1805ms | **1722ms** |
| peak RSS | 376MB | **341MB** |

The HDR path is cheaper on both. Memory was the one with a stated reason in the code - `job.rs`
keeps the SDR decode 8-bit because "a 16-bit decode would be twice the memory for samples it
discards" - and that is true of the decode buffer in isolation and false of the job, because the
HDR path already fits during the decode (DESIGN §10.1 line 1227: "`box_resize_u16` then finds the
frame already at size and declines - the intermediate simply never exists"). The SDR path never
got that optimisation. Peak RSS is what `processing_concurrency` multiplies, so it is the number
that mattered.

**What goes.** The 8-bit decode branch and the whole `renders_sdr` arm of `job::run`;
`render_base`; `fit::apply` and `fit::Profile` as a rendering path - their only production callers
are that arm and `lib.rs::fit_profile_for`. `fit.rs` itself stays: it still owns the geometry fit
and `n76`, both of which `hdr_fit` depends on.

**What it needs is small**, because the grade is already parameterised by the thing that differs.
`grade_owned` rolls off to `peak_nits` and normalises by it, so an SDR render is the same call with
the peak at SDR white, followed by the sRGB OETF and an 8-bit pack instead of `tone::encode_pq`.
One new output stage, not a new path.

**What it also buys:** a photo that needs both an SDR and an HDR rendition currently fits twice, at
431ms each. Unified, it fits once.

**What stays untouched:** the embedded-JPEG grid tile. That is a different *source*, not a
different pipeline, and it is where the real speed difference lives anyway (§10.4 stage B, 124ms).

**The one open risk, and it is a colour question rather than a cost one.** SDR renditions would
take their colour from the HDR fit tone-mapped down, rather than from `fit::Profile`. DESIGN
§10.8.1 exists precisely to make the HDR look match the SDR one, so the two should already agree -
but "should" is the word that has cost this plan twice already. Check it in `n76` against the
camera's own JPEG, on both fixtures, before deleting anything.

**And it collapses phase 0's question into this one.** One pipeline means one filter arrangement,
so the choice in §0.2.1 stops being "which of two hosts moves" and becomes "which arrangement does
the single pipeline use". §10.9's SDR split - denoise before the fit, sharpen after the warp - is
the one with measurements behind it (22% of mean chroma if the fit sees an un-denoised frame), and
it is the one neither current path uses. Adopting it is now on the table in a way it was not when
the SDR path was going to keep it regardless.

### 0.2.3 Measured: the denoise belongs before the geometric warp

The argument: noise is generated at the sensor and so is spatially uniform in sensor space; the
lens warp resamples non-uniformly by radius, which breaks that; and `image::finish` then measures
**one global median** (`measure_noise`) and applies one sigma everywhere - an estimator for a
uniform field, applied to one the warp has made non-uniform. Both current paths denoise after the
warp: the job fuses it into `grade_owned` and filters after `encode_pq`, and the editor
materialises it in `edit::prepare` and then runs `filter_once`.

`denoise_before_warp` (deleted with phase 0; at `ef8dade`) tests it on a synthetic flat field carrying
spatially uniform noise, because on a real frame the radial profile is mostly *scene* - a subject
in the middle reads as "noise" to any high-pass, and a first attempt at this measured the
composition rather than the grain. With no content there is nothing to confound it, so any radial
structure in the residual is the warp's doing. Median absolute high-pass on luma, per radial band,
denoise only (the sharpen has its own reason to sit after the warp):

| | centre | mid | corner | corner/centre |
| --- | --- | --- | --- | --- |
| input | 69.8 | 69.7 | 69.7 | 1.00x |
| after the warp alone | 63.2 | 47.4 | 48.0 | **0.76x** |
| A, warp then denoise | 18.5 | 10.6 | 10.9 | **0.59x** |
| B, denoise then warp | 12.0 | 8.8 | 9.0 | **0.75x** |

**The warp destroys uniformity** - 1.00 to 0.76 - which is the claim, measured. **Denoising after
it compounds that** to 0.59, because one global sigma over-denoises the radii where the resample
has already suppressed noise. **Denoising first adds no further non-uniformity** (0.75, the warp's
own) and removes more noise overall, 12.0 against 18.5 in the centre.

So the denoise moves ahead of the warp in the unified pipeline. Two things to keep honest about
it. The picture difference on a real frame is modest - A against B is mean ΔE ITP 0.360 and p50
0.189, under the visibility threshold for most pixels, with a p95 of 1.34 - so this is a
correctness fix to the estimator rather than a visible transformation. And B does not make noise
uniform; it stops the denoise making it worse. Genuinely uniform noise after a warp would need a
spatially varying sigma, which is a larger change than this and not proposed.

**This agrees with the arrangement DESIGN §10.9 already argues for.** The SDR path denoises before
the fit and the warp, and §10.9's case for that is the fit's, not the noise's - so the two
arguments are independent and land in the same place. That settles §0.2.2's closing question:
the unified pipeline takes the SDR split.

### 0.3 The HDR still's order today, in full

The HDR still path as it runs today (`job.rs:335-373` into `hdr::encode_still`). Read it with
§0.2.1: this is one of three arrangements in the tree and it is the one §10.9 calls a compromise,
so stage 8's position is what phase 0 changes rather than what it standardises on.

Once per job:

1. **LibRaw decode** to 16-bit scene-linear Rec.2020, fitted to the largest HDR target's long edge
   (`decode_frame(path, 16, true, hdr_size)`, `job.rs:336`).
2. **Camera match** against the embedded JPEG - `hdr::fit_all` - giving `HdrMatch { colour, lens }`.

Per HDR target, in `encode_still` (`hdr.rs:566`):

3. `hdr_args::target_size` for this target's output dimensions.
4. **`hdr::prepare`** (`hdr.rs:267`):
   a. `tone::levels(source.samples, quantile)` - diffuse white and scene peak, taken on the
      *original, unresized* decode. Deliberate (`hdr.rs:268-270`): both ends are quantiles over a
      fixed sample count, so the anchor does not move with resolution.
   b. `image::box_resize_u16` to the target size, **in linear light**. Fit before grading
      (`hdr.rs:273-278`), so a 61MP frame is not tone-mapped in full to produce a 3840px file.
5. **`PlanarWarp::for_lens`** - build the lens gather without applying it.
6. **`grade_prepared_owned` -> `tone::grade_owned`** (`tone.rs:247`): one sweep with the warp fused
   into the colour transform. `lens.map_u16` gathers the warped sample, then per pixel
   `MatchedGrade::pixel` (`tone.rs:430`) runs (i) the fitted per-channel tone curves, exposure
   folded into the LUT, (ii) the 3x3 matrix, (iii) the chroma lattice via `finish_chroma`, or a
   saturation scalar where there is no lattice, (iv) the roll-off to display peak through the
   `roll` EETF table, normalised by `peak_nits`. With no match, a single shared hue-preserving
   LUT plus EETF.
7. **`tone::encode_pq`** (`hdr.rs:588`): display-referred linear to PQ.
8. **`image::finish`** (`hdr.rs:589`): the noise sigma is measured once over the whole frame before
   anything is filtered (`image.rs:1511-1516`), so strips cannot seam, then four stages in fixed
   order per DESIGN §10.9 - defringe, luma denoise, chroma denoise, sharpen.
9. **`encode_frame`** to libavif.

The editor's half differs only in 1-5: it decodes at `long_edge` with `fit_to: None` and
materialises the warp, so it can re-grade per tick without re-warping - which §0.1 establishes is
the same picture as fusing.

**None of this is the SDR path**, which is an 8-bit decode plus `fit::apply` plus `image::finish`
(`job.rs:271-330`) and never reaches `tone.rs`'s grade at all. That is §0's second finding and it
is still open.

**So phase 0 is** (revised by §0.2.1, which reverses the direction): move `hdr::encode_still`'s
`finish` from after the transfer to before the grade, in the same exposure-normalised PQ
`edit::filter_once` already uses, and delete the post-transfer call. The editor is left alone and
becomes the authoritative order. An earlier draft had this the other way round - porting `finish`
to WGSL and running it per tick - which would have undone `0ef4487`'s measured 645ms-to-15ms win
and re-added a client `finish` port that commit deliberately deleted.

The tick is unchanged by this, so there is no new per-tick budget to measure and
`image::measurements` stays exactly where it is - a CPU pass at open, on the one signal both hosts
now filter. What the job loses is the ability to filter each target at its own output size, since
the filter now runs once on the prepared frame ahead of the per-target grade; whether that matters
is a measurement, not an assumption, and §10.9 line 2037 already flags that the sharpen's point
spread is justified by a resample the `max` rendition never had.

Two risks worth stating. Every existing HDR rendition changes, so a library wants rebuilding - and
the filter constants were tuned on an sRGB rendition (§10.9 line 2037 concedes "nobody has
measured whether they are the right ones" in PQ), so moving domains is the moment to check them
rather than carry them across untested. And `gpu_fixture.rs` pins `grade_prepared` alone, so the
fixtures have to grow to cover the new order before the move, not after.

### 0.4 What phase 0 became, and what it does to §10

Phase 0 landed, and went past its brief. §0.1 through §0.3 scoped it as "move `encode_still`'s
`finish` to pre-grade normalised PQ". What shipped is that plus three things that were listed as
open questions or as later phases:

- **One pipeline, SDR an output stage** (§0.2.2 as written). `job::Target::output` is `pq` or
  `srgb`; there is one decode, one fit, one filter, one grade, and the two differ by the peak the
  roll-off targets and the transfer at the end. `render_base`, the 8-bit decode arm and
  `fit::apply` as a rendering path are gone.
- **The §10.9 split adopted** (§0.2.2 left this "on the table"; §0.2.3 measured it). Denoise and
  defringe before the geometric warp, sharpen after it.
- **The domain question dissolved rather than answered.** §0.1's "which host moves" assumed a
  buffer that stages convert into and out of. The base is now *coded once* into normalised PQ
  immediately after `tone::levels` reads the anchor (`tone::encode_base`), and every stage from
  there to the shader is pointwise on what the buffer holds - both filter passes, the fit-to-size,
  the warp, the downscale. There is no per-stage domain left to disagree about. `image::Coding`,
  the trait that carried the conversion, is deleted.

**And the grade is one implementation, not two.** §10.0 closes by saying the crate "does not reduce
this to one implementation... two implementations before, two after", citing `prelude.wgsl:3-5` and
§7's test-only twin. That is no longer true, and it is the single most important correction on this
page. `tone.rs`'s grade - `grade_owned`, `MatchedGrade::pixel`, `roll`, `eetf`, `encode_pq`,
`encode_srgb8` - is deleted. The WGSL is the only one there is.

**Which was §10's whole purpose, reached by a route §10 did not consider.** §10 designs a
`native/tick/` crate compiled twice, wgpu-on-wasm holding the canvas, `draw_to_surface` and
`encode_to_buffer`, a reversal of `559fe88`, and ~189KB of wasm in the page. None of that was
built and none of it is needed:

> The `.wgsl` files stay in `web/src/features/raw_edit/gpu/wgsl/`. The page imports them as it
> always did. `native/rawshim/src/gpu.rs` `include_str!`s **the same files** and runs them through
> wgpu natively. Two thin hosts over one source, rather than one host compiled twice.

The page keeps its TypeScript host; Rust has its own, ~900 lines. What §10.1 lists as "moves into
the crate" stays where it is on both sides, and what §10.1.1 lists as "things the port must
preserve" became a *parity* checklist between two hosts rather than a porting one - which is what
`fixtures/gpu/` and `peak-sampling.txt` exist to hold.

So **§10, §10.0 and §10.1 are superseded**: read them for the reasoning, not the plan. §10.1.1 is
still live and still correct. §10.2 is not superseded and has become *harder*: see below.

**§10.2 is now a deployment blocker rather than a preparation.** `job::run` returns an error naming
the missing driver where no adapter of any kind answers - there is no CPU grade to fall back to,
by design. So the container needs `/dev/dri` passed through, `mesa-vulkan-drivers` installed, and
the `dev` stage's Mesa purge undone, or **renditions do not build at all**. That is the one item
from §10 that must land before this feature ships, and it is unstarted.

**What a reader picking up §2-§8 needs to know about the tree:**

- The job runs the editor's shaders already. §7's "the job has to know" is a `Job` field and a
  worker read; the hard half it was waiting on is done.
- `job::Target` already carries `grid` alongside `full`/`max` and one job can hold both, which is
  most of §8's "the render job gains a `grid` target". `runOneOff` stamps per target.
- §7's note that `tone.rs`'s grade "must not be deleted along with its caller, it becomes a
  test-only twin" is void - it was deleted, and `gpu_fixture.rs` now rebuilds its baselines from
  the shader under `BOWERBIRD_WRITE_FIXTURES`. `pin.rs` says what that costs.
- The prepared frame that crosses to the client is normalised PQ, not scene-linear levels.
  `PreparedHeader` is otherwise unchanged.
- §7's readback figure is now half: `encode` packs two `u16` components to a word, so 61MP is
  ~366MB rather than ~732MB.

## 1. What exists today

The editor is `web/src/features/raw_edit/`. `RawEditPresenter.open` fetches a prepared frame
from `GET /api/image/:id/prepared` (`rawshim_edit.prepareEditAsync`, seconds of LibRaw on a
thread the native side owns), hands it to `TickPipeline`, and every slider move after that is a
uniform write and a dispatch chain over a buffer that never leaves the GPU. The only edit is
`exposureEv`. It is *declared* in `tick.wgsl` - 50 lines holding `struct Tick` and two helpers,
with no arithmetic in it - and *applied* in `colour.wgsl:88-89` and `:145-146`. `colour.wgsl` is
where a new slider's math goes.

Nothing is written anywhere. Closing the page loses the edit, and the stored renditions - built by
`rawshim_job.runJob` from the RAW plus *app*-wide denoise/sharpen/grade settings (they live in
`settingsRepo`, read at `image_api.ts:140-158`; only `rendition_source` and `rendition_hdr` are
per-library) - have never heard of it.

Two facts shape everything below:

- **The prepare is edit-independent.** `EditRequest` carries `longEdge`, `grade` and
  `strengths`, all of which are library or app settings. Per-photo edits are a tick concern, so
  `prepareEditAsync` and its in-flight dedup key are untouched by this work.
- **The rendition job is not.** Applying edits to a stored rendition means the job has to run the
  editor's own shaders, which is §10 and the only genuinely hard part. Not a second
  implementation of the math - the same WGSL, hosted by wgpu instead of by the page.

## 2. Storage

Two tables in the catalogue database. No sidecars.

```sql
-- The current state of one photo's edits, plus the two small values that change
-- on every undo. Every read that matters - the editor's open, the rendition job -
-- wants this row and only this row.
CREATE TABLE IF NOT EXISTS photo_edits (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  doc        TEXT NOT NULL,      -- EditDocSchema, JSON
  -- How far into photo_edit_history.deltas the undo cursor stands. Entries beyond
  -- it are the redo tail, dropped only when a new edit lands. Here rather than
  -- beside the deltas because an undo moves the cursor and the doc and touches
  -- neither the array nor its overflow pages: welded to the blob, moving one
  -- integer would rewrite ~36KB.
  cursor     INTEGER NOT NULL,
  -- Bumped by every write. Returned by GET and required by PUT/undo/redo, which
  -- is what stops two tabs silently reverting each other and forging history
  -- entries for changes nobody made.
  rev        INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- One photo's whole undo stack, as a JSON array of deltas. A row per delta would
-- have been ~72 bytes of repeated UUID per step, in the table and again in the
-- index, for a key nothing ever queries by: a single step is never read without
-- the rest of its history, because undo walks the array.
CREATE TABLE IF NOT EXISTS photo_edit_history (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  -- [{ from: Partial<EditDoc>, to: Partial<EditDoc> }, ...], oldest first. A
  -- *set* of fields per entry, not one path: a commit routinely moves several at
  -- once - an XMP import writes ten, a crop drag four - and one-path deltas would
  -- turn each of those into ten or four separate undos through states the picture
  -- was never in. Partial docs rather than a path list because they need no
  -- set-by-path helper, which nested crop fields would otherwise force.
  deltas     TEXT NOT NULL
) WITHOUT ROWID;
```

`WITHOUT ROWID` on both: a `TEXT PRIMARY KEY` on an ordinary table is *not* the rowid - SQLite
aliases only `INTEGER PRIMARY KEY` - so every read would be an index descent plus a rowid-tree
descent. These tables are small rows reached only by the whole key, which is the shape it is for.

**Why two tables**, given the 1:1 cardinality. Not the overflow-page argument an earlier draft
gave, which was wrong: SQLite keeps a minimum local payload of ~489 bytes in the leaf cell and
decodes columns in order, so a `doc` sitting before `deltas` in one row would rarely follow the
chain anyway. The real reasons are leaf-page density - many small `photo_edits` rows per page
against ~1.4KB of local payload each if merged - and not rewriting a 36KB record when only the doc
moved.

**Both tables are written under one `db.transaction`.** Nothing detects a desync between them:
undo blindly assigns `deltas[cursor-1].from` rather than checking the doc equals `to`, so a crash
or a `busy_timeout` expiry between the two writes leaves a doc the history cannot explain and a
value the user was looking at permanently unreachable. The repo already uses this idiom
(`shoots_repository.ts:89`, `albums_repository.ts:72`).

**And the invariant that makes the history true: every writer of `photo_edits.doc` goes through
commit.** XMP import, paste-settings, a future "reset all" - a direct doc write is the one bug
this schema cannot detect.

Both cascade from `photos`, so a hard delete takes the edits with it. A **soft** delete does
not, which is correct: a photo restored from the Bin comes back edited, and a photo whose file
moved keeps its edits because move detection preserves `photos.id`.

Nothing is written for an unedited photo, so an untouched library pays nothing.

## 3. Scale

The question was 100k photos with 500 edits each.

The doc read - the one on every hot path - is one primary-key seek at any table size, and never
touches the history. The *history* read is a seek plus an overflow chain plus a ~23KB
`JSON.parse`, and a commit is that plus a full re-serialise; "all the same single-row read" is
true in the sense that undo, redo and a full history listing are all equally expensive, not in the
sense that any of them is cheap. Only undo and redo pay it.

Disk, measured rather than estimated. A single-field delta serialises at ~45 bytes
(`{"from":{"exposure":-0.35},"to":{"exposure":0.7}}`); an earlier draft carried an `at` timestamp
too, which was 31 of a claimed 60 bytes and which nothing in §5 or §6 ever reads, so it is gone.

| | 500 deltas on every one of 100k photos | realistic: 20k photos, ~30 deltas |
| --- | --- | --- |
| `photo_edit_history` | ~2.3 GB | ~27 MB |
| `photo_edits` | ~70 MB | ~14 MB |

Note the cap below is 1000, not 500, so the true worst case is twice the first column. The
row-per-delta alternative would have been ~10 GB for the same content, a third of it UUIDs.

**The ceiling this shape has, named:** a commit is a read-modify-write of the whole blob, so it
is O(history) per slider release rather than O(1). At 500 deltas that is a 30KB parse and a 30KB
write, which is nothing. It stops being nothing somewhere in the tens of thousands. So the
history is capped - `MAX_EDIT_HISTORY`, oldest dropped from the front once the cap is reached -
which bounds both the blob and the per-commit cost with one `slice`. Start it at 1000. If a
photo ever genuinely needs unbounded history, that is the point to go back to rows per delta,
keyed by an INTEGER surrogate rather than the UUID.

## 4. The edit document

`src/schemas/photo_edits.ts`, alongside the other Zod schemas. Sketch:

```ts
export const EditDocSchema = z.object({
  // A number with a default, not z.literal(1). A literal *rejects* a doc from a
  // newer build before anything can read its version and dispatch a migration -
  // which is the whole of what "migrate on read" needs. Defaults only rescue
  // missing fields, i.e. exactly the case where the version would not have moved,
  // so the two mechanisms cover disjoint cases and do not combine.
  version: z.number().int().default(1),
  // EV, and the same EV crs:Exposure2012 means.
  exposure: z.number().min(-5).max(5).default(0),
  contrast: z.number().min(-100).max(100).default(0),
  highlights: z.number().min(-100).max(100).default(0),
  shadows: z.number().min(-100).max(100).default(0),
  whites: z.number().min(-100).max(100).default(0),
  blacks: z.number().min(-100).max(100).default(0),
  vibrance: z.number().min(-100).max(100).default(0),
  // `saturation` deliberately not at top level: `Tick.saturation` already exists
  // and is the camera match's own fit multiplier around 1.0 (`colour.wgsl:119`),
  // not a user slider. A doc field of the same name would read as the same thing.
  saturationAdjust: z.number().min(-100).max(100).default(0),
  // One field, because as-shot white balance is a *pair*. Null temperature with a
  // zero tint would open a tungsten frame at its as-shot Kelvin and a forced
  // neutral tint, i.e. a green cast against what the camera and every other app
  // show - and there would be no way to say "as shot" at all.
  whiteBalance: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('asShot') }),
      z.object({
        kind: z.literal('custom'),
        temperature: z.number().min(1500).max(50000),
        tint: z.number().min(-150).max(150),
      }),
    ])
    .default({ kind: 'asShot' }),
});
export type EditDoc = z.infer<typeof EditDocSchema>;
```

`.loose()` or an explicit `.catchall`, not zod's stripping default: a doc written by a newer build
and round-tripped through an older one would otherwise come back with its unknown fields silently
deleted - data loss with nothing raised. And `migrate(raw: unknown): unknown` runs before the
parse, not inside it; the schema has no way to express a version chain.

**What v1 actually implements: `exposure`, and nothing else.** The other fields exist in the doc
at their neutral defaults so the format does not change under the first real slider, but the
shader has one edit today and this spec does not specify nine more. Two of them are not uniform
tweaks at all: `whiteBalance` sits *behind* the camera-match fit - the prepared frame arrives
through a chroma lattice and matrix already fitted at the shot white balance (`fit.rs`,
`hdr_fit.rs`), so moving it is prepare-time work, which contradicts §1's "the prepare is
edit-independent". Each new parameter needs its own note saying what it does to a pixel and where
it composes in `colour.wgsl`'s chain; none of that is written yet.

One correction an implementer would otherwise hit immediately: the doc's `exposure` is EV, the
uniform is **not**. `writeUniform({ exposure: 2 ** ev })` (`tick_pipeline.ts:523`), and
`colour.wgsl:88` branches on `== 1.0`. The doc value is converted, not copied.

Three properties, all load-bearing:

**Ranges are Camera Raw's ranges.** Not because we are cloning Lightroom, but because XMP import
is a stated requirement and the choice of units is what decides whether `crsToDoc()` is a table
of field names or a table of magic constants. `crs:Exposure2012` is already EV;
`crs:Contrast2012` is already -100..100. Normalising to -1..1 would buy nothing and put a fudge
factor on every line of the importer.

**A JSON blob, not columns.** A mature edit model is a hundred-odd parameters and gains a few
every release; a column per slider is a migration per slider, and `photos` is already wide.

**`version` plus migrate-on-read.** The doc outlives the schema that wrote it. Parse with the
current schema, and where a stored `version` is older, run it through a migration before
parsing. `.default()` on every field means a doc written before a parameter existed reads as
that parameter's neutral value, which is what non-destructive editing requires.

XMP import is then one pure function - `crsToDoc(crs: Record<string, string>): EditDoc` - with no
RAW, no GPU and no database in its tests. The units check out for the fields named above:
`crs:Exposure2012` is EV in -5..+5, the `*2012` tone and colour fields are -100..+100, `crs:Tint`
is -150..+150. Four things stop it being a pure field table, and the importer has to handle each
rather than discover them:

- **`crs:Temperature` is Kelvin only for raw files.** For JPEG and TIFF sources ACR writes
  `crs:IncrementalTemperature`/`IncrementalTint` on a -100..+100 scale, which fed to a Kelvin
  field either fails `.min(1500)` or imports a 5 K white balance.
- **`crs:WhiteBalance`** (`"As Shot"` / `"Auto"` / `"Custom"`) is what decides which arm of
  `whiteBalance` to build.
- **`crs:ProcessVersion`.** The `*2012` fields only exist for PV2012 and later. An older sidecar
  carries `crs:Exposure` (-4..+4, different meaning), `crs:Brightness` and `crs:Contrast`
  (-50..+100). Either map them with stated constants or reject the sidecar explicitly.
- **Clamp on import, do not validate.** A strict `.min`/`.max` fails the whole doc over one
  out-of-range field, so a sidecar from a newer ACR takes the import down entirely.

## 5. Undo and redo

Per photo, over the one array.

- **Commit.** `deltas = deltas.slice(0, cursor)` drops the redo tail, push the new delta, cap to
  `MAX_EDIT_HISTORY` from the front, `cursor = deltas.length`, write the new doc. An empty diff
  writes nothing at all - otherwise the retry §6 advertises as harmless appends a no-op delta and
  the user's next undo does nothing visible.
- **Undo.** Merge `deltas[cursor - 1].from` into the doc, decrement the cursor. The array is
  untouched.
- **Redo.** Merge `deltas[cursor].to`, increment the cursor.

The cursor arithmetic was walked through the awkward sequences in review and holds: the cap cannot
desync it, because commit slices to `cursor` *before* capping and sets `cursor = deltas.length`
after, so the cursor is always at the end post-commit and neither undo nor redo resizes the array.
Truncating on undo instead would be one line shorter and would lose redo.

**A corrupt history must not take the editor down.** Nothing renders a picture from `deltas`, so
an unparseable array or a `cursor` outside `0..deltas.length` degrades to an empty history with
`canUndo`/`canRedo` false and the doc still opening. Same treatment `settings_repository.ts:45-54`
already gives a bad settings row, and free here precisely because the two tables are separate.

**Buffering.** The presenter already has the right seam: `previewExposure` runs per pointer
move, `settleExposure` runs on release. One commit per `settleExposure`, so a drag is one delta
rather than four hundred. `settleExposure` currently just forwards to `previewExposure`; it
becomes the thing that PUTs.

**Batches** - one undo covering a paste-settings across a selection - are deliberately not in v1.
Single-photo editing needs nothing of the sort, and the lookup they need (which photos did batch
X touch, when the selection that produced it no longer resolves to the same rows) is the same
problem `photos.deleted_batch` solves with a column and a partial index. Build it when
paste-settings ships, not before.

## 6. API

Every response is the same triple. `rev` is the row's version and is not optional on any write.

```
GET    /api/photos/:id/edits          -> { doc, rev, canUndo, canRedo }
PUT    /api/photos/:id/edits          <- { doc, rev }   -> same triple   commit
POST   /api/photos/:id/edits/undo     <- { rev }        -> same triple
POST   /api/photos/:id/edits/redo     <- { rev }        -> same triple
```

`canUndo` is `cursor > 0`, `canRedo` is `cursor < deltas.length`. `GET` on a photo with no row
answers 200 with the neutral doc and `rev: 0`, not 404 - the editor's open needs a doc either way,
and §2 writes no row until the first edit.

`PUT` rather than PATCH: the client holds the whole doc and sends the whole doc, and the server
derives the delta by diffing against what it already has, which keeps the delta's shape a server
concern.

**`rev` is what makes any of that safe**, and an earlier draft's claim that a lost response is
harmless to retry was true only of the doc. Without it: two tabs open at the same state, A commits
an exposure change, B commits a contrast change from its stale doc - the server diffs B's whole
doc against A's stored one and produces *both* `contrast 0 -> 20` **and** `exposure 1 -> 0`. A's
edit is gone and the history now records an exposure change nobody made, so undo walks back
through a fiction. The same hole bites one tab alone: undo and redo mutate the doc server-side, so
any autosave-on-close that PUTs the pre-undo doc re-applies the undone edit and truncates the redo
tail. A mismatched `rev` is a 409, and the client refetches.

`undo`/`redo` carry `rev` for the same reason plus one of their own: without it a retried request
undoes twice.

The editor's open reads `GET .../edits` alongside the prepared frame and seeds the tick uniform
from it, which is what makes an edit survive a reload. Note the doc's EV is converted to the
uniform's linear gain on the way in (§4).

## 7. Re-rendering after a save

**The job has to know.** `Job` in `rawshim_job.ts` gains an `edits` field carrying the doc; the
worker reads it from `photo_edits` when it assembles the job.

**Phase 0 has landed** (§0.4). Both hosts are decode → levels → code → denoise → warp → sharpen →
one dispatch carrying the colour transform, the roll-off and the transfer. There is one pipeline to
run, and the job already runs the editor's shaders.

**Where the GPU sits in the job.** The job runs the shared crate (§10) over its prepared frame and
takes `encode_to_buffer`'s counts back. Either side of that stays where it is: LibRaw's decode,
the resize (still before the grade, per `hdr.rs:273`), and the AVIF encode. The lens warp stays a
parameter - fused into the grade for the job, materialised at open for the editor, which §0.1
establishes are the same pixels. The denoise and sharpen move *inside* the shared chain as of
phase 0, rather than staying either side of it.

The transfer figure an earlier draft gave was wrong twice over. `encode` packed `array<u32>`, one
word per component, so at 61MP the readback was ~732MB and a staging copy of the same, not ~360MB.
It packs two `u16` to a word now, so it is ~366MB each. Both clear
`maxStorageBufferBindingSize`, which `Gpu::fits` checks - and since the output is now the same six
bytes a pixel as the frame, one question covers both bindings.

**The duplication is already collapsed.** `tone.rs`'s grade has left the rendition path and been
deleted, not kept as a test-only twin: `gpu_fixture.rs` rebuilds its baselines from the shader
under `BOWERBIRD_WRITE_FIXTURES`, and `pin.rs` records what that costs - the pin is a regression net
now rather than an independent oracle. `image::finish` stays on the CPU, at the open, on the coded
base; it is not a per-tick stage and §0.2.1 has the 645ms-to-15ms reason.

**Both stages are requeued.** The grid tile and the viewer renditions are separate artefacts with
separate flags, and an edit invalidates both. `queueTileRebuild` exists;
`queueRenditionRebuild(photoIds)` does not - only the whole-library form - and is added beside
it. Cache invalidation needs nothing new: `tile_built_at` and `renditions_built_at` already
version the URLs, and stored renditions carry an ETag off size and mtime.

**The requeue is debounced past the commit.** A delta is cheap and a rebuild is seconds of LibRaw,
so they are not the same event. Requeue on editor close, or after an idle interval, not on every
`settleExposure`.

## 8. Grid tiles from the render

Today `toStages` builds the tile from `'embedded'` - the camera's JPEG, ~125ms against ~1.5s for
a render - and that split is what fills a 2000-frame shoot's grid in a minute instead of eleven.
That stays. What changes is that a library which renders no longer *stops* at the JPEG tile.

**The render job already takes a `grid` target.** `job::Rendition` is `grid | full | max` and one
job can carry several, sharing one decode, one fit, one filter and one cut - the tile is a
`Cut::downscale` and an AVIF encode on pixels already decoded. Measured on the 61MP body, a
grid+full job is 3940ms against 4139ms for the full alone, so the tile is *free* to within noise.
What is left for this section is the *queueing*: `toStages` still stops at the embedded JPEG for a
library that renders, and that is the decision to change. The same change covers both cases the
user asked for, because they are one case: after an edit save, and on first import wherever the
library renders automatically.

This composes with §10 rather than fighting it: the edit passes run once over the shared base,
and both the `grid` and `full` targets downscale from the frame that comes back. One GPU round
trip per job, not one per target.

**The grid upgrades in place, visibly.** The JPEG tile lands in the first pass and the grid fills
at that pace; as the worker reaches each photo's renditions the tile is rewritten from the render
and `tile_built_at` moves, which is already what versions a tile's URL - so the gallery re-fetches
and the tiles sharpen one by one with no new client plumbing. `photos.rendition_source` is the
column that says which pixels a tile currently has, and so the one a UI would read to mark a tile
provisional.

**HDR grid tiles become a setting**, `libraries.grid_hdr INTEGER NOT NULL DEFAULT 0` - off, which
is what every library has today. It has effect only where the tile comes from a render and the
library's renditions are HDR: an embedded JPEG is 8-bit SDR, so there is no headroom in a
JPEG-derived tile to carry.

Four places currently hard-code "a grid tile is never HDR" and each has to become conditional
rather than absolute:

- `renditions.storedAsHdr` returns false for `grid` unconditionally, which decides the directory;
  with the setting on, `grid-hdr/` is a real path and `renditionDirs()` has to name it or the
  prune sweep deletes tiles it cannot account for.
- `processing_service.target` throws `'the grid tile is always SDR'` on `gridTile && hdr`.
- `dropStaleRenditions` keeps `grid/false` unconditionally, so a library that turns `grid_hdr`
  on would go on serving the stale SDR tile. The keep-set has to name whichever grid path is
  current.
- `sdrFullChroma` is forced off for the grid on the argument that a tile's usual source is the
  embedded JPEG. That argument no longer holds for a render-sourced tile; the measurement it
  cites (0.0003 SSIM) probably still does, so this one is worth re-checking rather than changing
  on principle.

**One bug this exposes.** `runOneOff` decides which stamp to move with
`job.targets.every((t) => t.rendition === 'grid') ? 'tile' : 'renditions'`. A render job carrying
both a `grid` and a `full` target is not `every`, so it would be stamped `renditions` alone and
`tile_built_at` would never move - the new tile would be written and no client would ever ask for
it. The test is "did this job write a grid target", not "was every target a grid target".

**One inconsistency to pin while here.** `photos.rendition_source` is documented as "which pixels
the grid tile was built from" in *two* places - `migrations.ts:106` and `schemas/photos.ts:82` -
while `finishRenditions` writes it from the renditions stage, under a comment explicitly saying it
is *not* the tile's source. Two sites against the code, and nothing notices today because the tile
only ever had one source. Once the tile has two, the column has to mean one thing; it should mean
the tile's, which is what both comments already claim and the only reading anything would query.

## 9. Geometry: crop, rotate, straighten

Not v1 work. Written down because the doc's shape has to be able to hold it, and because two of
the decisions below are cheaper to make now than to retrofit.

**Store the crop as fractions of the frame, not pixels.** `crs:CropTop`/`Left`/`Bottom`/`Right`
are already 0..1, and one doc has to grade an 800px tile, a 3840px `full` and a native-resolution
`max` - a pixel rectangle would be right for exactly one of them. `crs:CropAngle` in degrees for
the straighten.

**Composition order has to be stated once.** Lens warp is materialised at prepare time, so crop
and straighten compose after it and before the tone grade. Rotation by whole quarter-turns also
has to compose with `photos.orientation`, which is the camera's own EXIF value; one place should
own that composition or the two will be applied twice somewhere.

**Cropping changes the displayed aspect, and the grid lays out on `photos.width`/`height`,** which
are the file's dimensions and stay the file's. The grid needs the cropped aspect without reading
and parsing an edit doc per tile in a listing query, so this wants derived
`display_width`/`display_height` columns on `photos`, written when edits are saved and defaulting
to the file's. A rendition's long-edge target then measures the cropped frame rather than the
file.

**Undo needs no special case:** a crop is a delta over four numbers like any other.

## 10. One pipeline, compiled twice: a shared wgpu crate

> **Superseded - see §0.4.** What this section wants was reached without the crate: the `.wgsl`
> files stay in the page, `native/rawshim/src/gpu.rs` `include_str!`s the same files, and two thin
> hosts run one source. No new crate, no wasm, no bundle cost, no reversal of `559fe88`, and no
> dependence on `ExtendedDisplayP3`. Kept for the reasoning, the canvas probe in §10.0 and the
> silent-failure checklist in §10.1.1, which is still live. **§10.2 is not superseded and is now a
> blocker.**

Edits live in `tick.wgsl`. Renditions are built by Rust. Implementing the edits a second time in
Rust would mean the same arithmetic in two places, and if the two drift the editor lies about
what it is saving - silent, and visible only by comparing an export against the screen. The
divergence surface would also grow with every slider added, forever.

**So the whole pipeline becomes one Rust crate, compiled twice.** Not just the shaders: the
uniform construction, the lookup building, the dispatch geometry and the pass ordering as well.
wgpu implements the WebGPU API natively over Vulkan/Metal/DX12 and on wasm over the browser's
own WebGPU, so one crate serves the editor tick and the rendition job with nothing duplicated
between them.

**This takes `docs/raw-edit-gpu.md` §6.2 in full**, which is worth being explicit about because
that note's own §0 records it as *not* taken. §6.2 argued for wgpu in Rust precisely so "one Rust
implementation serves the editor tick **and** the server's renditions", and raw-edit-gpu.md §0
lists its rejection among four things the note got wrong or did not foresee - the shaders went
into the page "which is where the canvas is". That reason is answered rather than ignored: wgpu on
wasm can hold a canvas surface, so the crate keeps the draw instead of handing pixels back.
raw-edit-gpu.md §6.2 and §0 should both be amended to point here once this lands.

### 10.0 The seam: two entry points, two exits, one middle

The caller provides the device or adapter, and on the client a region - the rectangle of the
frame on screen, which is zoom and pan and which a rendition has no use for. The crate does
everything from the prepared frame through the graded result. Then each host takes its own exit.

**Both exits belong inside the crate.** This is the one correction to the obvious split. It is
tempting to have the crate stop at a finished buffer and let each host do what it likes with it,
but the client cannot afford that: `render()` is `measurePeak` plus `draw`, and `draw` runs the
colour transform as a single fragment shader *straight to the canvas*. The buffer-producing
`encode` path is not in the tick at all - it exists for `readFrame` and the parity harness.
raw-edit-gpu.md §0 measured what materialising that intermediate costs: **5.2ms of a 15ms tick**,
and removing it is one of the four corrections that note records. So the crate exposes
`draw_to_surface` for wasm and `encode_to_buffer` for native, sharing every pass before the last.
Both are thin; the alternative gives back a third of the tick.

**It has to be a new crate, not a mode of rawshim.** rawshim links LibRaw, lensfun and libavif
through build.rs bindgen, and none of that compiles to wasm. So `native/tick/` depends on wgpu,
bytemuck and half and nothing else, and rawshim depends on it. That is the same reasoning the
`renditions` Cargo feature already encodes: keep the heavy C out of the targets that cannot take
it.

**The canvas question, which was the blocker and is mostly answered.** The editor's canvas is
`rgba16float` + `colorSpace: 'display-p3'` + `toneMapping: { mode: 'extended' }`, and
raw-edit-gpu.md §7 is entirely about that being load-bearing and measured against a real PQ AVIF
on both engines. wgpu 30 reaches it: `SurfaceConfiguration` carries a `color_space` field, and
`SurfaceColorSpace::ExtendedDisplayP3` sets *both* dictionary members on the browser backend -
`colorSpace: "display-p3"` and `toneMapping: { mode: "extended" }`
(`wgpu-30.0.0/src/backend/webgpu.rs`, ~line 4265). That is the same canvas, configured by a
different hand.

What reading cannot settle is whether a given browser and adapter offer that colour space for
`Rgba16Float`, and whether the panel shows the extra range. A probe answered both:
`/codebox-workspace/bowerbird/wgpu-hdr-probe/` draws bars at 1x, 2x, 4x and 8x SDR white through
wgpu-on-wasm beside an identical set through hand-written JS WebGPU, so a flat result would be
attributable to the display rather than to wgpu.

**Measured, and it passes.** On Chrome and Safari the two canvases are *identical*, and both step
1x < 2x < 4x. `4x == 8x` on the panel it was run against, which is headroom rather than a fault:
`SDR_WHITE_NITS` is 203, so those bars ask for 812 and 1624 nits and a display that runs out
between the two shows the first and clips the second. The identical result across the two APIs is
the finding; the clip point is a property of that monitor.

(An earlier draft cited raw-edit-gpu.md §7.4 as recording this. It does not - "both paths" there
means the extended-range canvas against the PQ AVIF media route, a different comparison entirely,
and its measured Chrome headroom of "roughly 15x SDR white at 55% brightness and under 7x at 100%"
does not predict a 4x/8x merge. The citation was a conflation and is withdrawn.)

So wgpu-on-wasm reaches the editor's canvas. That question is closed; §0's is not.

**One caveat to carry.** `ExtendedDisplayP3` is available on Metal and the browser WebGPU backend
only - not Vulkan, not DX12, neither of which has an encoded-extended-Display-P3 swapchain colour
space. Harmless here, because the client is always a browser and the job never has a surface at
all, but it means a native window on Linux would not get this canvas. Related: `ExtendedSrgb` and
`ExtendedDisplayP3` are sRGB-*encoded* extended range, not linear - wgpu's docs call confusing
them with `ExtendedSrgbLinear` (scRGB) "the most common HDR setup mistake". Bowerbird's canvas is
the encoded one, so the shader's output stays in the encoding it is in today.

**The bundle cost, measured properly.** The web bundle ships no wasm today - every dependency in
`web/package.json` is JavaScript. A `Backends::BROWSER_WEBGPU` build of wgpu is mostly a
wasm-bindgen shim over `navigator.gpu`, pulling in neither wgpu-core nor naga, but the numbers in
an earlier draft were the wrong artefact: the probe's raw release binary is **1.29MB**, which
wasm-bindgen and `wasm-opt` reduce to **136KB**, shipped alongside **53KB** of JS glue. So ~189KB
added to the page for a bar-drawing toy, and a real tick crate is larger. The wasm and native
builds must select backends by Cargo feature so the browser build never drags in the Vulkan/DX12
half.

This does reverse `559fe88 chore(raw-edit): delete the wasm editing path and the spike's probes`,
though for a different reason than that deletion had: browser-side Rust was removed because
nothing needed it, and now something does.

**Bowerbird now expects a GPU.** A render node with no display attached
(`/dev/dri/renderD128`) is the ordinary shape of one on a server and wgpu gets a real Vulkan
adapter from it. Where there is no such adapter, Mesa's software Vulkan (lavapipe, `lvp_icd.json`)
is the fallback: it works, including compute, and it is slow. That is an accepted cost for now
rather than a supported configuration, and it should be said in the README rather than discovered.

**What still needs a check, and the harness that already does it.** Sharing the source removes
source drift, not numeric drift: the tick runs on the reader's GPU and the job on the server's,
so fp16 precision, FMA contraction and transcendental implementations can still differ between
two drivers running the same shader.

A pin exists, in two halves that check each other:

- `web/e2e/gpu_parity.spec.ts` asserts the shaders reproduce the bytes in `fixtures/gpu/` - mean
  within 0.5 counts of 65535, worst pixel bounded at 320, under 0.5% of samples past 16 - over six
  fixtures at three exposures, matched and neutral. Those thresholds are whole-frame per fixture;
  the harness also reports `byBand` (shadow/mid/highlight) but asserts nothing on it, and an
  earlier draft's "split by stage" was inherited from a stale comment in that file describing a
  `finish` stage the fixtures no longer carry.
- `native/rawshim/tests/gpu_fixture.rs` rebuilds those same fixtures from the CPU inside
  `cargo test`, so neither half can pass against a twin that has moved.

**But it does not cover what §7 would lean on it for**, and "no new harness to build" was wrong.
`gpu_fixture.rs:161-164` builds its expectation from `hdr::grade_prepared` with `lens: None`, plus
`encode_pq`, over a synthetic scene. It never exercises `grade_owned`'s fused warp, `image::finish`
after PQ, the SDR path, or a real decode - which is to say it exercises none of the ground where
§0's frame-mismatch finding lives. Replacing the job's grade lands entirely outside what any pin
currently asserts, and new fixtures on the job's own path are part of the work, not a footnote.

**And the crate does not reduce this to one implementation.** `prelude.wgsl:3-5` says outright
that the WGSL *is* a second implementation of `tone.rs`'s picture, and §7 keeps `tone.rs` as a
test-only twin. Two implementations before, two after; what the crate removes is a *third* that
was never written. The earlier claim that the pin narrows to "two drivers running the same shader"
was wrong.

### 10.1 What moves into the crate, and what stays in the page

The tick is 728 lines of WGSL against 1074 of TypeScript (`tick_pipeline.ts` 872, `shaders.ts`
124, `pass_timer.ts` 78). The WGSL moves as-is. Nearly all of the TypeScript moves too, which is
the point - what is left in the page is a shell.

**Stays in TypeScript.** `RawEditPresenter` keeps the parts that are about a browser rather than
about a picture: the `ResizeObserver`, the `devicePixelRatio` media query, the
`requestAnimationFrame` coalescing, the fetch of the prepared frame, and the MobX store it writes
into. `stageResolution` is a judgement call - it is arithmetic over a CSS box and a device limit,
so it could go either way; leaving it in the page keeps layout concerns out of the crate.

**Moves into `native/tick/`.** Everything else, including the parts that would otherwise have
been rewritten twice: `writeUniform`, the lookup and texture construction, the dispatch geometry,
the constants (`SDR_WHITE_NITS`, `PEAK_BINS`, `PEAK_SAMPLES`, `PEAK_CANDIDATES`, `SUPERSAMPLE`),
the pyramid build, the peak passes, `chooseCandidates`, and both exits.

**`TICK_LAYOUT` and `tickOffsets()` go**, but `tests/tick_uniform.test.ts` must not, and an
earlier draft of this section was wrong to say otherwise. The claim was that a `#[repr(C)]` struct
written by `bytemuck` is "checked by the compiler". It is not: `bytemuck` proves the *Rust* struct
is `Pod` and nothing more. `struct Tick` in `wgsl/tick.wgsl` remains a separate declaration in a
separate language, with WGSL's uniform-address-space alignment that the Rust struct still
hand-mirrors. Swapping two fields in the WGSL still leaves a green build and the wrong rectangle
drawn - exactly the bug `shaders.ts:44-48` records. The Rust host is one copy instead of two,
which is a real gain; the pin against the shader stays, as a build script that parses the `.wgsl`
or as `const` offset assertions.

### 10.1.1 Things the port must preserve, because they fail silently

These were drift hazards while two hosts existed. With one host they are a *porting* checklist
instead - each is a place where the obvious Rust spelling produces a clean run and a different
picture:

- **The sampler.** `createSampler({ magFilter: 'linear', minFilter: 'linear' })`. Both APIs
  default to nearest, so the hazard is that `&Default::default()` is the natural thing to write.
  Nearest turns the chroma lattice's trilinear into point sampling, which is the entire reason
  the lattice is a 3D texture.
- **f16 on the chroma lattice, where the better option is the wrong one.** The nodes are
  `rgba16float` deliberately: `f32` is not filterable on Apple GPUs, and the 2^-11 was measured at
  0.109 deltaE ITP worst-pixel. Native wgpu could enable `float32-filterable` and get a strictly
  more accurate answer that disagrees with the parity fixtures and with any client whose GPU
  cannot. Keep the worse option, on purpose, on both targets.
- **Dispatch counts against `@workgroup_size`.** `groups()` divides both axes by 8;
  `sampledGroups` divides **x by 64 and y by `rowStride`** (`tick_pipeline.ts:762-764`), where
  `rowStride = max(1, round(pixels / PEAK_SAMPLES))` (`:246`). Writing `ceil(h/64)` for y - the
  symmetric-looking thing - dispatches the wrong number of rows and measures the peak over a
  fraction of its samples. `in_frame()` guards the overrun, so this is a wrong picture rather than
  a fault, which is why it belongs in this list.
- **The partial clear.** `clearBuffer(this.candidates, 0, 16)` clears the count and its padding,
  not the array. Missing either clear accumulates stale counts into the next peak.
- **`writeTexture`'s `bytesPerRow`/`rowsPerImage`.** The curve texture is `[bins, 3]`, a row per
  channel, which is what stops red blending into green. wgpu's 256-byte row alignment may turn a
  mistake here into an error rather than a smear; do not count on it.
- **The odd-`u16` tail on the frame upload.** Three `u16` a pixel is not a multiple of four when
  both dimensions are odd, which left the frame zeroed and the picture black on a fit that landed
  on 3841x2561.

**And the exit each host takes.** `encode_to_buffer` yields u16 PQ counts - the unit every pin in
this repo is written in - and is what the job wants. `draw_to_surface` goes through the canvas
configuration (`rgba16float`, `display-p3`, `toneMapping: extended`) and yields display-referred
nits. Reading back a surface texture and treating it as the job's output would be plausible,
wrong, and invisible to every existing pin, because no pin is written in that unit.

### 10.2 What the deployment needs

Three changes, none architectural, one of which conflicts with something already in the tree:

- **`docker-compose.yml` passes no device through.** It needs `devices: - /dev/dri:/dev/dri`,
  and the container user has to be in the host's `render` group (`group_add`) to open the node -
  `/dev/dri/renderD128` is `crw-rw---- root render`.
- **The image ships no Vulkan driver.** `base` installs `libraw23t64 liblensfun1 libavif16` and
  nothing else; `mesa-vulkan-drivers` covers AMD, Intel and lavapipe in one package. NVIDIA is
  its own arrangement - the proprietary driver plus nvidia-container-toolkit - and is not
  something the image can carry.
- **The `dev` stage purge collides with this.** Line 91 does
  `dpkg --force-depends --purge libllvm19 libz3-4 mesa-libgallium libgl1-mesa-dri libglx-mesa0`
  to reclaim 192MB reached through ffmpeg's SDL2 dependency. `mesa-vulkan-drivers` is built on
  `mesa-libgallium` and lavapipe *is* an LLVM JIT, so that purge removes exactly what the tests
  would now need, and the stage's own comment says nothing may install after it. The dev stage
  has to stop purging Mesa wholesale, and it is worth re-measuring what is actually reclaimable
  once Vulkan has to stay.

CI inherits all of this: `test:native:full` decodes real RAWs, so those tests now want an adapter
and will fall back to lavapipe on a runner without one. Expect them to get slower rather than to
fail.

### 10.3 The rest of the review's §10 findings, unresolved

Recorded rather than fixed. Phase 0 (§0.1) resolves the frame mismatch these were found around;
the rest stand on their own and are still open.

Two are already answered above and are struck from this list: the ~360MB transfer figure (it is
~732MB, corrected in §7) and the claim that the CPU grade can simply be deleted (it is a test-only
twin, §7).

- **"The caller provides the device" is not implementable on wasm.** wgpu 30 has
  `Device::as_webgpu()` and no inverse, so a JS `GPUDevice` cannot be wrapped. The crate must own
  `request_adapter`/`request_device`, which pulls in `tickFeatures`, `tickLimits`, `frameTooBig`,
  `device.lost`, `onuncapturederror` and the `pushErrorScope` bracket - all load-bearing, all
  reasons commit `5865127` exists - and their MobX reporting has to be plumbed back out.
- **`encode_to_buffer` does not exist as a standalone exit.** `readFrame` never calls
  `writeUniform` and never runs the peak passes; it reads `peak_out[0]` left behind by the last
  `render()`, and `writeUniform` itself reads `this.context.canvas`. Both have to be lifted out
  before any surfaceless host can call it.
- **§8's "downscale from the frame that comes back" reverses a documented decision.** `hdr.rs:274`
  records fitting *before* grading precisely so a 61MP frame is not tone-mapped in full to make an
  800px tile - and downscaling after the grade averages PQ-coded values, the same objection
  `frame.wgsl:56-59` raises.
- **The pyramid and `chooseCandidates` are unconditional in the constructor** and both are pure
  cost for a one-shot job (~160MB of `rgba16uint` plus a reduce chain; and `useCandidates` lands
  asynchronously *after* submit, so a single-pass job would never see it true). They need gating
  on "there is a region".
- **Three more silent-failure hazards for §10.1.1**: the `unfilterable-float` sample type on the
  curves texture (wgpu's default is `Float { filterable: true }`, the wrong one); `const` rather
  than `override` in `peak.wgsl:31-37`, which is what made Safari refuse every RAW with "Compute
  library failed creation"; and explicit bind group layouts never `auto`/`None`, since `encode`
  does not reference binding 9 and a derived layout drops it.
- **Concurrency and GPU memory are unaddressed.** `processing_concurrency` defaults to 4. A
  shared `Device` is the right answer (it is `Send + Sync`), but four concurrent 61MP jobs at
  frame + counts + staging is ~7GB. Also `edit::prepare`'s `admit()` is a process-wide mutex.
- **`rawshim` depending on `tick` unqualified drags wgpu into Android and iOS.** `src-tauri`
  takes `rawshim` with `default-features = false` specifically to avoid that; `tick` has to ride
  the same feature.
- **No wasm build story exists in the tree.** No workspace, no wasm-bindgen dep, no vite plugin,
  and `559fe88` deleted the last one. `test/integration/shared_constants.integration.test.ts`
  pins `gpu/shaders.ts` against the server's constants and breaks when that file goes.
- **§8's `runOneOff` bug has a twin on the batch path**, which is the path the feature actually
  uses: `runStaged` stamps `'renditions'` at `processing_service.ts:379` without inspecting
  targets at all.
- **§8's `rendition_source` change has a data-loss path.** `toStages:489` reads that column to
  decide whether a renditions job exists; a photo stamped `embedded` because its tile came from
  the JPEG never builds renditions again, and `dropStaleRenditions` deletes the ones it has. A
  separate `tile_source` column is the safer shape.
- **A failed rebuild after an edit sweeps every rendition and never retries** (`recordFailure` ->
  `markProcessingFailed` clears both flags, `sweepRenditions(photo, new Set())`), and publishes no
  SSE event, so the editor never learns. Under §10.2 the likeliest first failure is a deploy that
  did not pass `/dev/dri` through - which would fire this on every edited photo at once.
- **Bin and restore swallow the requeue.** `queueTileRebuild` filters `is_deleted = 0` and
  `markRestored` does not set the flags back, so edit-then-bin-then-restore keeps pre-edit pixels
  forever. §2's "comes back edited" is true of the doc, not the picture.
- **Nobody owns the debounce timer**, and both triggers §7 names are unreliable: the editor-close
  cleanup does not run on a tab close or crash, and there is no `beforeunload` anywhere in
  `web/src`. Server-side, re-armed by `PUT`, with a boot sweep for
  `photo_edits.updated_at > photos.renditions_built_at`, is the shape that survives.
- **Render-sourced grid tiles change the stacking descriptor** (`job.rs:248` computes it from the
  tile's pixels, and auto-stack similarity is tuned against embedded-JPEG descriptors), so §8 can
  silently regroup stacks.
- **`libraries.grid_hdr` is one column and about eight other edits**, and the repo's precedent is
  unanimous that library settings are not retroactive - the user presses rebuild.
- **`DESIGN.md` is the design-of-record** and this invalidates its §4, §13, §16 and §21. Only
  `raw-edit-gpu.md` was flagged for amendment.

## 11. Out of scope

- **Crop, rotate, straighten** - §9, designed for, not built.
- **XMP import.** The schema is chosen so the importer is a pure mapping function. Writing it is
  a later task.
- **XMP export.** Worth noting as the answer to the portability sidecars would have given: edits
  live in the catalogue database, so a library folder carried to another machine arrives
  unedited until something writes them out.
- **Batch edits and batch undo** - §5.
