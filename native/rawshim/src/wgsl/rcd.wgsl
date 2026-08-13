// Ratio Corrected Demosaicing, implemented from `docs/rcd-algorithm-spec.md`.
//
// **Server-only, which is why this is not under `web/` with the others.** Every other shader in
// this project is shared verbatim with the browser because the editor's tick has to draw what a
// rendition ships. Demosaicing is not one of those: the page is handed an already-demosaiced
// frame, so putting this in the web tree would ship it to a bundle that never calls it.
//
// Section numbers below refer to the specification. It is the normative document; where a comment
// here disagrees with it, it is this file that is wrong.

// Scalars rather than a `vec4` or an `array`: in the uniform address space both carry alignment
// rules that silently change the struct's size (a `vec4<u32>` aligns to 16, an array's elements
// stride by 16), and the host writes these bytes by hand.
struct Params {
  width: u32,
  height: u32,
  // The sensor's 2x2 pattern, row-major from the top-left of the frame: 0 red, 1 green, 2 blue.
  cfa0: u32,
  cfa1: u32,
  cfa2: u32,
  cfa3: u32,
  // Pixels at the frame edge that RCD does not write; filled by a cheap interpolation instead.
  // The specification's reach analysis (§10) is where this number comes from.
  margin: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> mosaic: array<f32>;

@group(1) @binding(0) var<storage, read_write> lowpass: array<f32>;
@group(1) @binding(1) var<storage, read_write> field_axis: array<f32>;
@group(1) @binding(2) var<storage, read_write> field_diag: array<f32>;
@group(1) @binding(3) var<storage, read_write> green: array<f32>;
@group(1) @binding(4) var<storage, read_write> red: array<f32>;
@group(1) @binding(5) var<storage, read_write> blue: array<f32>;
@group(1) @binding(6) var<storage, read_write> rgb: array<f32>;

// §2.1. Both guards are stated for input scaled to roughly the unit interval, which §2.2 is what
// guarantees. Do not fold one into the other; they are used independently.
const EPS: f32 = 1e-5;
const EPS_SQ: f32 = 1e-10;

fn idx(r: i32, c: i32) -> u32 {
  let rr = clamp(r, 0, i32(params.height) - 1);
  let cc = clamp(c, 0, i32(params.width) - 1);
  return u32(rr) * params.width + u32(cc);
}

fn m_at(r: i32, c: i32) -> f32 {
  return mosaic[idx(r, c)];
}

/// The CFA colour at a pixel: 0 red, 1 green, 2 blue.
fn phase(r: i32, c: i32) -> u32 {
  let which = (u32(r & 1) << 1u) | u32(c & 1);
  if (which == 0u) { return params.cfa0; }
  if (which == 1u) { return params.cfa1; }
  if (which == 2u) { return params.cfa2; }
  return params.cfa3;
}

fn is_green_site(r: i32, c: i32) -> bool {
  return phase(r, c) == 1u;
}

/// True where the pixel is at least `m` from every edge.
///
/// **Each stage passes its own reach, not the frame's margin, and the difference is a defect if it
/// is got wrong.** §10's table is cumulative from the mosaic: a stage can compute correctly wherever
/// *its own* inputs are valid, which for the early stages is nearer the edge than the final margin
/// of 10. Gating every stage at 10 leaves a band where a later stage reads a site an earlier one
/// declined to write - the seeded zero, not a reconstructed value - which is a ring of wrong colour
/// just inside the border fill, on every frame.
fn interior(r: i32, c: i32, m: i32) -> bool {
  return r >= m && c >= m && r < i32(params.height) - m && c < i32(params.width) - m;
}

/// §10's cumulative reaches, which are what each stage may write out to.
const REACH_FIELD: i32 = 4;  // E_d, from h_d at +-1 along d
const REACH_GREEN: i32 = 5;  // stage C, and the refined t* it takes
const REACH_CHROMA: i32 = 7; // stage E, from green at +-2 diagonal

// ---------------------------------------------------------------------------
// Stage A and D: the directional blend fields (§3)
// ---------------------------------------------------------------------------

/// The 7-tap high-pass response along a direction (§3.1). Its kernel sums to zero over each of the
/// two interleaved CFA phases separately, which is what makes it blind to a per-channel offset or
/// gain - the local signature of lateral chromatic aberration (§3.2).
fn response(r: i32, c: i32, dr: i32, dc: i32) -> f32 {
  let far = m_at(r - 3 * dr, c - 3 * dc) + m_at(r + 3 * dr, c + 3 * dc);
  let mid = m_at(r - 2 * dr, c - 2 * dc) + m_at(r + 2 * dr, c + 2 * dc);
  let near = m_at(r - dr, c - dc) + m_at(r + dr, c + dc);
  return far - 3.0 * mid - near + 6.0 * m_at(r, c);
}

/// Energy in a direction: the sum of three squared responses taken along that same direction,
/// floored so a perfectly flat patch yields exactly no preference rather than a division by zero
/// (§3.3).
fn energy(r: i32, c: i32, dr: i32, dc: i32) -> f32 {
  let a = response(r - dr, c - dc, dr, dc);
  let b = response(r, c, dr, dc);
  let d = response(r + dr, c + dc, dr, dc);
  return max(EPS_SQ, a * a + b * b + d * d);
}

@compute @workgroup_size(8, 8)
fn fields(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
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
fn refine_axis(r: i32, c: i32) -> f32 {
  let centre = field_axis[idx(r, c)];
  let mean = 0.25 * (field_axis[idx(r - 1, c - 1)] + field_axis[idx(r - 1, c + 1)]
                   + field_axis[idx(r + 1, c - 1)] + field_axis[idx(r + 1, c + 1)]);
  var t = centre;
  if (abs(0.5 - centre) < abs(0.5 - mean)) { t = mean; }
  return clamp(t, 0.0, 1.0);
}

fn refine_diag(r: i32, c: i32) -> f32 {
  let centre = field_diag[idx(r, c)];
  let mean = 0.25 * (field_diag[idx(r - 1, c - 1)] + field_diag[idx(r - 1, c + 1)]
                   + field_diag[idx(r + 1, c - 1)] + field_diag[idx(r + 1, c + 1)]);
  var t = centre;
  if (abs(0.5 - centre) < abs(0.5 - mean)) { t = mean; }
  return clamp(t, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Stage B: the low-pass luminance (§4)
// ---------------------------------------------------------------------------

/// A binomial 3x3 over the mosaic. The one kernel that yields the same achromatic combination -
/// a quarter red, half green, a quarter blue - at every Bayer phase, so the result carries no
/// residual CFA modulation despite nothing having been demosaiced yet. That is what makes it safe
/// to divide by in stage C.
@compute @workgroup_size(8, 8)
fn low_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }

  let centre = m_at(r, c);
  let edges = m_at(r - 1, c) + m_at(r + 1, c) + m_at(r, c - 1) + m_at(r, c + 1);
  let corners = m_at(r - 1, c - 1) + m_at(r - 1, c + 1) + m_at(r + 1, c - 1) + m_at(r + 1, c + 1);
  lowpass[idx(r, c)] = 0.25 * centre + 0.125 * edges + 0.0625 * corners;
}

/// Seeds each plane with the channel the sensor actually sampled there, so the later stages only
/// ever fill in what is genuinely missing.
@compute @workgroup_size(8, 8)
fn seed(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
  let at = idx(r, c);
  let v = m_at(r, c);
  let p = phase(r, c);

  green[at] = select(0.0, v, p == 1u);
  red[at] = select(0.0, v, p == 0u);
  blue[at] = select(0.0, v, p == 2u);
}

// ---------------------------------------------------------------------------
// Stage C: green at red and blue sites (§5)
// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8)
fn green_at_chroma(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
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
  let twice = 2.0 * l0;
  let e_n = m_at(r - 1, c) * twice / (l0 + lowpass[idx(r - 2, c)] + EPS);
  let e_s = m_at(r + 1, c) * twice / (l0 + lowpass[idx(r + 2, c)] + EPS);
  let e_w = m_at(r, c - 1) * twice / (l0 + lowpass[idx(r, c - 2)] + EPS);
  let e_e = m_at(r, c + 1) * twice / (l0 + lowpass[idx(r, c + 2)] + EPS);

  // §5.3. Inverse-gradient weighting: each estimate carries the gradient of the opposite
  // direction, so the locally smoother side contributes more.
  let est_v = (g_s * e_n + g_n * e_s) / (g_n + g_s);
  let est_h = (g_w * e_e + g_e * e_w) / (g_e + g_w);

  let t = refine_axis(r, c);
  // Below only. White balance normalises green to unity, so red and blue arrive already scaled by
  // their gain and a bright one sits well above 1.0; clamping there is clipping a highlight inside
  // the demosaic, where the grade downstream still had use for it (§8).
  green[idx(r, c)] = max(mix(est_v, est_h, t), 0.0);
}

// ---------------------------------------------------------------------------
// Stage E: the missing chroma at red and blue sites (§6)
// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8)
fn chroma_at_chroma(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
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
  let value = max(green[idx(r, c)] + mix(est_p, est_q, t), 0.0);

  let at = idx(r, c);
  if (phase(r, c) == 0u) { blue[at] = value; } else { red[at] = value; }
}

// ---------------------------------------------------------------------------
// Stage F: red and blue at green sites (§7)
// ---------------------------------------------------------------------------

/// One channel's reconstruction at a green site. Phase-agnostic by construction: stage E has
/// already given every red/blue site both chroma channels, so this never has to ask which of the
/// two lies vertically.
fn chroma_at_green(r: i32, c: i32, plane: u32, t: f32) -> f32 {
  var n: f32; var s: f32; var w: f32; var e: f32;
  var n3: f32; var s3: f32; var w3: f32; var e3: f32;
  if (plane == 0u) {
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

  return max(g0 + mix(est_v, est_h, t), 0.0);
}

@compute @workgroup_size(8, 8)
fn chroma_at_greens(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
  // The last stage, so its reach is the frame's own margin - the border fill owns everything
  // outside, and there is nothing after this to read what it writes.
  if (!is_green_site(r, c) || !interior(r, c, i32(params.margin))) { return; }

  // The same axis field stage C used, refined the same way, computed once for both channels.
  let t = refine_axis(r, c);
  let at = idx(r, c);
  red[at] = chroma_at_green(r, c, 0u, t);
  blue[at] = chroma_at_green(r, c, 2u, t);
}

// ---------------------------------------------------------------------------
// Border fill and output assembly (§8, §10)
// ---------------------------------------------------------------------------

/// The mean of a colour's samples over a small neighbourhood, ignoring taps of other colours. Only
/// used in the outer margin, where RCD has nothing to read and any reasonable interpolation will do.
fn nearby_mean(r: i32, c: i32, want: u32) -> f32 {
  var total = 0.0;
  var count = 0.0;
  for (var dr = -1; dr <= 1; dr++) {
    for (var dc = -1; dc <= 1; dc++) {
      let rr = r + dr;
      let cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= i32(params.height) || cc >= i32(params.width)) { continue; }
      if (phase(rr, cc) != want) { continue; }
      total += m_at(rr, cc);
      count += 1.0;
    }
  }
  if (count == 0.0) { return m_at(r, c); }
  return total / count;
}

@compute @workgroup_size(8, 8)
fn assemble(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = i32(gid.x);
  let r = i32(gid.y);
  if (u32(c) >= params.width || u32(r) >= params.height) { return; }
  let at = idx(r, c);

  var out_r: f32;
  var out_g: f32;
  var out_b: f32;
  // The frame's margin, which is exactly where the last stage stopped writing.
  if (interior(r, c, i32(params.margin))) {
    out_r = red[at];
    out_g = green[at];
    out_b = blue[at];
  } else {
    let p = phase(r, c);
    out_r = select(nearby_mean(r, c, 0u), m_at(r, c), p == 0u);
    out_g = select(nearby_mean(r, c, 1u), m_at(r, c), p == 1u);
    out_b = select(nearby_mean(r, c, 2u), m_at(r, c), p == 2u);
  }

  // §8: clamp below only. Values above white are meaningful to the grade downstream.
  rgb[at * 3u] = max(0.0, out_r);
  rgb[at * 3u + 1u] = max(0.0, out_g);
  rgb[at * 3u + 2u] = max(0.0, out_b);
}
