# Luma-chroma demultiplexing for X-Trans, functional specification

The normative document for `slang/lslcd.slang` and `native/rawshim/src/lslcd.rs`. Where a comment in
either disagrees with this file, the code is wrong.

**Section 2 is derived here, not taken from a paper, and the distinction is worth being exact
about.** The framework - a periodic CFA read as a baseband luma plus chroma modulated onto the
pattern's own carriers - is Dubois's, stated for Bayer in *Frequency-domain methods for demosaicking
of Bayer-sampled color images* (IEEE SPL, 2005) and for arbitrary periodic patterns in his 2009
chapter *Color filter array sampling of color images*. Rafinazari and Dubois published the X-Trans
case as *Demosaicking algorithm for the Fujifilm X-Trans color filter array* (ICIP 2014, pp.
660-663); **that paper was not available to whoever wrote this file, and nothing here should be read
as reproducing it.** What §2 asserts stands on its own derivation, which anyone can check: the
coefficients are computed from the mask, the reconstruction inverts exactly, and the same algebra
run on a Bayer period returns the published Bayer result.

Nor is this the least-squares design of Leung, Jeon and Dubois (*Least-squares luma-chroma
demultiplexing algorithm for Bayer demosaicking*, IEEE TIP 20(7), 2011), whose filters are fitted to
the second-order statistics of a set of photographs. §3.3 fits to a model of the chroma spectrum
instead, for the reason given there.

## 1. Scope

Input is a conditioned mosaic: black subtracted, normalised by saturation, white balanced, one
`f32` per photosite, as `decode_rawler::condition` leaves it. Output is three interleaved `f32`
planes of the same extent, in the sensor's own colour space, exactly as RCD leaves them - the
matrix and the highlight reconstruction downstream are shared and unchanged.

The pattern is any period this can decompose (§2.6), which today means Bayer and X-Trans. RCD
remains the Bayer route; this exists because RCD pairs rows and columns into 2x2 sites and X-Trans
has none.

## 2. The decomposition

### 2.1 The mosaic as three multiplexed signals

Let `m_c(n)` be the indicator of colour `c` at photosite `n = (row, col)`, so `Σ_c m_c(n) = 1` and
each `m_c` is periodic with the CFA's period. The mosaic is

    f(n) = Σ_c m_c(n) · f_c(n)

Because each `m_c` is periodic, its Fourier series lives on the reciprocal lattice, and `f` is a sum
of the colour planes modulated onto those frequencies. Since `Σ_c m_c = 1`, the coefficients at
every frequency other than DC sum to zero across colours: **every non-baseband carrier carries a
zero-sum combination of the colour planes, and DC carries their weighted mean.** That is the
luma/chroma split, and it is a property of periodicity rather than of any particular pattern.

### 2.2 The basis

Let one period hold `p` red, `q` green and `p` blue photosites, `N = 2p + q` in total. Define

    L  = (p·R + q·G + p·B) / N
    C1 = R - 2G + B
    C2 = R - B

`L` is the baseband combination §2.1 names. `C1` and `C2` are the two independent zero-sum
combinations, and they are the green-magenta and red-blue opponent signals.

The map inverts exactly:

    G = L - (p/N)·C1
    R = L + (q/2N)·C1 + C2/2
    B = L + (q/2N)·C1 - C2/2

### 2.3 The modulation masks

Substituting §2.2 into §2.1 collapses the whole Fourier argument into two real, period-sized masks:

    f(n) = L(n) + C1(n)·w1(n) + C2(n)·w2(n)

    w1(n) = +q/(2N) where n is red or blue,   -p/N where n is green
    w2(n) = +1/2 where n is red,   -1/2 where n is blue,   0 where n is green

Both masks have zero mean over the period, and they are orthogonal over it - `Σ w1·w2 = 0` whenever
red and blue are equally numerous, which §2.6 requires. Their mean squares are

    K1 = pq / (2N²)     K2 = p / (2N)

For X-Trans (`p=8, q=20, N=36`): `w1` is `5/18` at red and blue and `-2/9` at green, `w2` is `±1/2`,
`K1 = 5/81`, `K2 = 1/9`. For Bayer (`p=1, q=2, N=4`) the same formulae give `w1 = ±1/4` and the
textbook Bayer result, which is the check that §2.2 was not fitted to one pattern.

### 2.4 The carriers

The frequencies `w1` and `w2` place their chroma on are the non-zero terms of their own Fourier
series. For X-Trans, computed over the 6x6 period, there are twelve, in two groups:

    C1 at (0,2) (0,4) (2,0) (4,0) (2,2) (4,4) (2,4) (4,2)
    C2 at (1,3) (3,1) (3,5) (5,3)

in units of one sixth of the sampling frequency. The lowest is `2π/3` radians per sample. **Every
one of them is annihilated by a separable filter whose one-dimensional prototype has nulls at `2π/3`
and at `π`** - each carrier has at least one axis whose index is 2, 3 or 4 - which is why §3 is two
one-dimensional passes and not a 2D kernel.

**That holds for every phase of the pattern, which is what lets the filter be designed once.**
Bodies write different phases of the same 6x6 and name theirs in metadata, so the mask this runs on
is not fixed. A phase is a translation, and translating a mask rotates the phase of each Fourier
coefficient without moving it, so the carrier positions are the same set for all of them; a
reflection sends `k` to `-k`, and `{0,2,3,4}` is closed under negation modulo 6. Neither can put a
carrier where the prototype does not have a null. `the_carriers_survive_every_phase` holds the
claim to the arithmetic rather than to this paragraph.

Bayer's carriers are `(1,1)` for `C1` and `(1,0)`, `(0,1)` for `C2`, all at `π`, so the same
prototype serves with only the `π` null load-bearing.

### 2.5 Estimation

    Ĉ1 = LP(f · w1) / K1
    Ĉ2 = LP(f · w2) / K2
    L̂  = f - Ĉ1·w1 - Ĉ2·w2

Multiplying by `w1` demodulates every carrier of `C1` to baseband; the lowpass keeps it. The three
cross terms all land away from baseband and are rejected by the same filter: `L·w1` sits at the
carriers because `w1` has no DC, `C1·w1²` contributes `K1·C1` at baseband and the rest at carrier
sums, and `C2·w1·w2` has no baseband term because the two masks are orthogonal.

**Luma is recovered by subtraction, not by lowpassing, and that is the whole point.** A lowpass
estimate of luma would throw away exactly the detail the sensor spends most of its photosites
collecting. Subtracting the chroma estimate leaves luma at full bandwidth, and any chroma the filter
failed to capture stays in luma as detail rather than becoming a colour error.

### 2.6 What this cannot decompose

`p_red ≠ p_blue` breaks the orthogonality §2.5 relies on, and a period holding a colour outside red,
green and blue has no place in §2.2 at all. `Cfa::is_bayer` and `Cfa::is_xtrans` are the gates; a
pattern passing neither is refused rather than rendered, because the failure is a picture of the
right shape in the wrong colours, which nothing downstream can detect.

## 3. The filter

### 3.1 Form

Separable, the same symmetric one-dimensional prototype `h` on each axis, odd length `2M+1`,
`h[-i] = h[i]`. Its amplitude response is

    A(ω) = h₀ + 2·Σ_{i=1..M} h_i·cos(i·ω)

`M = 8`. That is the radius the margin in §5 comes from.

Not smaller: with four constraints spent on §3.2, `M = 6` leaves three degrees of freedom, and they do
not stretch to both halves of §3.3 - suppressing the stopband to 6% pushed the droop at the top of
the chroma band to 8%, and relaxing one merely moved the error to the other. `M = 8` holds both
under 6%, at four more taps on each of two separable passes.

### 3.2 Constraints

Four equalities, imposed exactly rather than fitted:

    A(0)    = 1      the chroma estimate carries no gain error, so no colour cast
    A(2π/3) = 0      the nearest carrier group
    A'(2π/3)= 0      a double zero, because a carrier is modulated by a signal with bandwidth
                     and so occupies a neighbourhood rather than a point
    A(π)    = 0      the remaining carriers

`A'(π) = 0` holds for every symmetric odd-length filter and is not imposed.

### 3.3 The least-squares part

The remaining freedom minimises

    J(h) = ∫₀^π w(ω)·(A(ω) - D(ω))² dω,   w = 8 past the nearest carrier, 1 below it

against the ideal chroma response

    D(ω) = 1 for ω ≤ π/3,  0 for ω ≥ 2π/3,  raised cosine between

`π/3` is where the passband has to stop: chroma modulated onto the `2π/3` carrier occupies a band
around it, and anything wider aliases the carrier into the estimate.

**The weight is not cosmetic, and the two errors are not worth the same.** Ripple below the passband
edge tilts chroma across its own band, which reads as a slight shift in saturation on very fine
coloured detail. What leaks through the stopband is a carrier surviving demodulation, which reads as
a colour that is not in the scene, laid out on the pattern's own 6x6 period. Weighting them equally
spends the filter's freedom on the one nobody sees.

**The target is a model of the chroma spectrum, not a training set**, and that is the one place this
is knowingly weaker than the least-squares design it is named after. Fitting to measured statistics
needs a set of photographs this repository cannot carry or reproduce, and a filter fitted to
eight-bit sRGB snapshots is not obviously the filter for a linear HDR mosaic. Swapping the target
for measured statistics changes `design` and nothing else.

Minimising `J` subject to §3.2 is one linear system in `M+1` coefficients and four multipliers,
solved by `fit::gaussian`. `R_ij = ∫ φ_i φ_j`, `p_i = ∫ φ_i D`, `φ₀ = 1`, `φ_i = 2cos(iω)`,
evaluated by uniform quadrature; the KKT system is

    [ 2R  Cᵀ ] [ h ]   [ 2p ]
    [ C   0  ] [ λ ] = [ b  ]

## 4. Order of operations

1. `modulate_h`: for each site, `u1 = f·w1`, `u2 = f·w2`, then the horizontal pass of `h` over both.
2. `filter_v`: the vertical pass of `h` over both, giving `K1·Ĉ1` and `K2·Ĉ2`.
3. `assemble`: divide by `K1`, `K2`; `L̂` by §2.5; `R`, `G`, `B` by §2.2.

Each stage is a pure map over its sites, so each is one dispatch and nothing inside a stage depends
on anything else that stage writes.

## 5. Borders

The horizontal pass reaches `M` columns and the vertical `M` rows, so nothing within `M = 8` of an
edge has a usable chroma estimate. Those sites are not demultiplexed: each output channel is the
mean of that colour's samples in a 5x5 neighbourhood, falling back to the site's own value where the
neighbourhood holds none of that colour. The interior of the frame is never reached by this.

A region lifted out of a frame is subject to `Cfa::aligned`: its origin must sit on a whole period or
every photosite in it carries the wrong colour, and `w1` and `w2` are read by position.

## 6. Clamping

None, in either direction. A value above white is still meaningful to the grade, and clipping it
inside the demosaic discards a highlight the reconstruction downstream still had a use for; a value
below black is read noise straddling the black level, and a floor there keeps the upper half of it
and lifts every dark channel - the reason `rcd-algorithm-spec.md` §14 gives. Both ends are settled
by `assemble.slang`'s gamut step, where all three channels exist at once.

## 7. What is deliberately not here

**The adaptive variant.** Rafinazari and Dubois report both a fixed and a direction-adaptive scheme,
the second estimating chroma along each axis separately and blending by local energy. This is the
first. The cost is visible where fine detail is strongly coloured, and the structure to add it is a
second filter bank and a blend field, not a different decomposition.

**Where RCD's machinery would be borrowed from, if it is.** The two demosaics are less far apart
than they look, and the map is worth having written down before anyone tries to merge them.

- RCD's low-pass (§4 of its own specification) is this filter's Bayer case exactly. "The one kernel
  that yields the same achromatic combination at every Bayer phase" is "a kernel whose response is
  zero at every carrier of the Bayer mask", and `[1,2,1]/4` is the shortest prototype meeting §3.2
  with only the `π` null load-bearing.
- RCD's directional energy does **not** carry over as written. Its kernel is blind to a per-channel
  gain because a Bayer line alternates between two colours with period 2 everywhere; an X-Trans line
  runs a period-6 sequence that differs by row, so no fixed kernel has that property and a
  per-position family of them makes `e_v` and `e_h` incomparable between sites. What does carry over
  is the statistic computed on `L̂` instead of on the mosaic: luma carries no modulation, so a
  directional derivative on it means one thing everywhere. That is the shape the adaptive variant
  above should take.
- RCD's three interpolation stages carry over not at all. Each is a statement about which colour sits
  at a Bayer site's cardinal and diagonal neighbours, and every one of those statements is false
  here.

**Chroma at full rate.** `Ĉ1` and `Ĉ2` are bandlimited to `π/3` by construction, so they are
computed at nine times the density they carry information at. Decimating the two chroma passes and
interpolating back would cost most of the filter's arithmetic. Worth doing if the bench asks; not
worth doing before it does.
