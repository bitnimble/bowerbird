//! What has been measured about one photograph, small enough to keep beside it.
//!
//! Everything here is expensive to arrive at and cheap to store, and every path that renders the
//! photograph wants the same answers: a rendition job, an on-demand rebuild after an edit, the
//! editor's open, and worst of all the loupe, which asks for a new tile every time the reader
//! moves. Measured on a 24MP CR3, a 400px tile is 626ms measuring these and 112ms handed them.
//!
//! **Two sections, because they do not go stale the same way.** [`FromRaw`] is what the file alone
//! decides, and can only change when the photograph does. [`FromRender`] is read off a *decode*, so
//! it carries the settings it was measured under and is refused where those have moved. Keeping
//! them apart in the type is what stops the second kind being read as the first.
//!
//! The format is little-endian, versioned, and framed section by section, so a build that meets a
//! section it does not know skips it rather than giving up on the file - which is what lets this
//! grow without every older build refitting everything. A blob this build cannot read at all is
//! "nothing stored" rather than an error: everything in it is then measured the slow way, which is
//! what happened before any of this existed.

use crate::fit::Lens;
use crate::galosh::NoiseFit;
use crate::hdr_fit::{ChromaMap, HdrColour, HdrMatch};
use crate::tone::Levels;
use half::f16;

/// Bumped when a section's own layout changes, so an older blob is ignored rather than misread.
/// Adding a section does not need it - an unknown kind is skipped.
///
/// **Also when what a section *means* changes**, which is most of the bumps: the match is fitted
/// against a defringed frame, its geometry is settled on measured registration, and its colour is
/// kept on beating the untransformed render. A blob written under an earlier rule decodes cleanly,
/// is preferred over a fresh fit, and nothing ever clears it - so a library holding both would
/// grade two photographs by two rules with nothing to say which was which. Discarding them costs
/// one re-fit per photograph on next open, about half a second, once.
const VERSION: u8 = 15;
const MAGIC: [u8; 3] = *b"BBP";

const KIND_MATCH: u8 = 0;
const KIND_NOISE: u8 = 1;
const KIND_LEVELS: u8 = 2;
const KIND_SCENE_PEAK: u8 = 3;
const KIND_DEFOCUS: u8 = 4;
const KIND_DUST: u8 = 5;
const KIND_CAPTURE_SIGMA: u8 = 6;
const KIND_SET_STAMP: u8 = 7;
const KIND_BALANCE: u8 = 8;

/// A section longer than this is a corrupt or hostile blob rather than a photograph's analysis.
/// The camera match is the largest thing here, two thirds of it the chroma lattice, and
/// everything else is a few kilobytes.
const SECTION_MAX: usize = 1 << 22;

#[derive(Clone, Default)]
pub struct PhotoAnalysis {
    pub from_raw: FromRaw,
    pub from_render: FromRender,
}

/// What the file alone decides, and so what can only go stale by the photograph changing.
///
/// **Nothing an edit touches reaches either of these.** A crop, an exposure, a Detail amount -
/// none of them are inputs; only the photosites are.
#[derive(Clone, Default)]
pub struct FromRaw {
    /// The colour the body would have rendered and the lens it was shot through. Half a second to
    /// fit, from the embedded JPEG (`crate::hdr_fit`).
    pub matched: Option<HdrMatch>,
    /// The sensor's noise, as GALOSH Phase 0 fits it off the mosaic: 246ms of whole-frame
    /// reductions, and a property of the photosites rather than of any filtering of them.
    pub noise: Option<NoiseFit>,
    /// The particles on the cover glass, every candidate the frame offers rather than the ones any
    /// setting keeps (`crate::dust`).
    ///
    /// **Unthresholded on purpose.** The sensitivity slider is a cut on `Spot::snr`, so storing the
    /// kept set would make a slider move a re-detection and a whole-frame read. `Some(vec![])` is a
    /// photograph that was looked at and found clean, which is a different thing from `None`.
    pub dust: Option<Vec<crate::dust::Spot>>,
    /// The blur a decode of this file carries, as a Gaussian sigma in sensor pixels, read off the
    /// 10-90 distance of the frame's own sharpest edges (`crate::base::measure_edge_spread`). What
    /// the sharpen's deconvolution is composed from (`crate::image::deconvolve_split`).
    ///
    /// **The capture and the demosaic together**, which is what a deconvolution running after both
    /// actually meets - and a property of the file rather than of a setting, so it belongs here
    /// beside the noise fit even though the frame it is read on is a rendered one.
    pub capture_sigma: Option<f32>,
    /// The illuminant the decode balanced against, and the gains it applied to get there.
    ///
    /// **Filed for a picture whose decode a caller may not pay for.** A tab opening a photograph
    /// decodes it and has both; a window of a composite's coarse level decodes only the sources
    /// that reach that window, and the balance every one of them is graded through is the
    /// *reference* frame's - which a rectangle away from the reference never touches. Without this
    /// the temperature panel has no baseline to open at.
    pub balance: Option<Balance>,
}

/// The gains a decode applied, and the illuminant they reached where the file named one.
///
/// One thing rather than two fields because the illuminant is what the gains were scaled *to*,
/// which only a file carrying usable multipliers has. A JPEG or a PNG has gains of
/// one and no illuminant, and that is a balance rather than the absence of one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Balance {
    pub wb_gains: [f32; 3],
    pub as_shot: Option<crate::white_balance::AsShot>,
}

/// What only a rendered frame can say, and the settings it said it under.
///
/// **These are not functions of the file the way [`FromRaw`] is.** They are read off a decode - so
/// a different white quantile or a different reference white is a different answer, and each
/// carries what it was measured with so a caller asking about other settings is refused rather
/// than answered wrongly.
///
/// What they are *not* sensitive to is the reader. The denoise and the colour transform are this
/// pipeline's own, with a Detail amount the only input either takes, and a quantile of the frame
/// barely moves under it: measured across the fixtures at Detail 0, 40 and 100, the widest spread
/// in diffuse white is 1.3% - 0.019 stops - and between 40 and 100 it is 0.065%. So a crop, an
/// exposure or a Detail slider reuses these rather than measuring again (DESIGN 10.10).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FromRender {
    pub levels: Option<MeasuredLevels>,
    pub scene_peak: Option<MeasuredPeak>,
    pub defocus: Option<MeasuredDefocus>,
    /// Which *set of photographs* everything above was measured over, where it was more than one.
    ///
    /// **A composite's measurements are of its sources, and nothing else here says which sources.**
    /// The levels and the colour of a panorama are read over every frame stacked - so they are
    /// keyed on the quantile like any other, and that key cannot tell one recipe's set from
    /// another's at the same quantile. A row whose recipe is replaced would be graded by the
    /// previous set's exposure and colour with nothing to say so.
    ///
    /// None for an ordinary photograph, whose set is itself: `FromRaw` is a function of the file
    /// and the levels are a function of its decode, so there is nothing a stamp would distinguish.
    /// None also for a composite measured before this was written, which re-measures once.
    pub set: Option<SetStamp>,
}

/// What a composite was measured over, short enough to store and specific enough to refuse by.
///
/// The photographs and the reference are the shape of the set; the gains are what carry each
/// source's light onto the reference's scale, so moving one moves the canvas these measurements
/// are of. Hashed rather than listed because what this answers is "the same set?" and never
/// "which set?".
///
/// **The alignment is deliberately not in it.** A rotation nudged by a merge moves which pixels of
/// which frame land where, not how much light the set holds, and a quantile over a whole canvas is
/// as insensitive to that as it is to the Detail amount [`FromRender`] already declines to key on.
/// What is in here is every input that moves the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetStamp(u64);

impl SetStamp {
    /// The stamp of a set of photographs and their gains, in the order the recipe names them.
    ///
    /// FNV-1a, which is not a cryptographic hash and is not trying to be: what this defends
    /// against is a recipe that changed, not one forged to collide - and a collision costs a reuse
    /// that should have been a re-measure, which is the bug this closes rather than a worse one.
    pub fn of<'a>(sources: impl IntoIterator<Item = (&'a str, f64)>, reference: usize) -> SetStamp {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x1000_0000_01b3);
            }
        };
        eat(&(reference as u64).to_le_bytes());
        for (photo, gain) in sources {
            // The length as well as the bytes: two ids concatenated must not stamp as one.
            eat(&(photo.len() as u64).to_le_bytes());
            eat(photo.as_bytes());
            eat(&gain.to_bits().to_le_bytes());
        }
        SetStamp(hash)
    }
}

/// The frame's own diffuse white and top end, in input levels, as `fit_source::levels` reads them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeasuredLevels {
    pub levels: Levels,
    /// The quantile `levels.white` was taken at, which is a library setting rather than a constant.
    pub white_quantile: f64,
}

/// Where the highlight roll-off finds the scene's top end, with the photographer's exposure at
/// rest.
///
/// A gain moves it - `peak.slang` measures after the tone curve, which is why a tick remeasures over
/// the candidates it kept - so this is what every render *at rest* rolls off against, and what
/// makes a rendition and the editor place the knee in the same place.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeasuredPeak {
    pub nits: crate::light::Light<crate::light::DisplayNits>,
    /// The diffuse white the value above is expressed against, and the quantile the frame it was
    /// measured on was coded with. Both reach the coding, so a peak is only an answer to a caller
    /// coding the same way.
    pub reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    pub white_quantile: f64,
}

/// The longitudinal chromatic aberration the defringe takes off, as `base::measure_defocus` reads
/// it: how far red and blue are focused from green, one coefficient each.
///
/// **Whole-frame, and wrong for a window in the way the levels are.** The fit reads channel
/// residuals over everything it is shown, so a crop fitting its own is defringed by whatever its
/// own edges say, and the strips of a re-prepare come back corrected by amounts that walk down the
/// picture. The editor measures it at the open and hands it back per tile; this is where a caller
/// with no open behind it - a rendition's loupe, over HTTP - gets the same pair.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeasuredDefocus {
    /// Already scaled by the `defringe` setting below, which is the form every consumer takes.
    pub red: f32,
    pub blue: f32,
    pub defringe: f64,
    /// The long edge of the frame it was fitted on.
    ///
    /// **A coefficient is a blur difference in pixels squared**, so the same lens on the same
    /// photograph measures a quarter as much at half the resolution - and a decode is halved
    /// whenever the largest target leaves room for it (`decode_fitted`). A first render at 3840 off
    /// a 9504-wide body therefore files a pair four times too small for the full-size export that
    /// follows it, which would then be defringed at a quarter strength with nothing to say so.
    pub long_edge: usize,
}

impl MeasuredDefocus {
    /// The pair, where it was fitted for the settings and the resolution asked about.
    ///
    /// The grade's own settings are deliberately not part of this. The fit reads the *linear* frame
    /// ahead of the coding, so the anchor the coding would have used does not reach it - a pair
    /// measured under one white quantile is the same pair under another, and keying on them only
    /// threw away work.
    pub fn pair_for(&self, defringe: f64, long_edge: usize) -> Option<(f32, f32)> {
        match self.defringe == defringe && self.long_edge == long_edge {
            true => Some((self.red, self.blue)),
            false => None,
        }
    }
}

impl MeasuredLevels {
    /// The levels, where they were measured for the settings asked about.
    ///
    /// Exact rather than approximate, and deliberately so: a white quantile arrives from a
    /// library's own configuration as the same `f64` every time, so a comparison that tolerated
    /// drift would only be tolerating a bug.
    pub fn levels_at(&self, white_quantile: f64) -> Option<Levels> {
        match self.white_quantile == white_quantile && self.levels.usable() {
            true => Some(self.levels),
            false => None,
        }
    }
}

impl MeasuredPeak {
    pub fn nits_at(
        &self,
        white_quantile: f64,
        reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    ) -> Option<crate::light::Light<crate::light::DisplayNits>> {
        let answers = self.white_quantile == white_quantile
            && self.reference_white_nits == reference_white_nits;
        match answers {
            true => Some(self.nits),
            false => None,
        }
    }
}

impl PhotoAnalysis {
    pub fn is_empty(&self) -> bool {
        self.from_raw.matched.is_none()
            && self.from_raw.noise.is_none()
            && self.from_raw.dust.is_none()
            && self.from_raw.capture_sigma.is_none()
            && self.from_raw.balance.is_none()
            && self.from_render == FromRender::default()
    }

    /// This analysis with anything it is missing taken from `stored`.
    ///
    /// **What makes the file grow rather than churn.** The parts are measured by different callers
    /// at different times - an open fits the match and the noise, only a host that graded the frame
    /// has a peak - so a writer that replaced the file with what it happened to hold would drop
    /// whatever it had not measured itself, and the next open would measure it again.
    pub fn filled_from(mut self, stored: &PhotoAnalysis) -> PhotoAnalysis {
        let match_is_richer = self.from_raw.matched.is_none()
            || (self.from_raw.matched.as_ref().is_some_and(|m| m.colour.is_none())
                && stored.from_raw.matched.as_ref().is_some_and(|m| m.colour.is_some()));
        let match_basis_agrees = match (self.from_render.set, stored.from_render.set) {
            (None, None) => true,
            (Some(mine_set), Some(stored_set)) if mine_set == stored_set => {
                match (self.from_render.levels, stored.from_render.levels) {
                    (Some(mine), Some(theirs)) => mine.white_quantile == theirs.white_quantile,
                    (None, _) => true,
                    _ => false,
                }
            }
            _ => false,
        };
        if match_is_richer && match_basis_agrees {
            self.from_raw.matched = stored.from_raw.matched.clone();
        }
        if self.from_raw.noise.is_none() {
            self.from_raw.noise = stored.from_raw.noise;
        }
        if self.from_raw.dust.is_none() {
            self.from_raw.dust = stored.from_raw.dust.clone();
        }
        if self.from_raw.capture_sigma.is_none() {
            self.from_raw.capture_sigma = stored.from_raw.capture_sigma;
        }
        if self.from_raw.balance.is_none() {
            self.from_raw.balance = stored.from_raw.balance;
        }
        // **Only where both were measured over the same set.** `FromRaw` is of the file and a
        // composite's sources are the same files whatever the recipe does with them, so those fill
        // across freely; the rendered measurements are of a *canvas*, and taking a level or a peak
        // from a set this pass is not of is the whole failure `set` exists to name.
        if self.from_render.set == stored.from_render.set {
            if self.from_render.levels.is_none() {
                self.from_render.levels = stored.from_render.levels;
            }
            if self.from_render.scene_peak.is_none() {
                self.from_render.scene_peak = stored.from_render.scene_peak;
            }
            if self.from_render.defocus.is_none() {
                self.from_render.defocus = stored.from_render.defocus;
            }
        }
        self
    }

    /// Whether this holds anything `stored` does not, which is whether it is worth writing.
    pub fn adds_to(&self, stored: &PhotoAnalysis) -> bool {
        let gained = |mine: bool, theirs: bool| mine && !theirs;
        gained(self.from_raw.matched.is_some(), stored.from_raw.matched.is_some())
            || gained(
                self.from_raw.matched.as_ref().is_some_and(|m| m.colour.is_some()),
                stored.from_raw.matched.as_ref().is_some_and(|m| m.colour.is_some()),
            )
            || gained(self.from_raw.noise.is_some(), stored.from_raw.noise.is_some())
            || gained(self.from_raw.dust.is_some(), stored.from_raw.dust.is_some())
            || gained(
                self.from_raw.capture_sigma.is_some(),
                stored.from_raw.capture_sigma.is_some(),
            )
            || gained(self.from_raw.balance.is_some(), stored.from_raw.balance.is_some())
            || (self.from_render.levels.is_some()
                && self.from_render.levels != stored.from_render.levels)
            || (self.from_render.scene_peak.is_some()
                && self.from_render.scene_peak != stored.from_render.scene_peak)
            || (self.from_render.defocus.is_some()
                && self.from_render.defocus != stored.from_render.defocus)
            // A pass that measured a canvas at all, over a set the file does not name, is worth
            // writing even where every number came out the same: what is stored is then a level
            // stamped with the wrong set, and every later open re-measures rather than trust it.
            || (self.from_render != FromRender::default()
                && self.from_render.set != stored.from_render.set)
    }
}

/// The bytes to store for this photograph.
pub fn encode(analysis: &PhotoAnalysis) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 * 1024);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);

    if let Some(matched) = &analysis.from_raw.matched {
        section(&mut out, KIND_MATCH, |body| put_match(body, matched));
    }
    if let Some(noise) = &analysis.from_raw.noise {
        section(&mut out, KIND_NOISE, |body| put_noise(body, noise));
    }
    if let Some(sigma) = analysis.from_raw.capture_sigma {
        section(&mut out, KIND_CAPTURE_SIGMA, |body| {
            put_f32(body, f64::from(sigma))
        });
    }
    if let Some(levels) = &analysis.from_render.levels {
        section(&mut out, KIND_LEVELS, |body| put_levels(body, levels));
    }
    if let Some(peak) = &analysis.from_render.scene_peak {
        section(&mut out, KIND_SCENE_PEAK, |body| put_peak(body, peak));
    }
    if let Some(defocus) = &analysis.from_render.defocus {
        section(&mut out, KIND_DEFOCUS, |body| put_defocus(body, defocus));
    }
    if let Some(dust) = &analysis.from_raw.dust {
        section(&mut out, KIND_DUST, |body| put_dust(body, dust));
    }
    if let Some(set) = &analysis.from_render.set {
        section(&mut out, KIND_SET_STAMP, |body| put_u64(body, set.0));
    }
    if let Some(balance) = &analysis.from_raw.balance {
        section(&mut out, KIND_BALANCE, |body| {
            for gain in balance.wb_gains {
                put_f32(body, f64::from(gain));
            }
            match balance.as_shot {
                None => body.push(0),
                Some(as_shot) => {
                    body.push(1);
                    put_f32(body, as_shot.temperature);
                    put_f32(body, as_shot.tint);
                }
            }
        });
    }
    out
}

/// The analysis those bytes described, or None where they described nothing this build reads.
pub fn decode(bytes: &[u8]) -> Option<PhotoAnalysis> {
    let mut at = Reader { bytes, at: 0 };
    if at.take(3)? != MAGIC || at.u8()? != VERSION {
        return None;
    }

    let mut analysis = PhotoAnalysis::default();
    while !at.done() {
        let kind = at.u8()?;
        let length = at.u32()? as usize;
        if length > SECTION_MAX {
            return None;
        }
        let body = at.take(length)?;
        let mut section = Reader { bytes: body, at: 0 };
        // **A section this build cannot read costs that section and no more.** Each one carries its
        // own length and the reader has already stepped over it, so a body that will not parse
        // cannot put the stream out of step - and refusing the whole blob for one of them means a
        // photograph whose levels are a shade out of range also refits its camera match, its noise
        // and its aberration, on every render, for ever, and says nothing. A section this build has
        // never heard of is a newer writer, and nothing to complain about either.
        match kind {
            KIND_MATCH => analysis.from_raw.matched = take_match(&mut section),
            KIND_NOISE => analysis.from_raw.noise = take_noise(&mut section),
            KIND_LEVELS => analysis.from_render.levels = take_levels(&mut section),
            KIND_SCENE_PEAK => analysis.from_render.scene_peak = take_peak(&mut section),
            KIND_DEFOCUS => analysis.from_render.defocus = take_defocus(&mut section),
            KIND_DUST => analysis.from_raw.dust = take_dust(&mut section),
            KIND_SET_STAMP => analysis.from_render.set = section.u64().map(SetStamp),
            KIND_BALANCE => analysis.from_raw.balance = take_balance(&mut section),
            KIND_CAPTURE_SIGMA => {
                analysis.from_raw.capture_sigma =
                    // Up to four, not two: the sigma is in sensor pixels and a halved decode
                    // doubles what it measured to reach them.
                    section.f32_narrow().filter(|sigma| (0.1..=4.0).contains(sigma));
            }
            _ => {}
        }
    }
    Some(analysis)
}

/// The balance, refused where it is not one: a gain of zero or a temperature off the scale is a
/// read that went wrong, and a picture graded through it would be black or magenta rather than
/// obviously broken.
fn take_balance(at: &mut Reader<'_>) -> Option<Balance> {
    let wb_gains = [at.f32()? as f32, at.f32()? as f32, at.f32()? as f32];
    if !wb_gains.iter().all(|gain| gain.is_finite() && *gain > 0.0) {
        return None;
    }
    let as_shot = match at.u8()? {
        0 => None,
        _ => {
            let temperature = at.f32()?;
            let tint = at.f32()?;
            // The illuminant alone is refused where the gains are kept: the panel opens without a
            // baseline, which is what a file with no multipliers gets anyway.
            ((1000.0..=50_000.0).contains(&temperature) && tint.is_finite())
                .then_some(crate::white_balance::AsShot { temperature, tint })
        }
    };
    Some(Balance { wb_gains, as_shot })
}

/// One framed section, whose length is written once its body is known.
fn section(out: &mut Vec<u8>, kind: u8, body: impl FnOnce(&mut Vec<u8>)) {
    let mut bytes = Vec::new();
    body(&mut bytes);
    out.push(kind);
    put_u32(out, bytes.len() as u32);
    out.extend_from_slice(&bytes);
}

/// The camera match: the curves and the lattice the shader reads, and the lens they were fitted
/// through.
///
/// Two thirds of it is the chroma lattice, which the shader reads out of an `rgba16float` texture -
/// so those are stored as `f16`, because anything more is precision the GPU truncates on the way
/// in. The tone curves are read from `r32float` and stay `f32`: a curve feeding an HDR grade is
/// exactly where a thousandth of an error shows up as a band in a smooth sky.
fn put_match(out: &mut Vec<u8>, matched: &HdrMatch) {
    match &matched.colour {
        None => out.push(0),
        Some(colour) => {
            out.push(1);
            put_colour(out, colour);
        }
    }
    let lens = &matched.lens;
    put_option_f32s(out, lens.distortion.as_deref());
    put_f32(out, lens.crop);
    match lens.falloff {
        None => out.push(0),
        Some((a, b)) => {
            out.push(1);
            put_f32(out, a);
            put_f32(out, b);
        }
    }
    match &lens.tca {
        None => out.push(0),
        Some([red, blue]) => {
            out.push(1);
            put_option_f32s(out, Some(red));
            put_option_f32s(out, Some(blue));
        }
    }
}

fn put_colour(out: &mut Vec<u8>, colour: &HdrColour) {
    // The curves, whose length is the fit's own `BINS` and is written rather than assumed.
    put_u32(out, colour.curves[0].len() as u32);
    for channel in &colour.curves {
        put_f32s(out, channel);
    }
    for row in &colour.matrix {
        put_f32s(out, row);
    }
    put_f32(out, colour.saturation);
    put_f32(out, colour.ceiling);
    // Carried, though nothing downstream reads it: it is what the fit scored, and a stored match
    // that came back without it would report a photograph as unmeasured rather than as measured
    // well.
    put_f32(out, colour.delta_e);
    put_u32(out, colour.curve.len() as u32);
    for point in &colour.curve { put_f32s(out, point); }

    match &colour.chroma {
        None => out.push(0),
        Some(map) => {
            out.push(1);
            // The fitted lattice, not the applied one: `densified` rebuilds the applied
            // form on load, exactly, so storing it would spend 128x the bytes on numbers
            // the reader can derive.
            let coarse = map.coarse();
            let shape = coarse.shape();
            put_f32s(out, &shape.chroma_low);
            put_f32s(out, &shape.chroma_scale);
            for value in coarse.nodes_flat() {
                out.extend_from_slice(&f16::from_f64(value).to_le_bytes());
            }
            // The surround the map reads, which a loupe tile cannot compute for itself.
            put_u32(out, colour.surround.width as u32);
            put_u32(out, colour.surround.height as u32);
            for value in &colour.surround.data {
                out.extend_from_slice(&f16::from_f64(*value).to_le_bytes());
            }
        }
    }
}

fn take_match(at: &mut Reader<'_>) -> Option<HdrMatch> {
    let colour = match at.u8()? {
        0 => None,
        1 => Some(take_colour(at)?),
        _ => return None,
    };
    let distortion = at.option_f32s()?;
    let crop = at.f32()?;
    let falloff = match at.u8()? {
        0 => None,
        _ => Some((at.f32()?, at.f32()?)),
    };
    let tca = match at.u8()? {
        0 => None,
        _ => {
            let red = at.option_f32s()?.unwrap_or_default();
            let blue = at.option_f32s()?.unwrap_or_default();
            Some([red, blue])
        }
    };
    Some(HdrMatch { lens: Lens { distortion, crop, falloff, tca }, colour })
}

fn take_colour(at: &mut Reader<'_>) -> Option<HdrColour> {
    let bins = at.u32()? as usize;
    // A length from a stored blob decides how much is read, so it is bounded before it is trusted:
    // the fit's own is 256, and nothing legitimate is anywhere near this.
    if bins == 0 || bins > 4096 {
        return None;
    }
    let curves = [at.f32s(bins)?, at.f32s(bins)?, at.f32s(bins)?];
    let matrix = [
        [at.f32()?, at.f32()?, at.f32()?],
        [at.f32()?, at.f32()?, at.f32()?],
        [at.f32()?, at.f32()?, at.f32()?],
    ];
    let saturation = at.f32()?;
    let ceiling = at.f32()?;
    let delta_e = at.f32()?;
    let count = at.u32()? as usize;
    if !(2..=16).contains(&count) { return None; }
    let mut curve = Vec::with_capacity(count);
    for _ in 0..count { curve.push([at.f32()?, at.f32()?]); }
    // The grade refuses an invalid curve outright, so one read from disk costs the match here
    // rather than every render of the photograph after.
    if !crate::light::curve_is_valid(&curve) { return None; }

    let (chroma, surround) = match at.u8()? {
        0 => (None, crate::hdr_fit::SurroundThumb::none()),
        _ => {
            let low = [at.f32()?, at.f32()?];
            let scale = [at.f32()?, at.f32()?];
            let mut nodes =
                Vec::with_capacity(crate::hdr_fit::map_nodes() * crate::hdr_fit::NODE_VALUES);
            for _ in 0..nodes.capacity() {
                nodes.push(f64::from(f16::from_le_bytes([at.u8()?, at.u8()?])));
            }
            let map = ChromaMap::from_parts(&nodes, low, scale)?
                .with_level_reach(f64::from(ceiling))
                .densified();
            let width = at.u32()?;
            let height = at.u32()?;
            // A stored size decides how much is read, so it is bounded before it is
            // trusted, the same as the curves' `bins` above - and bounded in `u64`,
            // because on wasm32 the product of two stored `u32` can wrap `usize` and
            // stroll past the check it exists for.
            if u64::from(width) * u64::from(height) > 65_536 {
                return None;
            }
            let (width, height) = (width as usize, height as usize);
            let mut data = Vec::with_capacity(width * height);
            for _ in 0..data.capacity() {
                data.push(f64::from(f16::from_le_bytes([at.u8()?, at.u8()?])));
            }
            (
                Some(map),
                crate::hdr_fit::SurroundThumb {
                    width,
                    height,
                    data,
                },
            )
        }
    };

    Some(HdrColour {
        anchor: crate::hdr_fit::chroma_anchor(&curves[1], ceiling),
        curves,
        ceiling,
        matrix,
        saturation,
        delta_e,
        curve,
        curve_error: 0.0,
        chroma,
        surround,
    })
}

/// Seven numbers at the width the kernels read them: `NoiseFit` is `f32` throughout and crosses to
/// the shader as `f32`, so storing more would be storing precision nothing can use.
fn put_noise(out: &mut Vec<u8>, noise: &NoiseFit) {
    for value in [noise.alpha, noise.sigma_sq, noise.unified_sigma] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    for value in noise.dark_ref {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn take_noise(at: &mut Reader<'_>) -> Option<NoiseFit> {
    let fit = NoiseFit {
        alpha: at.f32_narrow()?,
        sigma_sq: at.f32_narrow()?,
        unified_sigma: at.f32_narrow()?,
        dark_ref: [
            at.f32_narrow()?,
            at.f32_narrow()?,
            at.f32_narrow()?,
            at.f32_narrow()?,
        ],
    };
    // The same check a fit crossing the API takes, for the same reason: every pixel is scaled by
    // these, so a blob that has been truncated or edited renders confidently in the wrong colours
    // rather than failing. Refusing here is a photograph that fits its own again.
    match fit.usable() {
        true => Some(fit),
        false => None,
    }
}

/// The levels stay `f64`, unlike the fitted numbers above, because the coding divides by `white`:
/// a stored one narrowed to `f32` would code the frame a fraction of a count away from the one a
/// fresh measurement codes, and the fixtures compare exactly those two frames.
fn put_levels(out: &mut Vec<u8>, measured: &MeasuredLevels) {
    for value in [
        measured.levels.white.raw(),
        measured.levels.peak.raw(),
        measured.white_quantile,
        // A NaN for a floor nobody measured, which `usable` below refuses.
        measured.levels.floor.map_or(f64::NAN, |floor| floor.raw()),
    ] {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

/// **The floor is read last and the `?` on it is what lets a short section degrade.** A section
/// carries its own length, so a blob whose levels stop before it runs off the end here and loses
/// its levels alone - remeasured on the next open, at the cost of one histogram walk, where a
/// default in place of the `?` would grade every one of them against a bottom nothing measured.
fn take_levels(at: &mut Reader<'_>) -> Option<MeasuredLevels> {
    let white = crate::light::Light::measured(at.f64()?);
    let peak = crate::light::Light::measured(at.f64()?);
    let white_quantile = at.f64()?;
    let floor = Some(crate::light::Light::measured(at.f64()?));
    let measured = MeasuredLevels {
        levels: Levels { white, peak, floor },
        white_quantile,
    };
    match measured.levels.usable() && quantile_like(measured.white_quantile) {
        true => Some(measured),
        false => None,
    }
}

fn put_peak(out: &mut Vec<u8>, peak: &MeasuredPeak) {
    for value in [
        peak.nits.raw(),
        peak.reference_white_nits.raw(),
        peak.white_quantile,
    ] {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn take_peak(at: &mut Reader<'_>) -> Option<MeasuredPeak> {
    let peak = MeasuredPeak {
        nits: crate::light::Light::measured(at.f64()?),
        reference_white_nits: crate::light::Light::measured(at.f64()?),
        white_quantile: at.f64()?,
    };
    let sane = peak.nits.is_a_peak()
        && peak.reference_white_nits.is_finite()
        && peak.reference_white_nits > crate::light::Light::ZERO
        && quantile_like(peak.white_quantile);
    match sane {
        true => Some(peak),
        false => None,
    }
}

/// The particles, `f32` throughout because the kernel that reads them takes `f32`.
///
/// Each spot is written as the flat words `dust.slang` indexes, so a section this build wrote is
/// the buffer that build uploads with no reshaping in between.
fn put_dust(out: &mut Vec<u8>, spots: &[crate::dust::Spot]) {
    put_u32(out, spots.len() as u32);
    for spot in spots {
        for value in spot.words() {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
}

fn take_dust(at: &mut Reader<'_>) -> Option<Vec<crate::dust::Spot>> {
    let count = at.u32()? as usize;
    // A count from a stored blob decides how much is read and how many workgroups are dispatched,
    // so it is bounded before it is trusted.
    if count > crate::dust::MOST_SPOTS {
        return None;
    }
    let mut spots = Vec::with_capacity(count);
    for _ in 0..count {
        let mut words = [0f32; crate::dust::SPOT_WORDS];
        for word in &mut words {
            *word = at.f32_narrow()?;
        }
        // **One unreadable spot costs that spot.** Refusing the section for it would read as "this
        // photograph was never looked at", so the next open re-runs a whole-frame detection - and
        // the one after that, for ever, because the same spot is written again. Meanwhile every
        // loupe tile gets an empty list while the stage shows a correction, which is the
        // disagreement the whole sidecar exists to prevent. The words themselves are still
        // consumed, so the stream stays in step.
        if let Some(spot) = crate::dust::Spot::from_words(&words) {
            spots.push(spot);
        }
    }
    Some(spots)
}

fn put_defocus(out: &mut Vec<u8>, defocus: &MeasuredDefocus) {
    for value in [defocus.red, defocus.blue] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&defocus.defringe.to_le_bytes());
    put_u32(out, defocus.long_edge as u32);
}

fn take_defocus(at: &mut Reader<'_>) -> Option<MeasuredDefocus> {
    let defocus = MeasuredDefocus {
        red: at.f32_narrow()?,
        blue: at.f32_narrow()?,
        defringe: at.f64()?,
        long_edge: at.u32()? as usize,
    };
    // Bounded rather than merely finite: `base::measure_defocus` vetoes a coefficient past what a
    // lens does, and a blob that has been edited must not reach the defringe with a larger one -
    // every high-contrast edge in the frame is shifted by it.
    let sane = defocus.red.is_finite()
        && defocus.blue.is_finite()
        && defocus.red.abs() <= 1.0
        && defocus.blue.abs() <= 1.0
        && defocus.defringe.is_finite()
        && (0.0..=1.0).contains(&defocus.defringe)
        && defocus.long_edge > 0;
    match sane {
        true => Some(defocus),
        false => None,
    }
}

/// Whether a number could be the white quantile a library is configured with.
///
/// **The ends are legal.** `settings.ts` is `min(0).max(1)`, so a library really can be set to
/// either, and a validator that refused them rejected a section this side had just written - which,
/// before the sections were made independent, discarded the whole blob and left every render of
/// every photograph refitting everything, for ever, without a word. Whether such a quantile
/// describes a usable frame is `Levels::usable`'s question, one layer down, and it already asks it.
fn quantile_like(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_f32(out: &mut Vec<u8>, value: f64) {
    out.extend_from_slice(&(value as f32).to_le_bytes());
}

fn put_f32s(out: &mut Vec<u8>, values: &[f64]) {
    for value in values {
        put_f32(out, *value);
    }
}

fn put_option_f32s(out: &mut Vec<u8>, values: Option<&[f64]>) {
    match values {
        None => out.push(0),
        Some(values) => {
            out.push(1);
            put_u32(out, values.len() as u32);
            put_f32s(out, values);
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn take(&mut self, count: usize) -> Option<&[u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn f32_narrow(&mut self) -> Option<f32> {
        Some(f32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn f32(&mut self) -> Option<f64> {
        Some(f64::from(self.f32_narrow()?))
    }

    fn f64(&mut self) -> Option<f64> {
        Some(f64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn f32s(&mut self, count: usize) -> Option<Vec<f64>> {
        (0..count).map(|_| self.f32()).collect()
    }

    fn option_f32s(&mut self) -> Option<Option<Vec<f64>>> {
        match self.u8()? {
            0 => Some(None),
            _ => {
                let count = self.u32()? as usize;
                if count > 4096 {
                    return None;
                }
                Some(Some(self.f32s(count)?))
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::hdr_fit::{NODE_VALUES, map_nodes};
    use crate::light::Light;

    pub(crate) fn a_match() -> HdrMatch {
        // Values that are not round, so a field read out of the wrong offset shows up as a
        // mismatch rather than as a coincidence.
        let curve = |base: f64| {
            (0..256)
                .map(|i| base + f64::from(i) * 0.0031)
                .collect::<Vec<_>>()
        };
        let nodes: Vec<f64> =
            // Stepped so the largest value stays under 1: `f16` keeps the round trip's
            // 1e-3 only up to there, and the lattice's real values live under it too.
            (0..map_nodes() * NODE_VALUES).map(|i| 0.5 + f64::from(i as u32) * 0.00005).collect();
        HdrMatch {
            lens: Lens {
                distortion: Some(vec![0.0, 0.011, 0.023, 0.041]),
                crop: 1.0234,
                falloff: Some((0.317, -0.0412)),
                tca: Some([vec![1.0, 1.0004], vec![1.0, 0.9993]]),
            },
            colour: Some(HdrColour {
                curves: [curve(0.01), curve(0.02), curve(0.03)],
                // A raised domain, so the round trip is tested on the field's whole range
                // rather than on the default the decoder could have invented.
                ceiling: 1.25,
                anchor: crate::hdr_fit::chroma_anchor(&curve(0.02), 1.25),
                matrix: [
                    [1.02, -0.01, 0.003],
                    [-0.02, 1.03, -0.011],
                    [0.004, -0.02, 1.04],
                ],
                saturation: 0.937,
                delta_e: 1.83,
                curve: vec![[0.0, 0.04], [0.35, 0.3], [0.68, 0.72], [1.0, 1.0]],
                curve_error: 0.0,
                // Densified, as every map a fit hands out is: the writer stores its coarse
                // decimation and the reader densifies back, so this round-trips exactly.
                chroma: ChromaMap::from_parts(&nodes, [0.11, 0.22], [3.5, 4.5])
                    .map(|map| map.densified()),
                surround: crate::hdr_fit::SurroundThumb {
                    width: 8,
                    height: 5,
                    data: (0..40)
                        .map(|i| f64::from(half::f16::from_f64(0.02 + i as f64 * 0.011)))
                        .collect(),
                },
            }),
        }
    }

    fn a_noise() -> NoiseFit {
        NoiseFit {
            alpha: 3.17e-5,
            sigma_sq: 4.09e-7,
            unified_sigma: 0.00413,
            dark_ref: [0.0031, 0.0029, 0.0030, 0.0032],
        }
    }

    fn a_levels() -> MeasuredLevels {
        MeasuredLevels {
            levels: Levels {
                white: Light::measured(9137.25),
                peak: Light::measured(41830.5),
                floor: Some(Light::measured(163.0)),
            },
            white_quantile: 0.995,
        }
    }

    fn a_peak() -> MeasuredPeak {
        MeasuredPeak {
            nits: Light::measured(4130.5),
            reference_white_nits: Light::exactly(203.0),
            white_quantile: 0.995,
        }
    }

    fn a_defocus() -> MeasuredDefocus {
        MeasuredDefocus {
            red: 0.0137,
            blue: -0.0091,
            defringe: 0.5,
            long_edge: 6000,
        }
    }

    /// A count a real sensor plausibly offers, so what the section costs is the measured shape of
    /// the thing rather than one spot's worth extrapolated.
    fn some_dust() -> Vec<crate::dust::Spot> {
        (0..40u16)
            .map(|at| {
                let step = f32::from(at);
                crate::dust::Spot {
                    x: 130.5 + step * 37.25,
                    y: 88.25 + step * 19.5,
                    scale: 5.5 + step * 0.031,
                    axes: (1.07, 1.0 / 1.07),
                    // A real direction: the search emits `(cos, sin)`, and `Spot::from_words` refuses
                    // anything that is not one - a `turn` off the unit circle rescales the ellipse
                    // the kernel writes into without moving the reach the spots were kept apart by.
                    turn: (0.8, 0.6),
                    snr: 4.5 + step * 0.11,
                    // Falling with radius, as a real one does, and never equal between bins: a
                    // profile read out of the wrong offset then shows up as a mismatch.
                    profile: std::array::from_fn(|bin| 0.13 - 0.008 * bin as f32 - step * 0.0003),
                }
            })
            .collect()
    }

    fn everything() -> PhotoAnalysis {
        PhotoAnalysis {
            from_raw: FromRaw {
                matched: Some(a_match()),
                noise: Some(a_noise()),
                dust: Some(some_dust()),
                capture_sigma: Some(0.62),
                balance: Some(Balance {
                    wb_gains: [2.14, 1.0, 1.63],
                    as_shot: Some(crate::white_balance::AsShot {
                        temperature: 5240.0,
                        tint: -3.5,
                    }),
                }),
            },
            from_render: FromRender {
                levels: Some(a_levels()),
                scene_peak: Some(a_peak()),
                defocus: Some(a_defocus()),
                set: Some(SetStamp::of([("gvpq7z", 1.0), ("gvpq80", 0.94)], 1)),
            },
        }
    }

    #[test]
    fn an_analysis_survives_the_round_trip() {
        let before = everything();
        let after = decode(&encode(&before)).expect("it reads back");

        let was = before.from_raw.matched.expect("a match");
        let is = after.from_raw.matched.expect("a match");
        let was_colour = was.colour.expect("colour");
        let is_colour = is.colour.expect("colour");
        // The curves keep `f32`, which is what their texture holds.
        for (channel, wanted) in is_colour.curves.iter().zip(&was_colour.curves) {
            for (read, wrote) in channel.iter().zip(wanted) {
                assert!((read - wrote).abs() < 1e-6, "{read} against {wrote}");
            }
        }
        assert_eq!(is_colour.curve.len(), was_colour.curve.len());
        for (read, wrote) in is_colour.curve.iter().zip(&was_colour.curve) {
            assert!(read.iter().zip(wrote).all(|(a, b)| (a - b).abs() < 1e-6), "{read:?} against {wrote:?}");
        }
        assert!((is_colour.saturation - was_colour.saturation).abs() < 1e-6);
        assert!((is_colour.delta_e - was_colour.delta_e).abs() < 1e-6);
        assert!((is.lens.crop - was.lens.crop).abs() < 1e-6);
        assert!(is.lens.distortion.is_some());
        assert!((is.lens.falloff.unwrap().1 - was.lens.falloff.unwrap().1).abs() < 1e-6);

        // **The lattice keeps only what its texture does.** `rgba16float` is where these end up, so
        // storing more than `f16` would be storing precision the GPU discards - and the tolerance
        // here says exactly that rather than hiding it behind a loose comparison.
        let (read, wrote) = (
            is_colour.chroma.expect("a map").nodes_flat(),
            was_colour.chroma.expect("a map").nodes_flat(),
        );
        for (read, wrote) in read.iter().zip(&wrote) {
            assert!((read - wrote).abs() < 1e-3, "{read} against {wrote}");
        }
        assert!((is_colour.ceiling - was_colour.ceiling).abs() < 1e-3);
        assert_eq!(
            (is_colour.surround.width, is_colour.surround.height),
            (was_colour.surround.width, was_colour.surround.height),
        );
        for (read, wrote) in is_colour
            .surround
            .data
            .iter()
            .zip(&was_colour.surround.data)
        {
            assert!((read - wrote).abs() < 1e-3, "{read} against {wrote}");
        }
        assert_eq!(after.from_raw.noise.expect("a fit"), a_noise());
        // **The levels come back to the bit**, which is what storing them as `f64` is for: the
        // coding divides by this white, and the fixtures compare a frame coded against a stored one
        // with a frame coded against a fresh measurement.
        assert_eq!(after.from_render.levels.expect("levels"), a_levels());
        assert_eq!(after.from_render.scene_peak.expect("a peak"), a_peak());
        assert_eq!(after.from_render.defocus.expect("a defocus"), a_defocus());
        assert_eq!(
            after.from_render.set.expect("a set"),
            everything().from_render.set.unwrap()
        );
        // `f32`, which is what the gains are on the device and what a temperature panel shows to
        // the nearest ten Kelvin.
        let balance = after.from_raw.balance.expect("a balance");
        let wanted = everything().from_raw.balance.unwrap();
        let (read, wrote) = (
            balance.as_shot.expect("an illuminant"),
            wanted.as_shot.unwrap(),
        );
        assert!((read.temperature - wrote.temperature).abs() < 0.1);
        assert!((read.tint - wrote.tint).abs() < 1e-4);
        assert_eq!(balance.wb_gains, wanted.wb_gains);
        // And a file with no usable multipliers keeps its gains, which is the half the sharpen
        // reads: a PNG balanced at one is a balance, not the absence of one.
        let mut gains_only = everything();
        gains_only.from_raw.balance = Some(Balance {
            wb_gains: [1.0; 3],
            as_shot: None,
        });
        let read = decode(&encode(&gains_only))
            .expect("it reads back")
            .from_raw
            .balance;
        assert_eq!(
            read,
            Some(Balance {
                wb_gains: [1.0; 3],
                as_shot: None
            })
        );
    }

    /// What one photograph costs on disk, so the number is measured rather than remembered.
    ///
    /// This fixture's cost is the fixed part: the chroma lattice at 7938 `f16` across its
    /// four axes, the curves at 768 `f32`, the particles at 22 `f32` each. A real fit adds
    /// the surround thumb at its own grid.
    ///
    /// The two are checked apart because they scale differently: the first is a constant per
    /// photograph and the second is however dirty the glass was.
    #[test]
    fn a_photograph_costs_about_thirty_one_kilobytes() {
        let bytes = encode(&everything()).len();
        assert!(
            (29_000..=33_000).contains(&bytes),
            "one photograph's analysis is {bytes} bytes",
        );

        let clean = PhotoAnalysis {
            from_raw: FromRaw {
                dust: None,
                ..everything().from_raw
            },
            ..everything()
        };
        let clean_bytes = encode(&clean).len();
        assert!(
            (25_000..=29_500).contains(&clean_bytes),
            "a clean photograph's analysis is {clean_bytes} bytes",
        );

        // The ceiling, which is what `dust::MOST_SPOTS` exists to put a number on.
        let filthy = PhotoAnalysis {
            from_raw: FromRaw {
                dust: Some(
                    some_dust()
                        .into_iter()
                        .cycle()
                        .take(crate::dust::MOST_SPOTS)
                        .collect(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };
        let bytes = encode(&filthy).len();
        assert!(
            bytes < 32_000,
            "the dirtiest sensor's analysis is {bytes} bytes"
        );
    }

    #[test]
    fn a_section_is_kept_or_dropped_on_its_own() {
        let parts = [
            PhotoAnalysis {
                from_raw: FromRaw {
                    matched: Some(a_match()),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_raw: FromRaw {
                    noise: Some(a_noise()),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_raw: FromRaw {
                    dust: Some(some_dust()),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_raw: FromRaw {
                    capture_sigma: Some(0.62),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_render: FromRender {
                    levels: Some(a_levels()),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_render: FromRender {
                    scene_peak: Some(a_peak()),
                    ..Default::default()
                },
                ..Default::default()
            },
            PhotoAnalysis {
                from_render: FromRender {
                    defocus: Some(a_defocus()),
                    ..Default::default()
                },
                ..Default::default()
            },
        ];
        for analysis in parts {
            let after = decode(&encode(&analysis)).expect("it reads back");
            assert_eq!(
                after.from_raw.matched.is_some(),
                analysis.from_raw.matched.is_some()
            );
            assert_eq!(after.from_raw.noise, analysis.from_raw.noise);
            assert_eq!(after.from_raw.dust, analysis.from_raw.dust);
            assert_eq!(
                after.from_raw.capture_sigma,
                analysis.from_raw.capture_sigma
            );
            assert_eq!(after.from_render, analysis.from_render);
        }
        assert!(
            decode(&encode(&PhotoAnalysis::default()))
                .expect("an empty one reads")
                .is_empty()
        );
    }

    /// **What the framing is for.** The sections grow over time, and a build made before one
    /// existed has to keep the photograph's match rather than refit it - so an unknown kind is
    /// stepped over on its length and everything around it still arrives.
    #[test]
    fn a_section_this_build_has_never_heard_of_is_stepped_over() {
        let mut bytes = encode(&PhotoAnalysis {
            from_raw: FromRaw {
                matched: Some(a_match()),
                noise: Some(a_noise()),
                ..Default::default()
            },
            ..Default::default()
        });
        section(&mut bytes, 200, |body| {
            body.extend_from_slice(&[1, 2, 3, 4, 5])
        });
        section(&mut bytes, KIND_SCENE_PEAK, |body| {
            put_peak(body, &a_peak())
        });

        let after = decode(&bytes).expect("it reads past the section it does not know");
        assert!(after.from_raw.matched.is_some());
        assert_eq!(after.from_raw.noise.expect("a fit"), a_noise());
        assert_eq!(after.from_render.scene_peak.expect("a peak"), a_peak());
    }

    #[test]
    fn a_blob_this_build_does_not_know_reads_as_nothing_stored() {
        assert!(decode(&[]).is_none());
        assert!(decode(b"not an analysis").is_none());

        // A version this build has never seen is ignored rather than misread: the alternative is
        // reading one layout's bytes as another's, which is a photograph with somebody else's
        // colour rather than a photograph that had to be measured again.
        let mut wrong = encode(&everything());
        wrong[3] = VERSION + 1;
        assert!(decode(&wrong).is_none());

        // And a blob cut short stops rather than reading past the end.
        let whole = encode(&everything());
        assert!(decode(&whole[..whole.len() / 2]).is_none());
    }

    /// A noise fit is seven numbers every pixel is scaled by, so one that has been corrupted has to
    /// read as absent rather than as a filter strength.
    #[test]
    fn a_noise_fit_that_could_not_have_been_measured_reads_as_none() {
        let broken = PhotoAnalysis {
            from_raw: FromRaw {
                noise: Some(NoiseFit {
                    alpha: 0.0,
                    ..a_noise()
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(decode(&encode(&broken)).unwrap().from_raw.noise.is_none());
    }

    /// One section this build will not take costs that section and nothing else.
    ///
    /// **What the alternative costs is silence.** Refusing the whole blob for one bad field means a
    /// photograph also refits its camera match - half a second - and its noise and its aberration,
    /// on every render, for ever, while `adds_to` stays true so the file is rewritten each time and
    /// nothing is logged. Each section carries its own length and the reader steps over it either
    /// way, so there is nothing to be gained by taking the rest down with it.
    ///
    /// The noise is the broken one here because it is checked against physics rather than against
    /// the caller's settings, so it fails for every reader rather than only for some.
    #[test]
    fn a_section_this_build_refuses_leaves_the_others_alone() {
        let mut blob = everything();
        blob.from_raw.noise = Some(NoiseFit {
            alpha: 0.0,
            ..a_noise()
        });

        let read = decode(&encode(&blob)).expect("the blob still reads");
        assert!(
            read.from_raw.noise.is_none(),
            "the section that could not be read survived"
        );
        assert_eq!(
            read.from_raw.matched.is_some(),
            blob.from_raw.matched.is_some()
        );
        assert_eq!(read.from_render.levels, blob.from_render.levels);
        assert_eq!(read.from_render.scene_peak, blob.from_render.scene_peak);
        assert_eq!(read.from_render.defocus, blob.from_render.defocus);
    }

    #[test]
    fn a_stored_curve_the_grade_would_refuse_is_not_read() {
        let mut blob = everything();
        let colour = blob.from_raw.matched.as_mut().and_then(|m| m.colour.as_mut()).expect("colour");
        colour.curve = vec![[0.5, 0.0], [0.4, 1.0]];

        let read = decode(&encode(&blob)).expect("the blob still reads");
        assert!(
            read.from_raw.matched.and_then(|m| m.colour).is_none(),
            "an unsorted curve reached the grade"
        );
        assert_eq!(read.from_raw.noise.is_some(), blob.from_raw.noise.is_some());
    }

    /// The quantiles a library can actually be configured with are readable.
    ///
    /// `settings.ts` is `min(0).max(1)`, so both ends are reachable from the UI. A validator that
    /// refused them rejected a section this side had just written, and the whole blob with it.
    #[test]
    fn the_ends_of_the_quantile_range_are_not_refused() {
        for quantile in [0.0, 1.0, 0.5, 0.995] {
            let blob = PhotoAnalysis {
                from_render: FromRender {
                    scene_peak: Some(MeasuredPeak {
                        white_quantile: quantile,
                        ..a_peak()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            };
            let read = decode(&encode(&blob)).expect("the blob reads");
            assert!(
                read.from_render.scene_peak.is_some(),
                "a peak measured at quantile {quantile} was refused",
            );
        }
    }

    /// What separates the two sections: a render measured under settings the caller is not asking
    /// about answers nothing, where the match beside it is still the match.
    #[test]
    fn a_render_measured_under_other_settings_answers_nothing() {
        assert!(a_levels().levels_at(0.995).is_some());
        assert!(a_levels().levels_at(0.99).is_none());

        assert_eq!(
            a_peak().nits_at(0.995, Light::exactly(203.0)),
            Some(Light::measured(4130.5)),
        );
        assert!(a_peak().nits_at(0.995, Light::exactly(100.0)).is_none());
        assert!(a_peak().nits_at(0.99, Light::exactly(203.0)).is_none());

        assert_eq!(a_defocus().pair_for(0.5, 6000), Some((0.0137, -0.0091)));
        // The defringe setting is one of its inputs, not just a label: the pair comes back already
        // scaled by it, so a library that has moved the slider is asking about a different number.
        assert!(a_defocus().pair_for(1.0, 6000).is_none());
        // **And so is the resolution**, a coefficient being a blur difference in pixels squared: the
        // same lens on the same photograph measures a quarter as much at half the size, and a decode
        // halves itself whenever the largest target leaves room. A pair handed across that boundary
        // would defringe a full-size export at a quarter strength.
        assert!(a_defocus().pair_for(0.5, 3000).is_none());
    }

    /// A coefficient past what a lens does reads as absent: every high-contrast edge in the frame
    /// is shifted by it, so a blob that has been truncated or edited must not reach the defringe.
    ///
    /// Absent rather than fatal - the section goes and the blob stays, which
    /// `a_section_this_build_refuses_leaves_the_others_alone` is the general statement of.
    #[test]
    fn a_defocus_that_could_not_have_been_measured_reads_as_none() {
        for broken in [
            MeasuredDefocus {
                red: 4.0,
                ..a_defocus()
            },
            MeasuredDefocus {
                blue: f32::NAN,
                ..a_defocus()
            },
            MeasuredDefocus {
                defringe: 3.0,
                ..a_defocus()
            },
            // A frame of no size is a coefficient with no scale to be read at.
            MeasuredDefocus {
                long_edge: 0,
                ..a_defocus()
            },
        ] {
            let analysis = PhotoAnalysis {
                from_render: FromRender {
                    defocus: Some(broken),
                    ..Default::default()
                },
                ..Default::default()
            };
            let read = decode(&encode(&analysis)).expect("the blob still reads");
            assert!(
                read.from_render.defocus.is_none(),
                "{broken:?} reached the defringe"
            );
        }
    }

    #[test]
    fn what_a_writer_holds_is_merged_into_what_is_stored() {
        let stored = PhotoAnalysis {
            from_raw: FromRaw {
                matched: Some(a_match()),
                ..Default::default()
            },
            ..Default::default()
        };
        let fresh = PhotoAnalysis {
            from_raw: FromRaw {
                noise: Some(a_noise()),
                dust: Some(some_dust()),
                ..Default::default()
            },
            from_render: FromRender {
                levels: Some(a_levels()),
                ..Default::default()
            },
        };
        assert!(fresh.adds_to(&stored));

        let merged = fresh.filled_from(&stored);
        assert!(
            merged.from_raw.matched.is_some(),
            "the match it did not measure survived"
        );
        assert_eq!(merged.from_raw.noise.expect("a fit"), a_noise());
        assert_eq!(
            merged.from_raw.dust.as_deref(),
            Some(some_dust().as_slice())
        );
        assert_eq!(merged.from_render.levels.expect("levels"), a_levels());

        // And nothing is written for an analysis that says only what is already on disk.
        let again = PhotoAnalysis {
            from_raw: FromRaw {
                noise: Some(a_noise()),
                dust: Some(some_dust()),
                ..Default::default()
            },
            from_render: FromRender {
                levels: Some(a_levels()),
                ..Default::default()
            },
        };
        assert!(!again.adds_to(&merged));
    }

    #[test]
    fn a_partial_match_inherits_colour_only_from_the_same_render_basis() {
        let stamp = |name: &str| SetStamp::of([(name, 1.0)], 0);
        let full = PhotoAnalysis {
            from_raw: FromRaw { matched: Some(a_match()), ..Default::default() },
            from_render: FromRender { levels: Some(a_levels()), set: Some(stamp("a")), ..Default::default() },
        };
        let lens = |set, white_quantile| PhotoAnalysis {
            from_raw: FromRaw {
                matched: Some(HdrMatch { lens: a_match().lens, colour: None }),
                ..Default::default()
            },
            from_render: FromRender {
                levels: Some(MeasuredLevels { white_quantile, ..a_levels() }),
                set: Some(set),
                ..Default::default()
            },
        };

        assert!(lens(stamp("a"), a_levels().white_quantile)
            .filled_from(&full)
            .from_raw.matched.expect("match").colour.is_some());
        assert!(lens(stamp("b"), a_levels().white_quantile)
            .filled_from(&full)
            .from_raw.matched.expect("lens").colour.is_none());
        assert!(lens(stamp("a"), a_levels().white_quantile + 0.01)
            .filled_from(&full)
            .from_raw.matched.expect("lens").colour.is_none());
    }
}
