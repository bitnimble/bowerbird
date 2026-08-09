// Transfer functions and the roll-off, shared by every module that grades.
//
// The constants and the names are `native/rawshim`'s, deliberately: this is a second
// implementation of one picture, which is the divergence DESIGN §21.1 warns about, so
// where a number appears here it appears with the name it has over there.

/// `hdr_fit::LUMA` and `tone::LUMA`, which are BT.2020's weights for a Rec.2020 frame.
///
/// Not `image::LUMA`. That one is BT.709 and belongs to the denoise, which is measuring
/// where detail is rather than what a colour weighs, and never meets this. Taking it here
/// put the wrong weights under `finish_chroma`'s grey axis, the chroma map's level axis and
/// its reconstructed middle channel, and the exposure ratio in `toned` - so every matched
/// photograph was graded around a luma the CPU never computed.
const LUMA = vec3f(0.2627, 0.678, 0.0593);

// SMPTE ST 2084, both directions. `tone::pq` and `tone::pq_inv`.
const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

fn pq(nits: f32) -> f32 {
  let y = pow(clamp(nits / 10000.0, 0.0, 1.0), PQ_M1);
  return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2);
}

fn pq_inv(signal: f32) -> f32 {
  let e = pow(clamp(signal, 0.0, 1.0), 1.0 / PQ_M2);
  return 10000.0 * pow(max(e - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * e), 1.0 / PQ_M1);
}

/// ITU-R BT.2390-8 5.4.1 with black at zero. **The only implementation of the roll-off.**
///
/// There was a second one in Rust, tabulated over 4096 bins because it paid per sample in
/// scalar code. A shader does not, so this is evaluated - and that one is deleted, which is
/// what makes a rendition and a tick the same picture rather than two kept in agreement.
///
/// Split so the knee is found once and applied three times: `pq(source_peak)` and `pq(peak)`
/// are constant over the whole dispatch, coming from the frame and the display rather than
/// from the pixel.
struct Rolloff {
  lw: f32,
  max_lum: f32,
  ks: f32,
  // Whether the scene already fits inside the display, in which case there is nothing to
  // roll off and every channel returns unchanged.
  fits: bool,
};

fn rolloff(source_peak: f32, peak: f32) -> Rolloff {
  let lw = pq(source_peak);
  let max_lum = pq(peak) / lw;
  return Rolloff(lw, max_lum, max(1.5 * max_lum - 0.5, 0.0), max_lum >= 1.0);
}

fn roll(nits: f32, knee: Rolloff) -> f32 {
  if (knee.fits) { return nits; }
  let e1 = pq(nits) / knee.lw;
  if (e1 < knee.ks) { return nits; }
  let t = (e1 - knee.ks) / (1.0 - knee.ks);
  let t2 = t * t;
  let t3 = t2 * t;
  let e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * knee.ks
    + (t3 - 2.0 * t2 + t) * (1.0 - knee.ks)
    + (-2.0 * t3 + 3.0 * t2) * knee.max_lum;
  return pq_inv(e2 * knee.lw);
}

fn rolled(nits: vec3f, knee: Rolloff) -> vec3f {
  return vec3f(roll(nits.r, knee), roll(nits.g, knee), roll(nits.b, knee));
}
