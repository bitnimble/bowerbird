// Ratio Corrected Demosaicing, implemented from `docs/rcd-algorithm-spec.md`.
//
// Section numbers below refer to the specification. It is the normative document; where a comment
// here disagrees with it, it is this file that is wrong.

// The frame, the pattern, the border fill and the margin come from here, shared with every other
// demosaic. `Shape::margin` is what the specification's reach analysis (§10) fixes.
import mosaic;

// **Every binding is spelled out.** Slang assigns them in an order that is not declaration order
// when it is left to, and the host's bind group layouts are written by hand against these numbers.
// Group 0 is the module's; these are the working planes.
[vk::binding(0, 1)] RWStructuredBuffer<float> lowpass;
[vk::binding(1, 1)] RWStructuredBuffer<float> field_axis;
[vk::binding(2, 1)] RWStructuredBuffer<float> field_diag;
[vk::binding(3, 1)] RWStructuredBuffer<float> green;
[vk::binding(4, 1)] RWStructuredBuffer<float> red;
[vk::binding(5, 1)] RWStructuredBuffer<float> blue;
[vk::binding(6, 1)] RWStructuredBuffer<float> rgb;

// §2.1. Both guards are stated for input scaled to roughly the unit interval, which §2.2 is what
// guarantees. Do not fold one into the other; they are used independently.
static const float EPS = 1e-5;
static const float EPS_SQ = 1e-10;

/// `mosaic::index` under the name every stage below already calls it.
uint idx(int r, int c)
{
    return index(r, c);
}

float m_at(int r, int c)
{
    return sample(r, c);
}

bool is_green_site(int r, int c)
{
    return colour_at(r, c) == 1;
}

// **Each stage passes its own reach to `mosaic::interior`, not the frame's margin, and the
// difference is a defect if it is got wrong.** §10's table is cumulative from the mosaic: a stage
// can compute correctly wherever *its own* inputs are valid, which for the early stages is nearer
// the edge than the final margin of 10. Gating every stage at 10 leaves a band where a later stage
// reads a site an earlier one declined to write - the seeded zero, not a reconstructed value -
// which is a ring of wrong colour just inside the border fill, on every frame.
//
/// §10's cumulative reaches, which are what each stage may write out to.
static const int REACH_FIELD = 4;  // E_d, from h_d at +-1 along d
static const int REACH_GREEN = 5;  // stage C, and the refined t* it takes
static const int REACH_CHROMA = 7; // stage E, from green at +-2 diagonal

// ---------------------------------------------------------------------------
// Stage A and D: the directional blend fields (§3)
// ---------------------------------------------------------------------------

/// The 7-tap high-pass response along a direction (§3.1). Its kernel sums to zero over each of the
/// two interleaved CFA phases separately, which is what makes it blind to a per-channel offset or
/// gain - the local signature of lateral chromatic aberration (§3.2).
float response(int r, int c, int dr, int dc)
{
    let far = m_at(r - 3 * dr, c - 3 * dc) + m_at(r + 3 * dr, c + 3 * dc);
    let mid = m_at(r - 2 * dr, c - 2 * dc) + m_at(r + 2 * dr, c + 2 * dc);
    let near = m_at(r - dr, c - dc) + m_at(r + dr, c + dc);
    return far - 3.0 * mid - near + 6.0 * m_at(r, c);
}

/// Energy in a direction: the sum of three squared responses taken along that same direction,
/// floored so a perfectly flat patch yields exactly no preference rather than a division by zero
/// (§3.3).
float energy(int r, int c, int dr, int dc)
{
    let a = response(r - dr, c - dc, dr, dc);
    let b = response(r, c, dr, dc);
    let d = response(r + dr, c + dc, dr, dc);
    return max(EPS_SQ, a * a + b * b + d * d);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void fields(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    let at = idx(r, c);

    // Zero outside the valid region, which §10 requires and §3.5 relies on: the refinement reaches
    // one pixel further than the field is defined, and zero there is wrong but bounded where
    // uninitialised memory is not.
    if (!interior(r, c, REACH_FIELD)) {
        field_axis[at] = 0.0;
        field_diag[at] = 0.0;
        return;
    }

    let e_v = energy(r, c, 1, 0);
    let e_h = energy(r, c, 0, 1);
    field_axis[at] = e_v / (e_v + e_h);

    let e_p = energy(r, c, 1, 1);
    let e_q = energy(r, c, 1, -1);
    field_diag[at] = e_p / (e_p + e_q);
}

/// §3.5. No consumer uses a field at its own pixel directly: it takes whichever of the centre and
/// the mean of the four diagonal neighbours is further from 0.5, i.e. the more decisive of the two
/// opinions. This is what stops thin oriented structure being averaged away where the local
/// statistic happens to be weak.
float refine_axis(int r, int c)
{
    let centre = field_axis[idx(r, c)];
    let mean = 0.25 * (field_axis[idx(r - 1, c - 1)] + field_axis[idx(r - 1, c + 1)]
                     + field_axis[idx(r + 1, c - 1)] + field_axis[idx(r + 1, c + 1)]);
    float t = centre;
    if (abs(0.5 - centre) < abs(0.5 - mean)) { t = mean; }
    return clamp(t, 0.0, 1.0);
}

float refine_diag(int r, int c)
{
    let centre = field_diag[idx(r, c)];
    let mean = 0.25 * (field_diag[idx(r - 1, c - 1)] + field_diag[idx(r - 1, c + 1)]
                     + field_diag[idx(r + 1, c - 1)] + field_diag[idx(r + 1, c + 1)]);
    float t = centre;
    if (abs(0.5 - centre) < abs(0.5 - mean)) { t = mean; }
    return clamp(t, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Stage B: the low-pass luminance (§4)
// ---------------------------------------------------------------------------

/// A binomial 3x3 over the mosaic. The one kernel that yields the same achromatic combination -
/// a quarter red, half green, a quarter blue - at every Bayer phase, so the result carries no
/// residual CFA modulation despite nothing having been demosaiced yet. That is what makes it a
/// luminance stage C can take a ratio of.
[shader("compute")]
[numthreads(8, 8, 1)]
void low_pass(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }

    let centre = m_at(r, c);
    let edges = m_at(r - 1, c) + m_at(r + 1, c) + m_at(r, c - 1) + m_at(r, c + 1);
    let corners = m_at(r - 1, c - 1) + m_at(r - 1, c + 1) + m_at(r + 1, c - 1) + m_at(r + 1, c + 1);
    lowpass[idx(r, c)] = 0.25 * centre + 0.125 * edges + 0.0625 * corners;
}

/// Seeds each plane with the channel the sensor actually sampled there, so the later stages only
/// ever fill in what is genuinely missing.
[shader("compute")]
[numthreads(8, 8, 1)]
void seed(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    let at = idx(r, c);
    let v = m_at(r, c);
    let p = colour_at(r, c);

    green[at] = select(p == 1, v, 0.0);
    red[at] = select(p == 0, v, 0.0);
    blue[at] = select(p == 2, v, 0.0);
}

// ---------------------------------------------------------------------------
// Stage C: green at red and blue sites (§5)
// ---------------------------------------------------------------------------

/// §5.2's `2 L0 / (L0 + L2)`, in §13.3's form with `EPS` above the line as well. A ratio of lights
/// exists only above black, so each low-pass is floored at zero - and a pair with no light in either
/// then asks for no correction, a ratio of one, rather than a zero that would take the estimate
/// with it.
float ratio(float l0, float l2)
{
    let here = max(l0, 0.0);
    return (2.0 * here + EPS) / (here + max(l2, 0.0) + EPS);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void green_at_chroma(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    if (is_green_site(r, c) || !interior(r, c, REACH_GREEN)) { return; }

    // §5.1. Each gradient mixes green-to-green differences at spacing two with centre-colour
    // differences at spacing two, so it measures activity on both phases along that direction. The
    // leading term is shared within each opposing pair.
    let v_axis = abs(m_at(r - 1, c) - m_at(r + 1, c));
    let h_axis = abs(m_at(r, c - 1) - m_at(r, c + 1));
    let g_n = EPS + v_axis + abs(m_at(r, c) - m_at(r - 2, c)) + abs(m_at(r - 1, c) - m_at(r - 3, c)) + abs(m_at(r - 2, c) - m_at(r - 4, c));
    let g_s = EPS + v_axis + abs(m_at(r, c) - m_at(r + 2, c)) + abs(m_at(r + 1, c) - m_at(r + 3, c)) + abs(m_at(r + 2, c) - m_at(r + 4, c));
    let g_w = EPS + h_axis + abs(m_at(r, c) - m_at(r, c - 2)) + abs(m_at(r, c - 1) - m_at(r, c - 3)) + abs(m_at(r, c - 2) - m_at(r, c - 4));
    let g_e = EPS + h_axis + abs(m_at(r, c) - m_at(r, c + 2)) + abs(m_at(r, c + 1) - m_at(r, c + 3)) + abs(m_at(r, c + 2) - m_at(r, c + 4));

    // §5.2, the ratio correction that names the algorithm. Each adjacent green sample is rescaled by
    // the ratio of the low-pass value here to the mean of the low-pass values here and two pixels
    // out. Hamilton-Adams adds half a difference of raw same-colour samples instead, which on a hard
    // edge can push the estimate past both bracketing samples and show as a coloured fringe; a
    // multiplicative correction taken in a smoothed achromatic domain cannot swing nearly as far.
    let l0 = lowpass[idx(r, c)];
    let e_n = m_at(r - 1, c) * ratio(l0, lowpass[idx(r - 2, c)]);
    let e_s = m_at(r + 1, c) * ratio(l0, lowpass[idx(r + 2, c)]);
    let e_w = m_at(r, c - 1) * ratio(l0, lowpass[idx(r, c - 2)]);
    let e_e = m_at(r, c + 1) * ratio(l0, lowpass[idx(r, c + 2)]);

    // §5.3. Inverse-gradient weighting: each estimate carries the gradient of the opposite
    // direction, so the locally smoother side contributes more.
    let est_v = (g_s * e_n + g_n * e_s) / (g_n + g_s);
    let est_h = (g_w * e_e + g_e * e_w) / (g_e + g_w);

    let t = refine_axis(r, c);
    green[idx(r, c)] = lerp(est_v, est_h, t);
}

// ---------------------------------------------------------------------------
// Stage E: the missing chroma at red and blue sites (§6)
// ---------------------------------------------------------------------------

[shader("compute")]
[numthreads(8, 8, 1)]
void chroma_at_chroma(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    if (is_green_site(r, c) || !interior(r, c, REACH_CHROMA)) { return; }

    // At a red site the missing channel is blue and vice versa, and the four diagonal neighbours are
    // exactly the sites where it was sampled directly.
    let nw = m_at(r - 1, c - 1);
    let ne = m_at(r - 1, c + 1);
    let sw = m_at(r + 1, c - 1);
    let se = m_at(r + 1, c + 1);

    // §6.1. Same shape as the cardinal gradients but along the diagonals, mixing a chroma term with
    // a green term. The green reads at spacing two land on red/blue sites, where stage C filled them.
    let main_pair = abs(nw - se);
    let anti_pair = abs(ne - sw);
    let g_nw = EPS + main_pair + abs(nw - m_at(r - 3, c - 3)) + abs(green[idx(r, c)] - green[idx(r - 2, c - 2)]);
    let g_se = EPS + main_pair + abs(se - m_at(r + 3, c + 3)) + abs(green[idx(r, c)] - green[idx(r + 2, c + 2)]);
    let g_ne = EPS + anti_pair + abs(ne - m_at(r - 3, c + 3)) + abs(green[idx(r, c)] - green[idx(r - 2, c + 2)]);
    let g_sw = EPS + anti_pair + abs(sw - m_at(r + 3, c - 3)) + abs(green[idx(r, c)] - green[idx(r + 2, c - 2)]);

    // §6.2. Chroma is a difference method, not a ratio method: the ratio treatment belongs to
    // luminance, where overshoot shows as a fringe. Interpolating the colour difference and adding it
    // back to the reconstructed green is what keeps chroma locked to luminance detail.
    let d_nw = nw - green[idx(r - 1, c - 1)];
    let d_ne = ne - green[idx(r - 1, c + 1)];
    let d_sw = sw - green[idx(r + 1, c - 1)];
    let d_se = se - green[idx(r + 1, c + 1)];

    let est_p = (g_nw * d_se + g_se * d_nw) / (g_nw + g_se);
    let est_q = (g_ne * d_sw + g_sw * d_ne) / (g_ne + g_sw);

    let t = refine_diag(r, c);
    let value = green[idx(r, c)] + lerp(est_p, est_q, t);

    let at = idx(r, c);
    if (colour_at(r, c) == 0) { blue[at] = value; } else { red[at] = value; }
}

// ---------------------------------------------------------------------------
// Stage F: red and blue at green sites (§7)
// ---------------------------------------------------------------------------

/// One channel's reconstruction at a green site. Phase-agnostic by construction: stage E has
/// already given every red/blue site both chroma channels, so this never has to ask which of the
/// two lies vertically.
float chroma_at_green(int r, int c, uint plane, float t)
{
    float n; float s; float w; float e;
    float n3; float s3; float w3; float e3;
    if (plane == 0) {
        n = red[idx(r - 1, c)]; s = red[idx(r + 1, c)];
        w = red[idx(r, c - 1)]; e = red[idx(r, c + 1)];
        n3 = red[idx(r - 3, c)]; s3 = red[idx(r + 3, c)];
        w3 = red[idx(r, c - 3)]; e3 = red[idx(r, c + 3)];
    } else {
        n = blue[idx(r - 1, c)]; s = blue[idx(r + 1, c)];
        w = blue[idx(r, c - 1)]; e = blue[idx(r, c + 1)];
        n3 = blue[idx(r - 3, c)]; s3 = blue[idx(r + 3, c)];
        w3 = blue[idx(r, c - 3)]; e3 = blue[idx(r, c + 3)];
    }

    // §7.1. Three terms each, not four as in the cardinal gradients of stage C. The middle term is
    // shared within each opposing pair; the green reads at spacing two land on green sites, where
    // green is the sensor's own sample.
    let g0 = green[idx(r, c)];
    let vertical_pair = abs(n - s);
    let horizontal_pair = abs(w - e);
    let g_n = EPS + abs(g0 - green[idx(r - 2, c)]) + vertical_pair + abs(n - n3);
    let g_s = EPS + abs(g0 - green[idx(r + 2, c)]) + vertical_pair + abs(s - s3);
    let g_w = EPS + abs(g0 - green[idx(r, c - 2)]) + horizontal_pair + abs(w - w3);
    let g_e = EPS + abs(g0 - green[idx(r, c + 2)]) + horizontal_pair + abs(e - e3);

    let d_n = n - green[idx(r - 1, c)];
    let d_s = s - green[idx(r + 1, c)];
    let d_w = w - green[idx(r, c - 1)];
    let d_e = e - green[idx(r, c + 1)];

    let est_v = (g_n * d_s + g_s * d_n) / (g_n + g_s);
    let est_h = (g_e * d_w + g_w * d_e) / (g_e + g_w);

    return g0 + lerp(est_v, est_h, t);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void chroma_at_greens(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    // The last stage, so its reach is the frame's own margin - the border fill owns everything
    // outside, and there is nothing after this to read what it writes.
    if (!is_green_site(r, c) || !interior(r, c, int(shape.margin))) { return; }

    // The same axis field stage C used, refined the same way, computed once for both channels.
    let t = refine_axis(r, c);
    let at = idx(r, c);
    red[at] = chroma_at_green(r, c, 0, t);
    blue[at] = chroma_at_green(r, c, 2, t);
}

// ---------------------------------------------------------------------------
// Border fill and output assembly (§8, §10)
// ---------------------------------------------------------------------------

[shader("compute")]
[numthreads(8, 8, 1)]
void assemble(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    let at = idx(r, c);

    // The frame's margin, which is exactly where the last stage stopped writing.
    float3 out;
    if (interior(r, c, int(shape.margin))) {
        out = float3(red[at], green[at], blue[at]);
    } else {
        out = filled_margin(r, c);
    }

    rgb[at * 3] = out.x;
    rgb[at * 3 + 1] = out.y;
    rgb[at * 3 + 2] = out.z;
}
