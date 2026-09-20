# Ratio Corrected Demosaicing (RCD), functional specification

A complete description of the RCD Bayer demosaicing algorithm (Luis Sanz Rodríguez, release 2.3),
written so it can be implemented from scratch. Everything here is stated as mathematics; nothing
about how any existing implementation is organised is normative. Performance-only concerns are in
`rcd-optimisation-notes.md` and may be ignored entirely without changing the result.

---

## 1. Scope and shape of the problem

Input is a single-plane Bayer colour-filter-array (CFA) mosaic: one scalar per pixel, whose colour
is red, green or blue depending on the pixel's position in a repeating 2×2 pattern. Output is three
planes (R, G, B) at full resolution.

RCD is a directional, colour-difference demosaicer in the Hamilton–Adams family, with two
substitutions that define it:

1. **The direction decision** is made from a high-pass statistic whose kernel sums to zero
   *separately over each of the two interleaved CFA phases*. It therefore cannot be biased by a
   constant offset or gain difference between the two channels sampled along that line, which is
   exactly the perturbation lateral chromatic aberration produces locally. The decision is also
   *soft*: a continuous blend weight, not a hard choice of axis.
2. **The green estimate** corrects each neighbouring green sample by a **ratio** taken in a
   low-pass (achromatic) domain, rather than by adding half a **difference** of raw same-colour
   samples as Hamilton–Adams does. On a hard edge a difference correction can push the estimate
   past both bracketing samples (overshoot, seen as coloured fringing); a multiplicative correction
   in a smoothed domain cannot swing nearly as far.

Chroma (R and B) is then reconstructed by the conventional colour-difference route, but with the
same soft directional blending applied on the diagonals as well as the axes.

Six stages, in dependency order:

| Stage | Computes | Defined on | Depends on |
|---|---|---|---|
| A | axis-direction blend field | every pixel | mosaic |
| B | low-pass luminance | red/blue sites | mosaic |
| C | green at red and blue sites | red/blue sites | A, B |
| D | diagonal-direction blend field | red/blue sites | mosaic |
| E | the missing chroma at red and blue sites | red/blue sites | C, D |
| F | red and blue at green sites | green sites | C, E, A |

A, B and D read only the mosaic and are mutually independent. C needs A and B. E needs C and D.
F needs C, E and A. F reading E is a real dependency, not an artefact: at a green site the chroma
samples lying to the left and right are of the colour that F is *not* reading directly from the
sensor, so they must already have been filled in by E.

---

## 2. Notation, coordinates, conditioning

- `(r, c)` is (row, column), row-major, origin top-left.
- `M(r, c)` is the conditioned mosaic value at that pixel (§2.2).
- `R(r,c)`, `G(r,c)`, `B(r,c)` are the three output planes. `C₀` denotes "the chroma channel under
  discussion" where a formula applies to red and blue alike.
- `phase(r, c) ∈ {red, green, blue}` is the CFA colour at that pixel (§9).
- All arithmetic is in floating point. Single precision is sufficient.

### 2.1 Constants

| Symbol | Value | Where used |
|---|---|---|
| `ε` | 1×10⁻⁵ | added to every gradient; added to every ratio denominator |
| `ε²` | 1×10⁻¹⁰ | floor applied to each directional energy before the ratio |

`ε²` is exactly the square of `ε`, but the two are used independently; do not fold one into the
other. They are chosen for input scaled to roughly the unit interval, which is why §2.2 is
functionally required rather than cosmetic.

### 2.2 Input conditioning

Before anything else:

```
M(r, c) = max(0, raw(r, c)) / whitelevel
```

so that `M` is non-negative and nominally within `[0, 1]`. Both properties matter:

- **Non-negativity is load-bearing.** Stage C divides by a sum of two low-pass values. Raw data
  after black-level subtraction routinely contains small negative values in the shadows; a negative
  low-pass value can drive that denominator through zero, and `ε` will not save it. Clamping at the
  source is the guard.
- **Scale sets the meaning of `ε`.** Feeding 16-bit integers straight in makes both guards
  numerically irrelevant; feeding data scaled to, say, 1/1000 of unity makes `ε` dominate the
  gradients and flattens all directional discrimination to an unweighted average.

Values above 1 (highlights above the nominal white point) are harmless and need not be clipped; some implementations do clip the input to `[0, 1]`, some only clamp at zero. The difference is
confined to blown highlights.

The reverse scaling by `whitelevel` is applied to all three output planes at the end.

---

## 3. The directional energy statistic

This is the part of RCD that is not shared with its ancestors, so it is worth stating carefully.

### 3.1 The kernel

Let `k` be the 7-tap, one-dimensional kernel over offsets −3 … +3:

```
offset:   -3   -2   -1    0   +1   +2   +3
weight:   +1   -3   -1   +6   -1   -3   +1
```

For a sequence of samples `x₋₃ … x₊₃` taken along a straight line at unit spacing, the response is

```
h(x) = (x₋₃ + x₊₃) − 3·(x₋₂ + x₊₂) − (x₋₁ + x₊₁) + 6·x₀
```

Note the specific grouping this permits, which is how it is usually evaluated:

```
h(x) = [ x₋₃ − x₋₁ − x₊₁ + x₊₃ ] − 3·[ x₋₂ + x₊₂ ] + 6·x₀
```

### 3.2 Why this kernel, and why it is invariant to chromatic aberration

Along any straight line through a Bayer mosaic in one of the four directions used here, the sampled
colour alternates with period 2. Offsets `{0, ±2}` carry one colour; offsets `{±1, ±3}` carry the
other. The kernel sums to zero **on each of those two sets separately**:

```
even offsets:  6 − 3 − 3           = 0
odd  offsets: −1 − 1 + 1 + 1       = 0
```

Consequences, all of which are the point of the design:

- Adding an arbitrary constant to *either* channel alone leaves the response unchanged.
- Multiplying *either* channel alone by a constant scales only that channel's contribution, and
  since the contribution of a locally-constant channel is zero, a pure gain difference between the
  channels is also invisible.
- Each half of the kernel additionally annihilates a linear ramp: `Σ offset·weight = 0` holds over
  the even offsets (`0·6 + 2·(−3) + (−2)·(−3) = 0`) and trivially over the odd offsets by symmetry.

Lateral chromatic aberration displaces one channel relative to the other; over a small window its
effect on a locally smooth region is precisely a per-channel offset and slope. The statistic is
blind to all of that, and responds only to genuine structure, which is what a direction decision
should depend on. A naive alternative such as "sum of absolute differences between neighbours"
responds strongly to the channel-to-channel step and will happily pick a direction because of the
lens, not the scene.

The response can equally be read as `3 ×` (second difference of the centre channel at spacing 2)
minus (second difference of the other channel), i.e. a colour-difference high-pass evaluated
directly on the mosaic without demosaicing anything first.

### 3.3 Directional energy

For a direction `d` and a pixel `p`, write `h_d(p)` for the kernel response of §3.1 applied along
`d` centred at `p`, where the step vector for each direction is:

| Direction | Step per unit offset |
|---|---|
| vertical (V) | `(+1, 0)` |
| horizontal (H) | `(0, +1)` |
| main diagonal (P) | `(+1, +1)` |
| anti-diagonal (Q) | `(+1, −1)` |

The **energy** in direction `d` at `p` is the sum of three squared responses, taken at `p` and at
the two neighbours of `p` *along that same direction*, then floored:

```
E_d(p) = max( ε² ,  h_d(p − s_d)² + h_d(p)² + h_d(p + s_d)² )
```

where `s_d` is the step vector for `d`. Concretely:

- `E_V(r,c)` sums squared vertical responses centred at `(r−1,c)`, `(r,c)`, `(r+1,c)`.
- `E_H(r,c)` sums squared horizontal responses centred at `(r,c−1)`, `(r,c)`, `(r,c+1)`.
- `E_P(r,c)` sums squared main-diagonal responses centred at `(r−1,c−1)`, `(r,c)`, `(r+1,c+1)`.
- `E_Q(r,c)` sums squared anti-diagonal responses centred at `(r−1,c+1)`, `(r,c)`, `(r+1,c−1)`.

The `ε²` floor exists so the ratio in §3.4 is defined on a perfectly flat patch, where every
response is exactly zero. With both energies at the floor the ratio evaluates to exactly 0.5, i.e.
"no preference", which is the correct answer there.

The support of `E_V` and `E_H` is 9 samples along the direction (offsets −4 … +4); likewise for the
diagonals along their axis.

**Equivalent expanded form.** `E_d` is a quadratic form in the nine samples `x₋₄ … x₊₄` along the
direction. Writing it out gives coefficients `Q(j,k)` for `j ≤ k`, applied as
`E = Σ_{j≤k} m(j,k)·Q(j,k)·x_j·x_k` with `m(j,k) = 1` for `j = k` and `2` otherwise:

```
        j\k    -4    -3    -2    -1     0    +1    +2    +3    +4
        -4      1    -3    -1     6    -1    -3     1     0     0
        -3      .    10     0   -19     9     8    -6     1     0
        -2      .     .    11    -6   -18    12     7    -6     1
        -1      .     .     .    46    -9   -35    12     8    -3
         0      .     .     .     .    38    -9   -18     9    -1
        +1      .     .     .     .     .    46    -6   -19     6
        +2      .     .     .     .     .     .    11     0    -1
        +3      .     .     .     .     .     .     .    10    -3
        +4      .     .     .     .     .     .     .     .     1
```

This is algebraically identical to the three-squared-responses form and is given only as a
cross-check; there is no reason to implement it, as it costs about ten times the arithmetic.

### 3.4 The blend fields

Two scalar fields, each the share of the energy attributable to the *first* named direction:

```
tH(r, c) = E_V(r, c) / ( E_V(r, c) + E_H(r, c) )        the axis field
tQ(r, c) = E_P(r, c) / ( E_P(r, c) + E_Q(r, c) )        the diagonal field
```

Both lie in `[0, 1]`. The naming reflects how they are consumed: **high energy in a direction means
that direction is a bad one to interpolate along**, so `tH` (large when vertical energy dominates)
is used as the weight of the *horizontal* estimate. Likewise `tQ` weights the *anti-diagonal*
estimate. Every consumer of these fields blends as

```
result = (1 − t)·(first-direction estimate) + t·(second-direction estimate)
```

with (first, second) = (vertical, horizontal) for `tH` and (main diagonal, anti-diagonal) for `tQ`.

`tH` is needed at every pixel. `tQ` is needed only at red and blue sites; its consumers are at red
and blue sites and read it at the four diagonal neighbours, which are red and blue sites too.

### 3.5 Refinement of a blend weight before use

No consumer uses the field value at its own pixel directly. Each first computes the mean over the
four diagonal neighbours,

```
t̄(r,c) = ¼·( t(r−1,c−1) + t(r−1,c+1) + t(r+1,c−1) + t(r+1,c+1) )
```

and then selects **whichever of the central value and the neighbourhood mean is further from 0.5**:

```
t* = if |0.5 − t(r,c)| < |0.5 − t̄(r,c)|  then  t̄(r,c)  else  t(r,c)
```

Read plainly: distance from 0.5 is decisiveness, and the rule keeps the more decisive of the two
opinions. Where the local statistic is ambivalent but the surrounding four agree on a direction, the
neighbourhood carries the decision; where the centre is confident it is never diluted. This is what
keeps thin, consistently-oriented structure from being averaged into mush by a locally weak
statistic, and it is applied identically in stages C, E and F.

`t*` should be clamped to `[0, 1]` before use. It cannot leave that range given exact arithmetic on
well-formed fields, but it can if the field has been zero-filled outside its valid region (§10), and
a weight outside `[0, 1]` extrapolates rather than interpolates.

---

## 4. Stage B, the low-pass luminance

A single 3×3 convolution applied directly to the mosaic, with the binomial kernel

```
        1  2  1
  1/16· 2  4  2       ⇒   L(r,c) = ¼·M(r,c)
        1  2  1                  + ⅛·( M(r−1,c) + M(r+1,c) + M(r,c−1) + M(r,c+1) )
                                 + 1/16·( M(r−1,c−1) + M(r−1,c+1) + M(r+1,c−1) + M(r+1,c+1) )
```

**Why this kernel and no other.** Evaluate the CFA colours under the weights at any Bayer site:

- At a **red** site: centre is red (4/16), the four edge neighbours are green (8/16 total), the four
  corners are blue (4/16 total) → `L = ¼·R + ½·G + ¼·B`.
- At a **blue** site: same by symmetry → `L = ¼·R + ½·G + ¼·B`.
- At a **green** site: centre green (4/16) plus four green corners (4/16), two edge neighbours red
  (4/16) and two blue (4/16) → `L = ¼·R + ½·G + ¼·B`.

The same fixed achromatic combination at *every* phase. That is the whole trick: convolving the raw
mosaic with this one kernel yields a single-plane image with no residual CFA modulation and no
red-versus-blue bias, obtained without demosaicing anything. It is softer than the input but
essentially artefact-free, which is what makes it safe to divide by.

Only the values at red and blue sites are ever read (§5), so it need only be evaluated there.

**Scale is free.** `L` appears exclusively inside the ratio of §5, so any positive global scaling of
the kernel cancels, except for its interaction with `ε` in the denominator. Implementations
commonly use the unnormalised kernel (centre 1, edges ½, corners ¼, i.e. 4× the above) for this
reason. Either is acceptable; be aware the choice shifts the effective size of `ε` by 4× and hence
perturbs results in near-black regions at the last bit or two.

---

## 5. Stage C, green at red and blue sites

Evaluated at every red and blue site. Let `p = (r, c)` be such a site, and let all `M` and `L`
references below be relative to `p`.

### 5.1 Cardinal gradients

Four scalars, each a sum of four absolute differences plus `ε`. The first term is common to the
opposing pair; the remaining three walk outward along that direction:

```
g_N = ε + |M(−1,0) − M(+1,0)| + |M(0,0) − M(−2,0)| + |M(−1,0) − M(−3,0)| + |M(−2,0) − M(−4,0)|
g_S = ε + |M(+1,0) − M(−1,0)| + |M(0,0) − M(+2,0)| + |M(+1,0) − M(+3,0)| + |M(+2,0) − M(+4,0)|
g_W = ε + |M(0,−1) − M(0,+1)| + |M(0,0) − M(0,−2)| + |M(0,−1) − M(0,−3)| + |M(0,−2) − M(0,−4)|
g_E = ε + |M(0,+1) − M(0,−1)| + |M(0,0) − M(0,+2)| + |M(0,+1) − M(0,+3)| + |M(0,+2) − M(0,+4)|
```

(The leading term of `g_N` and `g_S` is the same quantity; likewise `g_W` and `g_E`.) Each gradient
mixes green-to-green differences at spacing 2 with centre-colour differences at spacing 2, so it
measures activity in that direction on both phases. The author describes these weights as
empirically tuned; treat them as fixed constants of the algorithm.

`ε` guarantees every gradient is strictly positive, so each denominator below is at least `2ε`.

### 5.2 Ratio-corrected directional estimates

This is the "ratio corrected" step. For each of the four cardinal directions, take the adjacent
green *sample* and rescale it by the ratio of the low-pass value at the centre to the mean of the
low-pass values at the centre and at the same-colour site two pixels away in that direction:

```
e_N = M(−1,0) · ( 2·L(0,0) ) / ( L(0,0) + L(−2,0) + ε )
e_S = M(+1,0) · ( 2·L(0,0) ) / ( L(0,0) + L(+2,0) + ε )
e_W = M(0,−1) · ( 2·L(0,0) ) / ( L(0,0) + L(0,−2) + ε )
e_E = M(0,+1) · ( 2·L(0,0) ) / ( L(0,0) + L(0,+2) + ε )
```

Both low-pass values are read at spacing 2 from the centre, i.e. on the same red/blue sub-lattice as
the centre, the same footing on which Hamilton–Adams reads its same-colour samples.

Two algebraically equivalent readings, both useful:

```
e_N = M(−1,0) · ( 1 + (L(0,0) − L(−2,0)) / (L(0,0) + L(−2,0)) )        [ratio form]
e_N = M(−1,0) · L(0,0) / mean( L(0,0), L(−2,0) )                        [rescaling form]
```

The comparison that motivates the design, for the East direction:

```
Hamilton–Adams:  e = G(0,+1) + ( M(0,0) − M(0,+2) ) / 2
RCD:             e = G(0,+1) · ( 1 + (L(0,0) − L(0,+2)) / (L(0,0) + L(0,+2)) )
```

Two changes at once: the additive correction becomes multiplicative, and the quantity driving the
correction moves from the raw same-colour samples to the smooth achromatic image. The first bounds
the excursion, the correction factor is confined to `(0, 2)` for non-negative inputs, so the
estimate can never change sign or run away, and the second removes the chroma noise and the CFA
modulation that make the raw difference erratic on edges.

The `ε` sits in the denominator only. Some implementations instead use `(2·L(0,0) + ε)` in the
numerator, which is the exact algebraic expansion of the ratio form; the difference is one part in
10⁵ of a value near zero and is not significant.

### 5.3 Axis estimates and the result

Combine each opposing pair by **inverse-gradient weighting**; each estimate is weighted by the
gradient of the *opposite* direction, so the side that is locally smoother contributes more:

```
e_V = ( g_S·e_N + g_N·e_S ) / ( g_N + g_S )
e_H = ( g_W·e_E + g_E·e_W ) / ( g_E + g_W )
```

Then blend the two axes with the refined axis weight `t*` obtained from `tH` by §3.5:

```
G(r,c) = (1 − t*)·e_V + t*·e_H
```

Optionally clamp to `[0, 1]`. The original does; the widely deployed derivatives do not and clamp
only at output. Clamping here is the safer choice and costs nothing.

At red and blue sites this completes the green plane; at green sites green is the mosaic sample
itself. After this stage the green plane is complete.

---

## 6. Stage E, the missing chroma at red and blue sites

At a red site the blue value is missing, and vice versa. Call the missing channel `C₀`; the four
diagonal neighbours of the site are exactly the sites where `C₀` was sampled directly, so `C₀` is
known there, and green is now known everywhere.

Evaluated at every red and blue site. `C₀` denotes the mosaic sample of that channel where it
exists; `G` is the stage-C green plane.

### 6.1 Diagonal gradients

Same shape as §5.1 but along the diagonals, and now mixing a chroma term with a green term. Offsets
are `(Δrow, Δcol)`:

```
g_NW = ε + |C₀(−1,−1) − C₀(+1,+1)| + |C₀(−1,−1) − C₀(−3,−3)| + |G(0,0) − G(−2,−2)|
g_SE = ε + |C₀(−1,−1) − C₀(+1,+1)| + |C₀(+1,+1) − C₀(+3,+3)| + |G(0,0) − G(+2,+2)|
g_NE = ε + |C₀(−1,+1) − C₀(+1,−1)| + |C₀(−1,+1) − C₀(−3,+3)| + |G(0,0) − G(−2,+2)|
g_SW = ε + |C₀(−1,+1) − C₀(+1,−1)| + |C₀(+1,−1) − C₀(+3,−3)| + |G(0,0) − G(+2,−2)|
```

The first term is shared within each opposing pair. All `C₀` reads land on same-colour sites; all
`G` reads at spacing 2 land on red/blue sites, where green came from stage C.

### 6.2 Colour differences and the result

Take the plain colour difference at each diagonal neighbour, combine each opposing pair by
inverse-gradient weighting, blend the two diagonals with the refined diagonal weight `t*` from `tQ`
via §3.5, and add the result to the known green:

```
d_NW = C₀(−1,−1) − G(−1,−1)
d_NE = C₀(−1,+1) − G(−1,+1)
d_SW = C₀(+1,−1) − G(+1,−1)
d_SE = C₀(+1,+1) − G(+1,+1)

e_P = ( g_NW·d_SE + g_SE·d_NW ) / ( g_NW + g_SE )
e_Q = ( g_NE·d_SW + g_SW·d_NE ) / ( g_NE + g_SW )

C₀(r,c) = G(r,c) + (1 − t*)·e_P + t*·e_Q
```

Note this half of the algorithm is a **difference** method, not a ratio method: the ratio treatment
is applied to luminance (green) only, where overshoot is visible as a fringe. Chroma is
reconstructed as the interpolated colour difference added back to the reconstructed green, which is
the standard construction and is what keeps chroma locked to luminance detail.

Optionally clamp to `[0, 1]`, as in §5.3.

---

## 7. Stage F, red and blue at green sites

Evaluated at every green site, for both `C₀ ∈ {red, blue}` in turn. At a green site one of red/blue
was sampled directly at the two vertical neighbours and the other at the two horizontal neighbours;
the other four of those eight values were filled in by stage E. Because of that, **stage F must not
start until stage E has finished**. The formula below is phase-agnostic, the same expression serves
both channels and both green phases, precisely because E has already made every red/blue site carry
both chroma channels.

### 7.1 Cardinal gradients

```
g_N = ε + |G(0,0) − G(−2,0)| + |C₀(−1,0) − C₀(+1,0)| + |C₀(−1,0) − C₀(−3,0)|
g_S = ε + |G(0,0) − G(+2,0)| + |C₀(−1,0) − C₀(+1,0)| + |C₀(+1,0) − C₀(+3,0)|
g_W = ε + |G(0,0) − G(0,−2)| + |C₀(0,−1) − C₀(0,+1)| + |C₀(0,−1) − C₀(0,−3)|
g_E = ε + |G(0,0) − G(0,+2)| + |C₀(0,−1) − C₀(0,+1)| + |C₀(0,+1) − C₀(0,+3)|
```

Three terms each here, not four as in §5.1. The middle term is shared within each opposing pair.
The `G` reads at spacing 2 land on green sites, where green is the mosaic sample.

### 7.2 Colour differences and the result

```
d_N = C₀(−1,0) − G(−1,0)
d_S = C₀(+1,0) − G(+1,0)
d_W = C₀(0,−1) − G(0,−1)
d_E = C₀(0,+1) − G(0,+1)

e_V = ( g_N·d_S + g_S·d_N ) / ( g_N + g_S )
e_H = ( g_E·d_W + g_W·d_E ) / ( g_E + g_W )

C₀(r,c) = G(r,c) + (1 − t*)·e_V + t*·e_H
```

with `t*` refined from `tH` by §3.5; the same axis field stage C used, refined the same way, and
computed once per green site rather than once per channel.

The pairing is again inverse-gradient: `d_N` carries the weight `g_S`. (Written as above the two
products appear transposed relative to §5.3; they are not; expand both and each estimate is
multiplied by the opposite side's gradient in every stage.)

Optionally clamp to `[0, 1]`.

---

## 8. Output assembly

Per pixel:

- **Green site:** `G` is the mosaic sample; `R` and `B` come from stage F.
- **Red site:** `R` is the mosaic sample; `G` from stage C; `B` from stage E.
- **Blue site:** `B` is the mosaic sample; `G` from stage C; `R` from stage E.

Multiply all three planes by `whitelevel` to undo §2.2, and clamp at zero. Do not clamp above
unless the pipeline requires it, highlight values above white are meaningful downstream.

---

## 9. CFA phase handling

`phase(r, c)` is given by the sensor's 2×2 pattern (RGGB, BGGR, GRBG, GBRG). Only two derived
predicates are needed, and both hold for all four patterns:

**Which sites are red/blue.** A pixel is a red or blue site iff its column parity matches that of the
first red/blue site in its row. Taking `phase` as an index with red = 0, green = 1, blue = 2:

```
(r, c) is a red/blue site  ⟺  c ≡ (phase(r, 0) index) (mod 2)
(r, c) is a green site     ⟺  c ≡ (phase(r, 1) index) (mod 2)
```

Both hold because the green index is 1 and both red and blue indices are even, so the low bit of the
index at column 0 selects the correct column parity in every pattern. The set of red/blue sites is
one checkerboard sub-lattice and the greens are the other; the row-to-row parity alternates.

**Which chroma is missing at a red/blue site.** With the same indexing, the missing channel index is
`2 − (index of phase(r, c))`, which maps red ↔ blue and is what stage E reconstructs.

Beyond these two facts the algorithm is phase-agnostic:

- Stages A and B are pure convolutions of the mosaic and know nothing about phase (§3.2 and §4 hold
  at every site). B is merely *evaluated* only on the red/blue lattice because only that is read.
- Stage C applies unchanged at red and blue sites alike; nothing in §5 distinguishes them, because
  the ratio is taken on the achromatic `L`, which is the same combination at both (§4).
- Stage E applies unchanged at red and blue sites; only the identity of `C₀` differs.
- Stage F applies unchanged at all green sites and for both channels; §7 explains why no branch on
  which chroma lies vertically is needed.

There is no code path anywhere that depends on *which* of the four patterns the sensor uses, only on
the two parities above.

---

## 10. Borders, margins and the valid region

Every stage reads outside its output pixel, and the reaches compose. Working outward:

| Quantity at `p` | Reads | Cumulative reach from `p` |
|---|---|---|
| `L` | mosaic ±1 | 1 |
| `h_d` | mosaic ±3 along `d` | 3 |
| `E_d` (hence `tH`, `tQ`) | `h_d` at ±1 along `d` | 4 |
| refined `t*` | field at the 4 diagonal neighbours | 5 |
| stage C green | mosaic ±4; `L` at ±2; `t*` | 5 |
| stage E chroma | mosaic ±3 diag; green at ±2 diag; `t*` from `tQ` | 7 |
| stage F chroma | green at ±2; stage-E chroma at ±3 | 10 |

So a pixel's output is fully determined only if it is at least **10 pixels** from the edge of the
available data. That is the number to use for tile overlap if the image is processed in tiles.

At the true image border there is nothing to read, so the outer margin must be produced some other
way. Established practice:

- Fill the whole frame first with a cheap demosaicer, then overwrite the interior with RCD; or
  equivalently run RCD first and patch the margin afterwards.
- **9 pixels** is the margin usually replaced at the image edge, one less than the tile overlap. The
  slack exists because the outermost dependency, the neighbourhood mean in §3.5 reaching one pixel
  beyond where the energy field is defined; degrades gracefully rather than producing garbage,
  *provided the field is zero-filled outside its valid region* rather than left uninitialised. Zero
  there means "all energy is horizontal/anti-diagonal", which is wrong but bounded; uninitialised
  memory is not.
- For the fill itself, anything reasonable will do at 9 pixels: a gradient-corrected bilinear method,
  or in the degenerate case of an image smaller than about 20 pixels on a side, the average of each
  channel's samples within a 3×3 neighbourhood, ignoring out-of-frame taps.

If the implementation instead clamps coordinates at the frame edge and lets RCD run to the border,
expect visible artefacts in that margin: the kernels of §3 become asymmetric under clamping, which
biases the direction decision exactly where there is least evidence.

---

## 11. Guards and numerical protection, complete list

| Location | Guard | Value |
|---|---|---|
| Input (§2.2) | clamp below | 0 |
| Directional energy (§3.3) | floor before forming the ratio | `ε² = 1e-10` |
| Refined blend weight (§3.5) | clamp to `[0, 1]` | n/a |
| Every gradient (§5.1, §6.1, §7.1) | additive term, making each ≥ `ε` and each denominator ≥ `2ε` | `ε = 1e-5` |
| Low-pass ratio denominator (§5.2) | additive term | `ε = 1e-5` |
| Stage outputs (§5.3, §6.2, §7.2) | clamp to `[0, 1]` | optional, see notes |
| Final output (§8) | clamp below | 0 |

There is no other division anywhere. Every denominator in the algorithm is either a sum of two
gradients (each ≥ `ε`, so ≥ `2ε`), a sum of two floored energies (≥ `2ε²`), or the low-pass sum
(≥ `ε` given non-negative input). None can reach zero, so no branch on a zero denominator is needed
and none should be added; a conditional there is dead code that only obscures the invariant.

---

## 12. Implementation-order constraints

The only orderings that are forced:

```
A ─┐
B ─┼─→ C ─┬─→ E ─→ F
D ─┘      └──────→ ┘
```

- A, B, D read only the conditioned mosaic and may run in any order or concurrently.
- C requires A and B complete over its read footprint.
- E requires C and D.
- F requires E (§7) and C, and re-reads A.

Within a stage every output pixel is independent of every other output pixel of that stage, so each
stage is a pure map over its site set, trivially parallel, and safe to express as one dispatch per
stage. No stage writes a location another pixel of the same stage reads.

---

## 13. Known variation between published implementations

Points where the widely deployed versions differ from the original release and from each other, so
that a reimplementation's output can be reconciled with a reference:

1. **Expanded versus factored energy.** The original writes §3.3 as the expanded quadratic form of
   §3.3's table; later versions use the three-squared-responses form. These are exactly equal in
   real arithmetic and differ only in floating-point rounding.
2. **Low-pass normalisation.** Normalised (`1/16`) versus unnormalised (`×4`) kernel in §4, which
   shifts the effective `ε` in §5.2 by 4× and nothing else.
3. **`ε` placement in the ratio.** Denominator only, versus also in the numerator as `2L + ε`.
4. **Intermediate clamping.** The original clamps each stage's output to `[0, 1]`; the deployed
   derivatives clamp only the blend weight and the final output.
5. **Input clamping.** Clamp to `[0, 1]` versus clamp at zero only, differing solely above white.
6. **Diagonal energy lattice.** The deployed derivatives evaluate the diagonal high-pass responses
   on a column-decimated grid, so one or two of the three terms of `E_P`/`E_Q` are taken one column
   across from the position §3.3 specifies. This is a memory-layout shortcut, described in
   `rcd-optimisation-notes.md`; §3.3 as written here is the exact definition and is what a fresh
   implementation should do.

---

## 14. How this project uses it

The specification above is complete on its own terms but leaves the surrounding pipeline open.
These are this repository's answers, recorded here so the shader and its caller cannot drift apart.

- **Black level, white level and white balance are all applied before RCD**, in one conditioning
  pass: `M` is `min((raw − black) / (white − black), 1) · gain`, per-position black (Bayer sensors
  report four, and the two greens differ). §4 is untouched by the gain,
  because the kernel's colour weights are ¼·R + ½·G + ¼·B at *every* phase whatever fixed
  per-channel scale the samples carry - a gain is per colour, not per phase, so it cannot put a CFA
  modulation back into `L`. The upper clip is not §2.2's either: it sits *ahead* of the gain,
  because that is where the photosite's own information stops, and the gains are scaled so the
  largest is one so that `M` still lands in the unit interval §2.2 asks for. A channel's ceiling is
  then its own gain, and a pixel sitting on all three is what `assemble.slang` renders neutral.
- **No clamp at zero on samples: not §2.2's on the input, not §8's on the output, not §13.4's
  between stages.** Read noise straddles the black level, and a floor keeps the upper half of it,
  lifting every dark channel by a share of its own noise - which the white balance multiplies
  unequally, so a high-ISO shadow comes out purple. Negative light travels to the gamut step, which
  has all three channels to clip against. §2.2's reason for the clamp is kept where it applies,
  in §5.2's ratio, taken in §13.3's `(2L + ε)` form: each low-pass is floored at zero there, so the
  ratio stays in `(0, 2)` where a sum through zero would give anything at all, and a pair with no
  light in either gives one - no correction - rather than a zero that would take the estimate with
  it. Every other denominator in §11 is a sum of `ε`-floored gradients or energies and holds for any
  sign of input.
- **`whitelevel` is a scalar** for this purpose, and `decode_rawler::saturation_of` is the only place
  that decides which one. It sets the scale at which `ε` means what §2.1 intends, and it is what a
  channel is clipped against, so it decides which pixels reach `assemble.slang` reading as blown.
- **Bayer only.** A non-Bayer CFA is refused rather than approximated. `denoise_mosaic` already
  declines X-Trans and Foveon for the same reason, and the library this serves contains no such
  files.
- **The blend fields are zero-filled by the stage that writes them**, over the full frame, before
  any values are computed. §10 requires it and leaves ownership open; putting it on the producer
  means no consumer has to know where the valid region ends.
- **Borders.** The outer 10 pixels are filled by bilinear interpolation of each channel over its own
  samples, and RCD writes the interior. §10's margin analysis is what sets the 10.
