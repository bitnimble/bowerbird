//! Finding the particles on the sensor's cover glass, and dividing their shadows back out.
//!
//! **A particle is an out-of-focus image of the iris, not of the particle.** It sits a millimetre or
//! so above the photosites, so what lands is its silhouette convolved with the pupil - which is
//! vastly the larger of the two, and so decides the shape. That is why a spot is a soft-edged disc
//! whatever the speck actually looks like, why its diameter is `height / f-number`, and why the same
//! particle is a hard dark coin at f/22 and simply absent at f/2.8.
//!
//! Three consequences, and the whole of the detection rests on them:
//!
//! - **Multiplicative.** A covered photosite reads the real radiance times some beta below one, so
//!   the residual is additive in log space and the correction is a divide. There is scene under a
//!   dust spot and it comes back.
//! - **Achromatic.** Geometric occlusion, not a filter, so the dip is equal in all three channels
//!   where a scene edge's is not. Detected on the mosaic for that reason: the demosaic spreads the
//!   dip across neighbours and gives it a colour it did not have.
//! - **Fixed in sensor coordinates.** Nothing here uses that yet - it is what a stack across a whole
//!   shoot would exploit, and where this becomes able to separate a particle from a mole.
//!
//! **What one frame cannot do.** Measured on a 24MP f/22 landscape: over smooth sky the gates below
//! find every visible particle and nothing else, and over lichen-covered rock they cannot, because a
//! dark round dust-sized patch of rock *is* a dark round dust-sized patch. Every discriminator here
//! narrows that overlap and none closes it. So the SNR gate is load-bearing rather than a tuning
//! knob: it is what confines the answer to the regions where the answer is trustworthy, and the
//! correction is only sound where it has passed.

use crate::px::{Extent, Millimetre};

/// Profile samples per spot, spanning [`SPAN`] elliptical radii. Matched in `dust.slang`.
pub const BINS: usize = 14;

/// How far out a spot's stored profile reaches, in blob radii.
///
/// **Two, not one.** The measured profile is still 35% of its peak at 1.16 radii and 15% at 1.5,
/// reaching zero near 2.0 - so a footprint taken from the detection threshold captures the core and
/// leaves the entire outer skirt behind, which is wrong by a factor of two in radius and four in
/// area. It reads as a faint ring around every corrected spot.
pub const SPAN: f32 = 2.5;

/// Floats per spot as `dust.slang` reads them: the ellipse, the gate's numbers, the profile.
pub const SPOT_WORDS: usize = 8 + BINS;

/// Below the per-spot gate, so a particle grows to its full extent before it is judged.
const MASK_SNR: f32 = 2.5;

/// The most candidates kept for one photograph, which bounds both the sidecar and the dispatch.
///
/// At [`SPOT_WORDS`] floats each this is 22kB, against the 5kB the rest of an analysis costs - so a
/// filthy sensor's blob is about 28kB, and `image_api` refuses one over 64kB. A clean sensor offers
/// a few dozen; a frame that fills this is one to clean rather than to correct.
pub const MOST_SPOTS: usize = 256;

/// The deepest log dip a stored spot may claim before it stops being a particle.
///
/// **A discriminator, not a safety rail, and the only one that acts on magnitude.** A shadow is the
/// pupil convolved with something far smaller, so it is an attenuation of a few percent to about a
/// third. On the reference frame every candidate in the sky came back between 0.018 and 0.26, and
/// the ones at 0.46 to 1.09 were all rock - dark scene features that happen to be round and
/// dust-sized. Without this they are merely unlikely, and a reader who turns the sensitivity up to
/// catch a faint spot gets a patch of hillside brightened threefold, which is far worse than the
/// spot they were chasing.
///
/// The search applies it too, in `dust_find.slang`, because a writer looser than its own reader
/// emits spots this would later refuse.
const MOST_DIP: f32 = 0.35;

/// The largest blob radius a detection can produce, in quad pixels, and so the largest a stored one
/// may claim. The area bracket admits a diameter of `4 * dust_half_px`, and `dust_half_px` is itself
/// bounded by [`Sensor::shrink`] holding the working scale near [`WORKING_RADIUS`] - so a real spot
/// is tens of pixels across on any body. This is generous by an order of magnitude and still bounds
/// the kernel's loop to something a GPU finishes.
const MOST_SCALE: f32 = 512.0;

/// The most elongated a spot may be, as the longer semi-axis with the two normalised to unit
/// product - so this is a 100:1 lozenge, far past the 1.32:0.76 of the most elongated particle
/// measured. It bounds both the profile fit's own reach and the kernel's.
const MOST_ELONGATION: f32 = 10.0;

/// What the sensitivity slider moves between, as the SNR a spot must clear.
///
/// The whole range is useful: on the reference frame the true and false populations overlap from
/// about 3.5 to 4.0, so a reader who wants only the certain ones and a reader who wants every smudge
/// are asking for different points on one axis rather than for different algorithms.
const SNR_AT_LEAST_SENSITIVE: f32 = 8.0;
const SNR_AT_MOST_SENSITIVE: f32 = MASK_SNR;

/// The widest aperture worth looking at, as an f-number.
///
/// **Physics rather than a budget.** A shadow's depth goes as `N^2` and its diameter as `d/N`, so
/// stopping down concentrates a particle and opening up spreads it into nothing: the deepest of the
/// 33 on the reference body is 0.26 at f/22, which is 0.017 at f/5.6 - under the visibility floor,
/// and so under what anyone can see. Wider than this a frame cannot hold a detectable particle
/// whatever is on the glass.
///
/// It is also where the cost is. The predicted diameter *grows* as the aperture opens, and it sizes
/// the morphology's window, whose cost is linear in its radius - so without this the longest searches
/// are the ones that were never going to find anything.
const WIDEST_USEFUL_APERTURE: f32 = 5.6;

/// The blob radius the gates and the profile were measured against, in working samples.
///
/// The reference body predicts about this at f/22, so it is both the scale everything below was
/// tuned at and the floor [`Sensor::shrink`] will not take a frame under.
///
/// **Measured, not assumed.** Forced to half of it, that frame's 33 particles become 23 - the weak
/// tail goes, which the sensitivity gate would have taken anyway - but the depths of the survivors
/// move by up to 28%, and a depth is what the correction divides out. So the floor is about the
/// *plateau* being resolved rather than about finding the spot at all, and it is why a body cannot
/// simply be read as coarsely as its memory would like.
const WORKING_RADIUS: f32 = 7.8;

/// The height of the sensor stack a particle is assumed to rest on, in microns.
///
/// Only the band-pass scale and the area bracket depend on it, both of which are bracketed wide - so
/// this being wrong for a body costs a little sensitivity rather than an answer. Measured spots on
/// the reference body ran to twice the diameter this predicts, which is why the upper area bound is
/// four times the prediction rather than a tight fit.
const PARTICLE_HEIGHT_UM: f32 = 2000.0;

/// What a body is taken to be where the file names no size: 36x24mm's diagonal, in millimetres.
///
/// The 35mm-equivalent focal length is the only reading of a sensor's size that crosses makers, and
/// a body that recorded a focal length but no equivalent has said nothing about how large it is.
/// Guessing full frame there predicts a smaller shadow than a smaller body really casts, which the
/// area bracket absorbs; guessing anything else would mis-size the frames that are full frame.
pub const FULL_FRAME_DIAGONAL_MM: Extent<Millimetre> = Extent::exactly(43.266_615);

/// One particle, in the half-resolution quad coordinates the mosaic was read in.
///
/// The profile travels with the spot rather than being refitted from a depth and a shape: each
/// particle sits at its own height, so each has its own edge softness relative to its own radius, and
/// one mean shape rescaled per spot leaves a systematic ring on every spot that is not average.
#[derive(Clone, Debug, PartialEq)]
pub struct Spot {
    pub x: f32,
    pub y: f32,
    /// The blob's own radius, which is the unit the profile's bins are spaced in.
    pub scale: f32,
    /// Semi-axes normalised to unit product, so an elliptical radius stays in blob radii and a round
    /// spot collapses to plain distance exactly.
    pub axes: (f32, f32),
    /// The major axis as a direction, so the shader needs no trigonometry.
    pub turn: (f32, f32),
    pub snr: f32,
    /// Log-radiance dip per bin, which is what the correction divides out.
    pub profile: [f32; BINS],
}

impl Spot {
    /// The spot as `dust.slang` indexes it, which is also how it is stored.
    pub fn words(&self) -> [f32; SPOT_WORDS] {
        let head =
            [self.x, self.y, self.scale, self.axes.0, self.axes.1, self.turn.0, self.turn.1, self.snr];
        std::array::from_fn(|at| match at < head.len() {
            true => head[at],
            false => self.profile[at - head.len()],
        })
    }

    /// The spot those words describe, or None where they could not have been measured.
    ///
    /// **Checked rather than merely parsed, and bounded rather than merely signed.** These reach a
    /// kernel that multiplies photosites by `exp(dip)` and *sizes its loop* from a radius, so a blob
    /// that has been truncated or edited must read as absent rather than as a correction.
    ///
    /// Each bound is a distinct hazard, and none of them is theoretical once the sidecar is a file
    /// on disk:
    ///
    /// - a non-finite axis is a NaN radius and a picture of holes;
    /// - an unbounded dip is a spot that blows a disc to white;
    /// - an unbounded `scale` is `box * box` iterations in *one* 64-lane workgroup - at `scale`
    ///   1e5 that is billions, which is a lost adapter and a dead tab rather than a wrong pixel;
    /// - an unbounded axis ratio is the same hang wearing a plausible `scale`;
    /// - axes whose product is not one are not the ellipse `axes` says they are: an elliptical
    ///   radius stops being a count of blob radii, so the profile is read at the wrong bin and the
    ///   correction is divided out at a size nothing measured. `(1e-30, 10)` clears every other
    ///   bound here and corrects a single row of the frame;
    /// - and a `turn` that is not a unit vector rescales the ellipse the kernel writes into without
    ///   moving the `reach()` that [`prune_overlaps`] kept spots apart by - so the footprints can
    ///   overlap after all, and the kernel's atomic-free read-modify-write starts racing. `(0, 0)`
    ///   is the worst of them: every radius collapses to zero and the whole box takes the plateau,
    ///   which is a hard-edged bright square.
    pub fn from_words(words: &[f32; SPOT_WORDS]) -> Option<Spot> {
        let spot = Spot {
            x: words[0],
            y: words[1],
            scale: words[2],
            axes: (words[3], words[4]),
            turn: (words[5], words[6]),
            snr: words[7],
            profile: std::array::from_fn(|bin| words[8 + bin]),
        };
        let unit = spot.turn.0 * spot.turn.0 + spot.turn.1 * spot.turn.1;
        let shaped = words.iter().all(|value| value.is_finite())
            && (0.0..=MOST_SCALE).contains(&spot.scale)
            && spot.scale > 0.0
            && spot.axes.0 > 0.0
            && spot.axes.1 > 0.0
            && spot.axes.0.max(spot.axes.1) <= MOST_ELONGATION
            && (spot.axes.0 * spot.axes.1 - 1.0).abs() < 1e-3
            && (unit - 1.0).abs() < 1e-3
            && spot.snr >= 0.0
            && spot.profile.iter().all(|dip| (0.0..=MOST_DIP).contains(dip));
        shaped.then_some(spot)
    }

    /// How far the correction reaches from the centre, in quad pixels.
    fn reach(&self) -> f32 {
        SPAN * self.scale * self.axes.0.max(self.axes.1)
    }
}

/// What a *whole frame* should do about particles, shaped as [`crate::galosh::Fit`] is.
///
/// Only a whole frame can hold this, and that is enforced rather than asked for: a window takes
/// [`Known`], which has no way to spell "search". See its documentation for why.
#[derive(Clone, Copy)]
pub enum Wanted<'a> {
    Off,
    /// Search this mosaic, which the type guarantees is the whole frame's.
    Measure(Removal),
    Given(&'a [Spot], Removal),
}

/// What a *window* should do about particles: correct from the photograph's list, or nothing.
///
/// **There is no `Measure`, and the absence is the point.** The gates read the frame's own texture
/// floor and its own quantile, so a band or a loupe tile that searched itself would find a different
/// set from the picture around it, and the strips of a re-prepare would be corrected differently
/// down the frame. A window path also hands the searcher a whole-sensor [`Sensor`] beside a
/// region-sized mosaic, so a search reaching one would read rows wider than the buffer holds.
///
/// Hence also what this type does *not* carry: no `Sensor`. That struct exists only to size a
/// search - the aperture, the pitch, the picture inside the plane - and a window never sizes one, so
/// there is nothing here for a region and a frame to disagree about.
#[derive(Clone, Copy)]
pub enum Known<'a> {
    Off,
    Given(&'a [Spot], Removal),
}

impl Known<'_> {
    /// Whether anything downstream would look different for it.
    pub fn does_anything(&self) -> bool {
        match self {
            Known::Off => false,
            Known::Given(spots, removal) => !spots.is_empty() && removal.does_anything(),
        }
    }
}

impl Wanted<'_> {
    fn removal(&self) -> Option<Removal> {
        match self {
            Wanted::Off => None,
            Wanted::Measure(removal) | Wanted::Given(_, removal) => Some(*removal),
        }
    }

    /// Whether anything downstream would look different for it, which is whether to detect at all.
    pub fn does_anything(&self) -> bool {
        self.removal().is_some_and(|removal| removal.does_anything())
    }
}

/// The reader's three controls, as they cross from a client.
///
/// One type rather than three fields on each request, because the pair that decides what a picture
/// looks like has to arrive together: a rendition given the sensitivity and not the intensity would
/// ship a different photograph from the editor that ordered it, silently.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub sensitivity: f64,
    pub intensity: f64,
}

/// Where the sensitivity slider starts, as its own position.
///
/// **A quarter, not a half, because this is on by default.** Through [`Removal::min_snr`] it is a
/// bar of about 6.0, well clear of the 3.5-to-4.0 band where the true and false populations overlap
/// on the reference frame - so what a reader gets without touching anything is the spots the search
/// was sure about. A particle nobody notices is missing costs nothing; a patch of hillside
/// confidently brightened threefold is a photograph they have to go and fix.
pub const SENSITIVITY_AT_REST: f64 = 0.25;

impl Default for Settings {
    /// What a request that named no dust settings is asking for, which is what the panel starts at.
    fn default() -> Settings {
        Settings { enabled: true, sensitivity: SENSITIVITY_AT_REST, intensity: 1.0 }
    }
}

impl Settings {
    /// What a decode should do, given whatever spots the caller already holds.
    ///
    /// Nothing detects for a caller that has switched this off - a photograph nobody asked to
    /// declutter must not pay a whole-frame read to find particles it will not remove.
    pub fn wanted<'a>(&self, spots: Option<&'a [Spot]>) -> Wanted<'a> {
        match (self.removal(), spots) {
            (None, _) => Wanted::Off,
            (Some(removal), Some(spots)) => Wanted::Given(spots, removal),
            (Some(removal), None) => Wanted::Measure(removal),
        }
    }

    /// The same for a window, which can only ever be handed a list.
    ///
    /// Takes the slice rather than an `Option` of one: a window with nothing to correct from
    /// corrects nothing, and there is deliberately no spelling here that would make it search.
    pub fn known<'a>(&self, spots: &'a [Spot]) -> Known<'a> {
        match self.removal() {
            None => Known::Off,
            Some(removal) => Known::Given(spots, removal),
        }
    }

    /// What the reader asked for, or None where they asked for nothing.
    fn removal(&self) -> Option<Removal> {
        let removal = Removal { sensitivity: self.sensitivity, intensity: self.intensity };
        (self.enabled && removal.does_anything()).then_some(removal)
    }
}

/// What the reader asked for, once the switch has been consulted.
#[derive(Clone, Copy, Debug)]
pub struct Removal {
    /// 0 keeps only the certain spots, 1 takes every candidate.
    pub sensitivity: f64,
    /// 0 leaves the picture alone, 1 divides the whole measured shadow out.
    pub intensity: f64,
}

impl Removal {
    /// The bar a spot's confidence must clear, as the slider's position between the two ends.
    ///
    /// **Geometric, because a signal-to-noise ratio is a ratio.** Stepped arithmetically, equal
    /// movements of the slider are equal *differences* in a quantity nothing perceives differences
    /// in - and the interval where the true and false populations actually overlap, 3.5 to 4.0 on
    /// the reference frame, then falls between 73 and 82 on a hundred-point control. Nine points of
    /// travel for the whole of the decision, and the rest spent walking through a range where the
    /// answer only gets safer.
    ///
    /// Stepped geometrically, each point of the slider is the same *fraction* of confidence as the
    /// last, that overlap spans 60 to 71, and the tail past it - where a mistake actually happens -
    /// gets 40% of the travel to be careful in rather than 27%. The ends are unchanged.
    pub fn min_snr(&self) -> f32 {
        let at = self.sensitivity.clamp(0.0, 1.0) as f32;
        SNR_AT_LEAST_SENSITIVE * (SNR_AT_MOST_SENSITIVE / SNR_AT_LEAST_SENSITIVE).powf(at)
    }

    /// How much of the measured shadow to divide out, bounded to the range the panel offers.
    ///
    /// Clamped for the reason the sensitivity above is: `Settings` is `#[serde(default)]` on three
    /// requests, so this arrives from JSON. The shader raises `e` to `dip * intensity`, and an
    /// unbounded multiplier there is an infinite photosite, which is a NaN through the demosaic and
    /// the grade - a picture of holes rather than a picture corrected too hard.
    pub fn intensity(&self) -> f32 {
        self.intensity.clamp(0.0, 1.0) as f32
    }

    /// Whether this would change any photosite, which is whether the pass is worth encoding.
    pub fn does_anything(&self) -> bool {
        self.intensity() > 0.0
    }
}

/// What the detection needs of the body, none of which the mosaic itself carries.
#[derive(Clone, Copy, Debug)]
pub struct Sensor {
    /// The whole readable plane, which is the buffer's own shape - and so its row stride.
    pub width: usize,
    pub height: usize,
    /// The picture inside it: `left, top, width, height`. The masked columns the black level is read
    /// from are a hard black edge against the picture, and the band-pass answers one with a false
    /// response larger than any particle.
    ///
    /// Read through [`Sensor::picture`], never directly: this comes out of the file.
    pub crop: (usize, usize, usize, usize),
    pub cfa: crate::cfa::Cfa,
    pub aperture: f32,
    /// How long [`Sensor::picture`]'s diagonal is across the silicon, in millimetres, which with its
    /// diagonal in photosites is the pitch a particle's shadow is predicted in.
    /// [`FULL_FRAME_DIAGONAL_MM`] where the file gave no reading of the body's size.
    pub diagonal_mm: Extent<Millimetre>,
}

impl Sensor {
    /// The picture, clamped to the plane it is supposed to be inside, on whole CFA sites.
    ///
    /// **The file says where the picture is, and the file can be wrong.** `crop_area` is
    /// `DefaultCropOrigin`/`DefaultCropSize` on a DNG and a camera table elsewhere, carried into
    /// `decode_rawler::hold` with nothing but an evening of the extent - so an origin of 100 beside
    /// a full-width size describes a rectangle that runs off the end of every row. Unclamped, the
    /// read below walks into the next row for most of the frame and past the buffer on the last
    /// band, which is a panic in a worker rather than a wrong picture.
    fn picture(&self) -> (usize, usize, usize, usize) {
        let left = (self.crop.0 & !1).min(self.width);
        let top = (self.crop.1 & !1).min(self.height);
        let width = (self.crop.2 & !1).min(self.width - left);
        let height = (self.crop.3 & !1).min(self.height - top);
        (left, top, width & !1, height & !1)
    }
}

impl Sensor {
    /// The predicted shadow's size, in working samples, which is the scale everything is set from.
    ///
    /// A particle's shadow is `PARTICLE_HEIGHT_UM / aperture` micrometres across whatever the body
    /// is - 91 at f/22 - so the first two terms are the diameter in photosites.
    ///
    /// **The last divide is one divide doing two jobs, and it must not be "fixed".** It reads either
    /// as the diameter halved, leaving a radius in photosites, or as photosites carried into quads,
    /// leaving a diameter in working samples. Both are the same number, and which one it *means* is
    /// not decided here: [`WORKING_RADIUS`] is the value this was measured against on a real body,
    /// not a figure derived from optics, and every scale below is a multiple of this one. Reading it
    /// as a radius and halving again, or reading it as a diameter and doubling, moves every blur, the
    /// morphology and the area bracket by a factor of two against gates nobody has re-measured.
    ///
    /// The body's own size where the file gave one and [`FULL_FRAME_DIAGONAL_MM`] where it did not,
    /// which on an APS-C frame is a pitch a third too coarse and so a shadow predicted two-thirds the
    /// size it is. The area bracket spans eleven times the prediction, which is what absorbs the
    /// bodies that still fall back.
    fn dust_half_px(&self, shrink: usize) -> f32 {
        let (_, _, width, height) = self.picture();
        let pitch_um =
            self.diagonal_mm.raw() as f32 * 1000.0 / (width as f32).hypot(height as f32).max(1.0);
        (PARTICLE_HEIGHT_UM / self.aperture) / pitch_um / 2.0 / shrink as f32
    }

    /// Whether this frame could hold a particle anyone could see ([`WIDEST_USEFUL_APERTURE`]).
    fn worth_reading(&self) -> bool {
        worth_reading(self.aperture)
    }

    /// How many 2x2 sites to average into one working sample, beyond the halving every frame gets.
    ///
    /// **The frame is read at the spot's scale, not the sensor's.** A particle is `d/N` across
    /// whatever the photosites are, so a denser body spends its extra resolution describing the same
    /// disc: a 25MP body at f/22 predicts a 7.8-sample radius and a 61MP body at f/10 predicts 26,
    /// for shadows that are the same fraction of the picture. One step of this halves the working
    /// grid on both axes, so it quarters the sample count, the ten planes' memory and every pass over
    /// them - on that 61MP frame, 75MB of device planes against 301MB to say the same thing.
    ///
    /// Never below [`WORKING_RADIUS`], which is the scale the gates and the profile's bin count were
    /// measured at: shrinking is for spending less on a body that offers more, never for taking a
    /// blob below what the fits need. A power of two so the average is over whole sites.
    pub fn shrink(&self) -> usize {
        let spare = self.dust_half_px(1) / WORKING_RADIUS;
        match spare >= 2.0 {
            true => 1 << spare.log2().floor().min(3.0) as usize,
            false => 1,
        }
    }
}

/// Whether a frame shot at this aperture could hold a particle anyone could see.
///
/// A file that recorded no f-number is refused with the wide ones: the scale the whole search is set
/// from comes out of it, so there is nothing to look *for* rather than nothing to look at.
///
/// **Takes the number rather than a [`Sensor`]**, because the caller that most needs it has no
/// sensor to hand: `job::Base::cropped` decides whether a cropped export may take the window route,
/// and it holds a header. A window cannot search, so it may only skip the whole-frame decode where
/// the search would have found nothing - which, wider than this, it always does.
pub fn worth_reading(aperture: f32) -> bool {
    aperture.is_finite() && aperture >= WIDEST_USEFUL_APERTURE
}

/// The working grid: the frame's own 2x2 sites, coarsened by whatever [`Sensor::shrink`] allows.
///
/// Even on both axes, at a cost of at most one sample each way: the planes hold two samples to a
/// word, and the transpose pairs them the other way round, so an odd row or column would put half a
/// word at the end of every line of one orientation or the other.
fn working(sensor: &Sensor) -> (usize, usize) {
    let step = 2 * sensor.shrink();
    let (_, _, width, height) = sensor.picture();
    (width / step & !1, height / step & !1)
}

/// Every candidate this frame offers, deepest first, with no gate the reader can move applied.
///
/// **Stored well below what any setting would keep**, down to [`MASK_SNR`], so the sensitivity slider
/// re-thresholds a list rather than re-detecting. Detection is a property of the photograph and costs
/// a whole-frame sweep; a slider must not pay for it.
///
/// **The mosaic never comes back off the device.** `dust_find.slang` runs the whole search where
/// the pixels are and hands over two things: the thresholded prominence, which is the flood fill's
/// mask and its heights at once, and the fitted spots, which are twenty-odd kilobytes. What is left
/// here is the fill itself, which has no shader, and the gates a blob is judged by before it is worth
/// fitting.
///
/// None where the frame has no adapter, no usable aperture, or is too small to band-pass.
pub async fn detect(
    gpu: &'static crate::gpu::Gpu,
    mosaic: &crate::condition::Mosaic,
    sensor: &Sensor,
) -> Option<Vec<Spot>> {
    // Ahead of everything else: a frame this wide open has no answer worth a sweep of the device.
    if !sensor.worth_reading() {
        return Some(Vec::new());
    }
    let mut lap = crate::clock::laps("  dust ");
    let kernels = crate::dust_find::device(gpu)?;
    let shrink = sensor.shrink();
    let (ox, oy, _, _) = sensor.picture();
    let (hw, hh) = working(sensor);
    let dust_half_px = sensor.dust_half_px(shrink);
    let coarse = 4.0 * dust_half_px;
    // Wide enough that the coarse blur's clamped edge cannot reach the middle: with none, the frame
    // wears a rim of components that are the blur's own boundary rather than anything on the glass.
    let margin = coarse.ceil() as usize;
    if hw <= 2 * margin || hh <= 2 * margin {
        return Some(Vec::new());
    }

    let shape = crate::dust_find::Shape {
        hw,
        hh,
        stride: mosaic.width,
        ox,
        oy,
        shrink,
        // `dust_find.slang` pairs rows and columns into 2x2 sites, so a pattern without one is not
        // searched rather than searched against the wrong colours.
        cfa: sensor.cfa.as_2x2()?,
        fine: (dust_half_px / 2.0).max(0.6),
        coarse,
        surround: dust_half_px,
        texture: 3.0 * dust_half_px,
        opening: (1.5 * dust_half_px).round().max(2.0) as usize,
        mask_snr: MASK_SNR,
    };
    let search = crate::dust_find::sweep(gpu, kernels, mosaic, &shape).await?;
    lap("sweep");

    let area_of = |diameter: f32| (std::f32::consts::PI / 4.0 * diameter * diameter) as usize;
    let bracket = area_of(0.35 * dust_half_px)..=area_of(4.0 * dust_half_px);
    let mut blobs: Vec<crate::dust_find::Blob> = components(&search.masked, hw, hh)
        .into_iter()
        .filter(|blob| {
            // The whole box, not the centroid: a blob straddling the margin has its centre inside it
            // while its body sits in the band the coarse blur clamped, and the ring around it then
            // takes several of its twelve samples off the same border pixel.
            let (x0, y0, x1, y1) = blob.box_of;
            let inside = x0 >= margin && y0 >= margin && x1 < hw - margin && y1 < hh - margin;
            inside && bracket.contains(&blob.area)
        })
        .map(|blob| crate::dust_find::Blob {
            cx: blob.cx as f32,
            cy: blob.cy as f32,
            area: blob.area as f32,
            peak: crate::dust_find::decoded(blob.peak),
        })
        .collect();
    // **Capped by height, before the fits rather than after them.** A halftone scan or a dense star
    // field at f/11 offers tens of thousands of candidates, and each one past this is a workgroup and
    // a row of the readback. Height is the numerator of the confidence the fits work out - `peak`
    // over the local noise - so this order and that one agree except where a blob sits somewhere
    // unusually noisy, which is a blob the gate is about to drop anyway. The slack over
    // [`MOST_SPOTS`] is so the prune below still has room to drop overlaps and leave a full list.
    blobs.sort_by(|a, b| b.peak.total_cmp(&a.peak));
    blobs.truncate(MOST_SPOTS * 4);

    let words = search.fits(gpu, kernels, &blobs).await?;
    drop(search);
    lap("fill, fits");

    let mut spots: Vec<Spot> = words
        .chunks_exact(SPOT_WORDS + 1)
        .filter(|run| run[SPOT_WORDS] > 0.5)
        .filter_map(|run| Spot::from_words(&std::array::from_fn(|at| run[at])))
        .collect();
    spots.sort_by(|a, b| b.snr.total_cmp(&a.snr));
    let mut spots = prune_overlaps(spots);
    // A sensor this dirty is one to clean rather than one to correct, and the cap is what bounds both
    // the sidecar and the dispatch. Sorted by confidence, so what goes is what was least sure.
    spots.truncate(MOST_SPOTS);
    Some(spots)
}

/// A spot whose footprint reaches into a stronger one's, dropped.
///
/// **What lets the kernel skip its atomic.** `dust.slang` runs a workgroup per spot and
/// multiplies into the mosaic in place, so two footprints over one photosite would race. Two
/// particles that close are one correction anyway: the survivor's profile was measured over both.
// ponytail: quadratic, over a couple of hundred spots. A grid if a sensor ever gets filthy enough.
fn prune_overlaps(spots: Vec<Spot>) -> Vec<Spot> {
    let mut kept: Vec<Spot> = Vec::with_capacity(spots.len());
    for spot in spots {
        let clear = kept.iter().all(|other| {
            let away = ((spot.x - other.x).powi(2) + (spot.y - other.y).powi(2)).sqrt();
            away > spot.reach() + other.reach()
        });
        if clear {
            kept.push(spot);
        }
    }
    kept
}

struct Blob {
    area: usize,
    cx: usize,
    cy: usize,
    /// The bounding box, for the margin gate: the centroid alone can sit inside the margin while
    /// the blob's own body and the ring around it reach past the frame's edge.
    box_of: (usize, usize, usize, usize),
    /// Still encoded, as the plane it was read from holds it.
    peak: u16,
}

/// The blobs a mask of thresholded prominence holds.
///
/// **The mask and the heights are one plane**, positive where a sample passed and zero where it did
/// not: the shader's threshold keeps a sample only where its prominence is already above zero, so a
/// positive sample and a masked one are the same sample, and the fill reads its heights out of the
/// buffer it is walking rather than out of a second one beside it.
///
/// Walked as the half floats the plane holds, because a non-negative one orders exactly as its bit
/// pattern does - so the two things asked here, "is it masked" and "which is tallest", are the same
/// answer encoded or not, and only the winner is decoded.
///
/// Summed as the fill runs rather than over a kept list of members: what anything downstream asks of
/// a blob is its extent, its centre and its height, and a frame of grain can offer thousands.
fn components(masked: &[u16], w: usize, h: usize) -> Vec<Blob> {
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    for start in 0..w * h {
        if masked[start] == 0 || seen[start] {
            continue;
        }
        let mut stack = vec![start];
        // The coordinate sums are 64-bit: a component spanning a 3000x2000 working grid sums to
        // about 9e9, past `u32::MAX`, and `usize` is 32 bits in a browser worker - where release
        // builds wrap silently rather than panicking, and a wrapped centroid is a confident
        // correction in the wrong place.
        let (mut area, mut sx, mut sy, mut peak) = (0usize, 0u64, 0u64, 0u16);
        let (mut x0, mut x1, mut y0, mut y1) = (usize::MAX, 0usize, usize::MAX, 0usize);
        seen[start] = true;
        while let Some(at) = stack.pop() {
            let (x, y) = (at % w, at / w);
            area += 1;
            sx += x as u64;
            sy += y as u64;
            peak = peak.max(masked[at]);
            (x0, x1) = (x0.min(x), x1.max(x));
            (y0, y1) = (y0.min(y), y1.max(y));
            for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    let (nx, ny) = (x as isize + dx, y as isize + dy);
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        continue;
                    }
                    let next = ny as usize * w + nx as usize;
                    if masked[next] != 0 && !seen[next] {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }
        }
        out.push(Blob {
            area,
            // The centroid, not the box's middle: an irregular particle's shadow is not centred in
            // its own bounding box, and every ring and every profile below is read from here.
            cx: (sx / area as u64) as usize,
            cy: (sy / area as u64) as usize,
            box_of: (x0, y0, x1, y1),
            peak,
        });
    }
    out
}

pub struct Dust {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> &'static Dust {
    static BUILT: std::sync::OnceLock<Dust> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Dust::new(gpu))
}

impl Dust {
    fn new(gpu: &crate::gpu::Gpu) -> Dust {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dust"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/dust.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("dust"),
            entries: &[
                entry(0, wgpu::BufferBindingType::Uniform),
                entry(1, wgpu::BufferBindingType::Storage { read_only: true }),
                entry(2, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("dust"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("dust"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("dust"),
            compilation_options: Default::default(),
            cache: None,
        });
        Dust { layout, pipeline }
    }
}

/// Search where this call is the one that has to, then divide what is known out of the whole frame.
///
/// Returns the list it found, for a caller that will be asked for the photograph's spots again - a
/// band, a loupe tile, the sidecar. `Wanted::Given` returns None because the caller already holds
/// them, which is the same shape `into_frame` reports a fit it was handed with.
///
/// No origin: this takes the frame's own mosaic, so the frame's own corner is where it starts. A
/// window goes through [`apply`].
pub async fn run(
    gpu: &'static crate::gpu::Gpu,
    mosaic: &crate::condition::Mosaic,
    sensor: &Sensor,
    wanted: &Wanted<'_>,
) -> Option<Vec<Spot>> {
    if !wanted.does_anything() {
        return None;
    }
    let kernels = device(gpu);
    match wanted {
        Wanted::Off => None,
        Wanted::Given(spots, removal) => {
            correct(gpu, kernels, mosaic, spots, *removal, (0, 0));
            None
        }
        Wanted::Measure(removal) => {
            let spots = detect(gpu, mosaic, sensor).await?;
            correct(gpu, kernels, mosaic, &spots, *removal, (0, 0));
            Some(spots)
        }
    }
}

/// Divides the photograph's own particles out of one window of it.
///
/// **This is the whole of what a window may do**, and it takes a [`Known`] to say so: there is no
/// argument here that could ask for a search, and no [`Sensor`] for one to be sized from. What it
/// returns is nothing, because a window learns nothing about the photograph that the photograph did
/// not already know.
///
/// `origin` is where this buffer sits on the sensor, in photosites, which is what puts a stored spot
/// on the right rows of a band or a loupe tile.
pub fn apply(
    gpu: &'static crate::gpu::Gpu,
    mosaic: &crate::condition::Mosaic,
    known: &Known<'_>,
    origin: (usize, usize),
) {
    let Known::Given(spots, removal) = known else { return };
    correct(gpu, device(gpu), mosaic, spots, *removal, origin);
}

/// What the correction writes, for `wgsl_layout`, which holds it against the struct its own
/// shader declares.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

/// `Params` in `dust.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    spots: u32,
    min_snr: f32,
    intensity: f32,
    pad: u32,
}

/// Divides these spots out of the mosaic where it lies.
///
/// `origin` is where this buffer sits on the sensor, in photosites, which is what lets a band of a
/// re-prepare and a loupe tile correct from the photograph's own spot list rather than detecting
/// against their own few hundred thousand photosites - a window that fitted its own would find a
/// different set from the frame around it, and the strips would stop being one picture.
pub fn correct(
    gpu: &crate::gpu::Gpu,
    kernels: &Dust,
    mosaic: &crate::condition::Mosaic,
    spots: &[Spot],
    removal: Removal,
    origin: (usize, usize),
) {
    if spots.is_empty() || !removal.does_anything() {
        return;
    }
    // **Pruned here, not only where they were found.** `dust.slang` skips its atomic because no
    // two workgroups can reach one photosite, and that is a property of the *list*, not of the
    // detection - but most lists arriving here came off a sidecar rather than out of `detect`. A
    // truncated file, a hand edit, or a later change to `SPAN` that widens every footprint without
    // bumping the analysis version all hand this overlapping spots, and the symptom is pixels that
    // differ run to run, which is the one thing the editor and the export may never do. Quadratic
    // over a list already capped at `MOST_SPOTS`, and a no-op for anything `detect` produced.
    let pruned = prune_overlaps(spots.to_vec());
    let spots = &pruned[..];
    let mut recording = gpu.record();
    recording.holding(&mosaic.buffer);
    let params = Params {
        width: mosaic.width as u32,
        height: mosaic.height as u32,
        origin_x: origin.0 as u32,
        origin_y: origin.1 as u32,
        spots: spots.len() as u32,
        min_snr: removal.min_snr(),
        intensity: removal.intensity(),
        pad: 0,
    };

    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("dust params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let words: Vec<f32> = spots.iter().flat_map(|spot| spot.words()).collect();
    let table = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("dust spots"),
        contents: bytemuck::cast_slice(&words),
        usage: wgpu::BufferUsages::STORAGE,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dust"),
        layout: &kernels.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: table.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: mosaic.buffer.as_entire_binding() },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(spots.len() as u32, 1, 1);
    }
    recording.submit();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sized(edge: usize) -> Sensor {
        Sensor {
            width: edge,
            height: edge,
            crop: (0, 0, edge, edge),
            cfa: crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap(),
            aperture: WIDEST_USEFUL_APERTURE,
            diagonal_mm: Extent::exactly(36.0 * std::f64::consts::SQRT_2),
        }
    }

    /// A denser body is read coarser, and never coarser than the fits need.
    ///
    /// The picture this decides is pinned in `tests/gpu_dust.rs`, which has a device to find one
    /// with; what is here is the arithmetic that decides how coarsely it is read at all.
    #[test]
    fn a_denser_body_is_read_coarser() {
        // Wide enough that the predicted shadow is twice the scale the gates were measured at,
        // which is what buys the shrink: a real 61MP body reaches this at f/10.
        let dense = sized(3200);
        assert_eq!(dense.shrink(), 2, "this body was meant to be worth reading coarser");
        assert!(
            dense.dust_half_px(dense.shrink()) >= WORKING_RADIUS,
            "shrinking took the blob under the scale the fits need",
        );
        assert_eq!(sized(1200).shrink(), 1, "the reference body must not move");
    }

    /// The same pixel count on a smaller body is a finer pitch, and so a larger shadow.
    ///
    /// **What every gate below is set from.** Read as full frame, an APS-C body's spots are
    /// predicted at two-thirds of the size they are, and a frame dense enough to be read coarser is
    /// not recognised as one - so it is searched at four times the memory and four times the passes
    /// for the same answer.
    #[test]
    fn a_smaller_body_casts_a_larger_shadow_in_its_own_photosites() {
        let full = sized(2200);
        let cropped = Sensor { diagonal_mm: Extent::exactly(full.diagonal_mm.raw() / 1.5), ..full };
        let ratio = cropped.dust_half_px(1) / full.dust_half_px(1);
        assert!((ratio - 1.5).abs() < 1e-3, "the crop factor did not reach the prediction: {ratio}");
        assert_eq!(full.shrink(), 1);
        assert_eq!(cropped.shrink(), 2, "a body this dense is worth reading coarser");
    }

    /// A crop factor is a ratio of diagonals, so a 4:3 body's pitch comes off its diagonal: an E-M1's
    /// 17.3mm across 5184 photosites, where 36mm over its crop of 2 says 18mm.
    #[test]
    fn a_four_thirds_pitch_is_its_own() {
        let four_thirds = Sensor {
            width: 5184,
            height: 3888,
            crop: (0, 0, 5184, 3888),
            diagonal_mm: Extent::exactly(FULL_FRAME_DIAGONAL_MM.raw() / 2.0),
            ..sized(2)
        };
        let expected = PARTICLE_HEIGHT_UM / four_thirds.aperture / (17.3 * 1000.0 / 5184.0) / 2.0;
        let predicted = four_thirds.dust_half_px(1);
        assert!((predicted / expected - 1.0).abs() < 0.005, "{predicted} against {expected}");
    }

    /// A frame shot wide open is not looked at, however dirty the glass behind it.
    ///
    /// **Both a right answer and the runtime.** A particle's shadow spreads as the aperture opens
    /// until there is nothing left to see - and the predicted diameter, which sizes the morphology,
    /// grows with it. Without this the longest searches were the ones that could not succeed. A file
    /// that recorded no f-number is refused with the wide ones, there being nothing to look *for*.
    #[test]
    fn nothing_is_looked_for_wide_open() {
        assert!(sized(1200).worth_reading());
        for aperture in [1.8, 2.8, 4.0, 5.0, f32::NAN] {
            let wide = Sensor { aperture, ..sized(1200) };
            assert!(!wide.worth_reading(), "f/{aperture} would be read for particles it cannot hold");
        }
    }

    /// The numbers that exist on both hosts, held against the two shaders that read them.
    ///
    /// Only the ones that genuinely live twice: a gate the search alone applies is declared in
    /// `dust_find.slang` and nowhere else, and has nothing here to drift from.
    #[test]
    fn the_shaders_declare_the_numbers_the_host_does() {
        // **The generated WGSL cannot be read for these.** A `static const` is folded into its use
        // sites before emission, so the declaration is gone from the output and only the Slang the
        // stage is written in still says the number.
        let declared = |name: &str, value: &str| {
            let ty = match value.ends_with('u') {
                true => "uint",
                false => "float",
            };
            format!("static const {ty} {name} = {};", value.trim_end_matches('u'))
        };

        const DUST: &str = include_str!("../../../slang/dust.slang");
        const FIND: &str = include_str!("../../../slang/dust_find.slang");
        for (file, source) in [("slang/dust.slang", DUST), ("slang/dust_find.slang", FIND)] {
            let line = declared("BINS", &format!("{BINS}u"));
            assert!(source.contains(&line), "{file} does not say `{line}`");
            // `SPAN` carries its unit, blob radii being a distance and not pixels of anything, so
            // it is braced where a bare count is not.
            let line = format!("static const Extent<BlobRadius> SPAN = {{ {SPAN:?} }};");
            assert!(source.contains(&line), "{file} does not say `{line}`");
        }

        // The two the search writes and `Spot::from_words` refuses a stored spot over.
        for (name, value) in
            [("MOST_DIP", format!("{MOST_DIP:?}")), ("MOST_ELONGATION", format!("{MOST_ELONGATION:?}"))]
        {
            let line = declared(name, &value);
            assert!(FIND.contains(&line), "slang/dust_find.slang does not say `{line}`");
        }

        // Derived from `BINS` on both sides, so widening the profile cannot leave one of them
        // indexing short. Asserted as text because that is the only thing this side can see.
        for (file, source) in [("slang/dust.slang", DUST), ("slang/dust_find.slang", FIND)] {
            assert!(
                source.contains("static const uint SPOT_WORDS = 8 + BINS;"),
                "{file} writes a spot at a width the other host does not read",
            );
        }
        assert_eq!(SPOT_WORDS, 8 + BINS, "the host's own spot is a different width");
    }

    /// A stored spot reaches a kernel that dispatches from its centre and exponentiates its profile,
    /// so a blob that has been truncated or edited has to read as absent rather than as a picture of
    /// holes.
    #[test]
    fn a_spot_that_could_not_have_been_measured_reads_as_none() {
        let sound = Spot {
            x: 100.0,
            y: 200.0,
            scale: 6.0,
            // Unit product, which is what the search emits and what an elliptical radius in blob
            // radii means.
            axes: (1.1, 1.0 / 1.1),
            turn: (1.0, 0.0),
            snr: 7.5,
            profile: [0.1; BINS],
        };
        assert_eq!(Spot::from_words(&sound.words()).as_ref(), Some(&sound));

        for broken in [
            Spot { scale: 0.0, ..sound.clone() },
            Spot { axes: (f32::NAN, 0.9), ..sound.clone() },
            Spot { axes: (1.1, 0.0), ..sound.clone() },
            // Every other bound cleared, and still not an ellipse anything measured.
            Spot { axes: (1e-30, 10.0), ..sound.clone() },
            Spot { axes: (2.0, 2.0), ..sound.clone() },
            Spot { turn: (0.9, 0.9), ..sound.clone() },
            Spot { snr: -1.0, ..sound.clone() },
            Spot { profile: [MOST_DIP + 1.0; BINS], ..sound.clone() },
            Spot { profile: [-0.5; BINS], ..sound.clone() },
        ] {
            assert!(Spot::from_words(&broken.words()).is_none(), "{broken:?} reached the kernel");
        }
    }

    /// The sensitivity slider is a cut on stored confidence and nothing else, which is what lets it
    /// move without re-detecting.
    #[test]
    fn sensitivity_spans_the_range_the_populations_overlap_in() {
        let at = |sensitivity| Removal { sensitivity, intensity: 1.0 }.min_snr();
        assert!(at(0.0) > at(1.0), "more sensitive has to mean a lower bar");
        assert!(at(1.0) <= MASK_SNR, "the loosest setting cannot ask for more than was stored");
        // The reference frame's true and false populations overlap between about 3.5 and 4.0, so a
        // slider that could not be put there would not be a control over the thing that matters.
        assert!(at(0.0) > 4.0 && at(1.0) < 3.5);
        // Out of range is clamped rather than extrapolated: a client sending 5 must not ask for a
        // negative bar and take every candidate the mask ever grew.
        assert_eq!(at(5.0), at(1.0));
        assert_eq!(at(-1.0), at(0.0));
    }

    /// Equal steps of the slider are equal *fractions* of confidence, not equal differences.
    ///
    /// **The property, not the formula.** A ratio is what the bar is, so the test asks whether two
    /// steps of the same size scale it by the same factor - which an arithmetic ramp fails and any
    /// spelling of a geometric one passes.
    #[test]
    fn the_sensitivity_steps_in_ratios() {
        let at = |sensitivity| Removal { sensitivity, intensity: 1.0 }.min_snr();
        for step in [0.1, 0.25, 0.4] {
            let low = at(0.2 + step) / at(0.2);
            let high = at(0.5 + step) / at(0.5);
            assert!((low - high).abs() < 1e-5, "a {step} step scales by {low} then {high}");
        }

        // And the decision the slider exists for sits nearer its middle than its end: the band the
        // populations overlap in starts around 60 rather than 73, and the risky tail past it gets
        // more of the travel than an arithmetic ramp left it.
        let reaches =
            |bar: f32| (0..=100).find(|hundredths| at(f64::from(*hundredths) / 100.0) <= bar);
        assert_eq!(reaches(4.0), Some(60), "the overlap's safe edge moved");
        assert_eq!(reaches(3.5), Some(72), "the overlap's risky edge moved");
    }

    /// What a reader gets without touching anything: on, and above the overlap.
    #[test]
    fn the_settings_at_rest_are_the_conservative_ones() {
        let rest = Settings::default();
        assert!(rest.enabled, "the aperture gate is what decides whether a frame pays, not this");
        let removal = rest.removal().expect("at rest, this does something");
        assert_eq!(rest.sensitivity, SENSITIVITY_AT_REST);
        assert!(removal.intensity() == 1.0, "a measured shadow is divided out whole by default");
        // Clear of the 3.5-to-4.0 band the populations overlap in, with room to spare.
        let bar = removal.min_snr();
        assert!(bar > 5.5 && bar < 6.5, "the resting bar is {bar}");
    }
}
