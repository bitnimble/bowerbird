// Geometry from the lensfun database, for the bodies that record none of their own.
//
// What comes out is the same currency as a camera's spline (`lens.rs`): radial
// offsets in SPLINE_UNITs, over a radius normalised to the half-diagonal. The fit
// treats the two interchangeably and only reports which one it used.
//
// Second in the cascade rather than first, which was measured rather than assumed.
// Over 83 Sony frames carrying both, the body's own spline beat lensfun 31 times to
// 4 with 48 ties, by a mean 0.034 deltaE and up to 0.86. The reason is visible in
// the numbers: a spline is recorded per shot, so one FE 40mm prime ranges from
// -0.69% to -3.09% at the corner across a session as focus distance moves it, while
// lensfun has one profile for that lens and answers -2.10% every time. Where a
// lensfun entry is simply wrong the gap is larger still - it has the Tamron 28-75
// at +0.64% where the body says +4.7%, and the body wins by 0.55 deltaE.
//
// The knots are sampled out of a modifier rather than evaluated from the stored
// polynomial, which looks like the long way round and is not. lensfun's
// coefficients are expressed in its own normalised coordinates, that normalisation
// is stated nowhere in the header, it has changed between releases, and the ACM
// model uses a different one again. Sixteen 1x1 calls read the mapping the library
// actually produces, which cannot drift from it.

use crate::image::SPLINE_UNIT;
use crate::raw;
use std::collections::HashMap;
use std::ffi::CString;
use std::sync::{Mutex, OnceLock};

/// Matches what a camera's spline carries, so both reach `image::sample_radius` at
/// the same resolution and neither is resampled to suit the other.
const KNOTS: usize = 16;

/// No RAW gives a subject distance worth trusting and no distortion model takes
/// one, so this is the "at infinity" end of the axis lensfun interpolates
/// vignetting over - the only correction that reads it.
const DISTANCE: f32 = 1000.0;

/// Left at 1.0 because the fit searches the crop itself, exactly as it does for a
/// camera spline. Letting lensfun also scale to fill the frame would apply it twice.
const SCALE: f32 = 1.0;

struct Db(*mut raw::lfDatabase);
// The database is read-only once loaded and every entry point here only searches
// it. Rust cannot see that through a raw pointer, so it is asserted.
#[expect(unsafe_code)]
unsafe impl Send for Db {}
#[expect(unsafe_code)]
unsafe impl Sync for Db {}

/// A database entry and the crop factor of the body it was matched for.
///
/// The pointer is held as an address because it outlives nothing: the database is
/// loaded once and never modified, so an entry is valid for the process.
#[derive(Clone, Copy)]
struct Resolved {
    lens: usize,
    crop: f32,
}

/// The variable naming the directory the database is read from.
pub const DATA: &str = "BOWERBIRD_LENSFUN_DATA";

/// The database, loaded once per process.
///
/// `BOWERBIRD_LENSFUN_DATA` names the directory to read it from, which is how a
/// packaged application carries the XML it was built against - lensfun searches
/// only the prefixes it was compiled for, and on Windows there is no such prefix at
/// all. Unset, it searches them, so a development box needs no configuration.
///
/// None when lensfun is present but its data is not, which is a deployment fault
/// rather than a per-photo one: every caller then behaves as it did before, fitting
/// the geometry instead.
fn db() -> Option<&'static Db> {
    static DB: OnceLock<Loaded> = OnceLock::new();
    match DB.get_or_init(load) {
        Loaded::Ready(db) => Some(db),
        Loaded::Absent => None,
        // Outside the initialiser on purpose. A panic inside one leaves the cell empty and
        // `ffi::guard` catches it, so raising it there would open a database, leak it and
        // panic again for every photograph rather than once.
        Loaded::Refused(why) => panic!("{why}"),
    }
}

enum Loaded {
    Ready(Db),
    Absent,
    Refused(String),
}

/// Opens the database once, owning the handle until it either hands it over or destroys it.
#[expect(unsafe_code)]
fn load() -> Loaded {
    let handle = unsafe { raw::lf_db_new() };
    if handle.is_null() {
        return Loaded::Absent;
    }
    let Some(dir) = std::env::var_os(DATA) else {
        // Non-zero is a load failure, which would leave an empty database behind -
        // answering None for every lens instead of saying why.
        if unsafe { raw::lf_db_load(handle) } != 0 {
            unsafe { raw::lf_db_destroy(handle) };
            return Loaded::Absent;
        }
        return Loaded::Ready(Db(handle));
    };
    let at = dir.to_string_lossy().into_owned();
    let refuse = |why: String| {
        unsafe { raw::lf_db_destroy(handle) };
        Loaded::Refused(why)
    };
    let Ok(path) = CString::new(dir.as_encoded_bytes()) else {
        return refuse(format!("{DATA}={at}: a path with a NUL in it"));
    };
    // Refused rather than answered with Absent, which is the one failure a named directory must
    // not share with an absent lensfun: Absent is a fall-back to fitting the geometry, so a
    // deployment that shipped the library and forgot the data would go on producing plausible
    // pictures and saying nothing.
    //
    // A `cbool`, true where it found data, against `lf_db_load`'s `lfError`, zero where it did.
    // Read as an error code this loads the database and throws it away.
    if unsafe { raw::lf_db_load_directory(handle, path.as_ptr()) } == 0 {
        return refuse(format!(
            "{DATA}={at}: lensfun read no lens data here. It wants the directory of XML files \
             itself - a database's `version_1` - rather than the one above it."
        ));
    }
    Loaded::Ready(Db(handle))
}

/// Lens searches already run, negatives included.
///
/// One entry per lens per focal length and aperture, so a zoom shot across its range
/// fills hundreds rather than one - still nothing beside a library's frame count, and
/// the alternative was answering the wrong lens (see `resolve`). It saves 0.7ms of a ~450ms fit, which is not
/// why it is here - the negative entries are. Without them every photo from an unlisted
/// lens pays the full scored search to be told no again.
fn cache() -> &'static Mutex<HashMap<String, Option<Resolved>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Resolved>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether an entry can be the lens that took this shot.
///
/// lensfun's search scores names and returns everything that scored above zero, so
/// a 16mm prime comes back as a candidate for a 150mm frame. The ranges settle it,
/// and they are the only part of a match that can be checked against the file
/// rather than trusted.
fn covers(min_focal: f32, max_focal: f32, min_aperture: f32, focal: f32, aperture: f32) -> bool {
    // Half a millimetre, because EXIF focal lengths are integers and a 105mm zoom
    // reports 105 at a true 104.6.
    if min_focal > 0.0 && focal < min_focal - 0.5 {
        return false;
    }
    if max_focal > 0.0 && focal > max_focal + 0.5 {
        return false;
    }
    // Only the fast end is checked. A body can stop down past anything an entry
    // records, and most entries leave MaxAperture at zero, but no lens opens wider
    // than it opens.
    if min_aperture > 0.0 && aperture > 0.0 && aperture < min_aperture - 0.05 {
        return false;
    }
    true
}

#[expect(unsafe_code)]
unsafe fn plausible(lens: *const raw::lfLens, focal: f32, aperture: f32) -> bool {
    let lens = &unsafe { *lens };
    covers(lens.MinFocal, lens.MaxFocal, lens.MinAperture, focal, aperture)
}

/// The best entry the database has for this body and lens string.
#[expect(unsafe_code)]
unsafe fn search(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let db = db()?;
    let (c_make, c_model) = (CString::new(make).ok()?, CString::new(model).ok()?);
    let c_lens = CString::new(lens).ok()?;

    let cameras = unsafe { raw::lf_db_find_cameras_ext(db.0, c_make.as_ptr(), c_model.as_ptr(), raw::LF_SEARCH_LOOSE as i32) };
    if cameras.is_null() || unsafe { (*cameras).is_null() } {
        return None;
    }
    let camera = unsafe { *cameras };
    let crop = unsafe { (*camera).CropFactor };

    // A null pattern asks for whatever lens this body has, which is the query a
    // fixed-lens compact needs: it writes no lens name, and the database files its
    // optics under a mount only that body has.
    let pattern = if lens.is_empty() { std::ptr::null() } else { c_lens.as_ptr() };
    let found = unsafe { raw::lf_db_find_lenses_hd(db.0, camera, std::ptr::null(), pattern, raw::LF_SEARCH_LOOSE as i32) };
    unsafe { raw::lf_free(cameras as *mut _) };
    if found.is_null() {
        return None;
    }

    // Already ordered most- to least-likely, so this takes the best entry the file
    // does not contradict rather than re-ranking.
    let mut result = None;
    let mut i = 0;
    while !unsafe { (*found.add(i)).is_null() } {
        let entry = unsafe { *found.add(i) };
        if unsafe { plausible(entry, focal, aperture) } {
            result = Some(Resolved { lens: entry as usize, crop });
            break;
        }
        i += 1;
    }
    unsafe { raw::lf_free(found as *mut _) };
    result
}

/// `search`, memoised on everything it looks at.
///
/// Focal length and aperture belong in the key, not only in the search: `plausible`
/// filters candidates by them, so one string resolves to different entries at different
/// ends of a zoom. Keyed on the string alone, whichever frame of a lens was processed
/// first decided the answer for every other - a 24-70 shot at 24 caches an entry the 70mm
/// frames then read as a contradiction and correct nothing for. Which frame got there
/// first is arrival order, so a library rendered in parallel corrected different photos on
/// different runs.
fn resolve(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let key = format!("{make}|{model}|{lens}|{focal}|{aperture}");
    if let Some(hit) = cache().lock().ok()?.get(&key).copied() {
        return hit;
    }

    #[expect(unsafe_code)]
    let found = unsafe { search(make, model, lens, focal, aperture) };
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key, found);
    }
    found
}

/// How much smaller this body's sensor is than 35mm, which is what turns a focal length in
/// millimetres into one in pixels.
///
/// **A panorama's own question.** The alignment solves a focal from correspondences, and over a
/// narrow field it barely can: a rotation and a translation differ by the perspective across the
/// frame, and a long lens has almost none. The body knows what the pictures cannot say.
///
/// None where lensfun has never heard of the body, and the caller falls back to an assumed field
/// of view.
/// The body alone, unlike every other search here: a crop factor is a property of the sensor, and
/// asking through a lens would answer None for a body whose lens the database has never listed.
pub fn crop_factor(make: &str, model: &str) -> Option<f64> {
    let key = format!("crop|{make}|{model}");
    if let Some(hit) = cropped().lock().ok()?.get(&key).copied() {
        return hit;
    }
    #[expect(unsafe_code)]
    let found = unsafe { body_crop(make, model) };
    if let Ok(mut cache) = cropped().lock() {
        cache.insert(key, found);
    }
    found
}

fn cropped() -> &'static Mutex<HashMap<String, Option<f64>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<f64>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[expect(unsafe_code)]
unsafe fn body_crop(make: &str, model: &str) -> Option<f64> {
    let db = db()?;
    let (c_make, c_model) = (CString::new(make).ok()?, CString::new(model).ok()?);
    let cameras = unsafe {
        raw::lf_db_find_cameras_ext(db.0, c_make.as_ptr(), c_model.as_ptr(), raw::LF_SEARCH_LOOSE as i32)
    };
    if cameras.is_null() || unsafe { (*cameras).is_null() } {
        return None;
    }
    let crop = unsafe { (*(*cameras)).CropFactor };
    unsafe { raw::lf_free(cameras as *mut _) };
    (crop > 0.0).then(|| f64::from(crop))
}

/// A modifier, freed when it leaves scope.
struct Modifier(*mut raw::lfModifier);

impl Drop for Modifier {
    fn drop(&mut self) {
        // SAFETY: built by `lf_modifier_new` in `enabling` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::lf_modifier_destroy(self.0);
        }
    }
}

impl Modifier {
    /// A modifier for this shot with `wanted` in force, or None where the entry carries no
    /// calibration for it.
    ///
    /// The check on what initialising actually enabled is the point: a lens that is named in the
    /// database but not calibrated initialises happily and yields an identity, and the fit would
    /// take that over searching for the real one.
    fn enabling(
        entry: *const raw::lfLens,
        crop: f32,
        long: i32,
        short: i32,
        focal: f32,
        aperture: f32,
        wanted: i32,
    ) -> Option<Modifier> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::lf_modifier_new(entry, crop, long, short) };
        if handle.is_null() {
            return None;
        }
        // Owned before anything else can fail, so every path below frees it.
        let modifier = Modifier(handle);
        #[expect(unsafe_code)]
        let applied = unsafe {
            raw::lf_modifier_initialize(
                handle,
                entry,
                raw::lfPixelFormat_LF_PF_U8,
                focal,
                aperture,
                DISTANCE,
                SCALE,
                raw::lfLensType_LF_RECTILINEAR,
                wanted,
                // Forward: undo the lens rather than simulate it.
                0,
            )
        };
        (applied & wanted != 0).then_some(modifier)
    }

    /// Where one point lands once the distortion is undone.
    fn geometry_at(&self, x: f32, y: f32) -> Option<[f32; 2]> {
        let mut mapped = [0.0f32; 2];
        #[expect(unsafe_code)]
        let ok = unsafe {
            raw::lf_modifier_apply_geometry_distortion(self.0, x, y, 1, 1, mapped.as_mut_ptr())
        };
        (ok != 0).then_some(mapped)
    }

    /// The same per channel: x and y for red, green and blue in turn.
    fn subpixel_at(&self, x: f32, y: f32) -> Option<[f32; 6]> {
        let mut mapped = [0.0f32; 6];
        #[expect(unsafe_code)]
        let ok = unsafe {
            raw::lf_modifier_apply_subpixel_distortion(self.0, x, y, 1, 1, mapped.as_mut_ptr())
        };
        (ok != 0).then_some(mapped)
    }
}

/// Whether the database holds a lateral aberration for this entry at all.
#[expect(unsafe_code)]
unsafe fn has_tca(entry: *const raw::lfLens) -> bool {
    unsafe { !(*entry).CalibTCA.is_null() && !(*(*entry).CalibTCA).is_null() }
}

/// The radial correction for one shot, in SPLINE_UNITs.
///
/// None when no plausible lens matches, or when the match carries no distortion
/// calibration at this focal length - in either case the caller fits instead.
pub fn knots(
    make: &str,
    model: &str,
    lens: &str,
    focal: f32,
    aperture: f32,
    width: usize,
    height: usize,
) -> Option<Vec<f64>> {
    let resolved = resolve(make, model, lens, focal, aperture)?;
    let entry = resolved.lens as *const raw::lfLens;
    // Landscape, always. The model is radial and it is read along the diagonal, so
    // the orientation of the frame cannot change the answer - but the aspect ratio
    // can, and passing it one way keeps it out.
    let (long, short) = (width.max(height) as i32, width.min(height) as i32);

    let modifier = Modifier::enabling(
        entry,
        resolved.crop,
        long,
        short,
        focal,
        aperture,
        raw::LF_MODIFY_DISTORTION as i32,
    )?;

    let (cx, cy) = (long as f32 / 2.0, short as f32 / 2.0);
    let half = (cx * cx + cy * cy).sqrt();
    let (ux, uy) = (cx / half, cy / half);

    let mut out = Vec::with_capacity(KNOTS);
    for i in 0..KNOTS {
        let r = i as f32 / (KNOTS - 1) as f32;
        let mapped = modifier.geometry_at(cx + ux * r * half, cy + uy * r * half)?;
        let source = ((mapped[0] - cx).powi(2) + (mapped[1] - cy).powi(2)).sqrt() / half;
        // The spline is anchored at zero in the centre, where there is no radius
        // to take a ratio against.
        out.push(if i == 0 { 0.0 } else { (source as f64 / r as f64 - 1.0) * SPLINE_UNIT });
    }
    Some(out)
}

/// The lateral aberration the database has for this shot, as red and blue's radial
/// corrections against green in `SPLINE_UNIT`s.
///
/// Sampled out of a modifier for the same reason the distortion is: lensfun's `LINEAR`
/// and `POLY3` TCA models are expressed in its own normalised coordinates, and reading
/// the mapping the library actually produces cannot drift from it. Sixteen 1x1 calls
/// per channel, on the same grid the distortion uses, so the two compose knot for knot.
///
/// None when nothing plausible matches or the entry carries no TCA calibration - which
/// is most of them, since lensfun's TCA coverage is far thinner than its distortion
/// coverage. The caller falls back to measuring it off the frame.
pub fn tca_knots(
    make: &str,
    model: &str,
    lens: &str,
    focal: f32,
    aperture: f32,
    width: usize,
    height: usize,
) -> Option<[Vec<f64>; 2]> {
    let resolved = resolve(make, model, lens, focal, aperture)?;
    let entry = resolved.lens as *const raw::lfLens;
    let (long, short) = (width.max(height) as i32, width.min(height) as i32);

    // Asked before the modifier is built: an entry with no TCA calibration would
    // otherwise initialise happily and hand back an identity, which the fit would
    // then take over measuring the real one.
    #[expect(unsafe_code)]
    let calibrated = unsafe { has_tca(entry) };
    if !calibrated {
        return None;
    }
    let modifier = Modifier::enabling(
        entry,
        resolved.crop,
        long,
        short,
        focal,
        aperture,
        raw::LF_MODIFY_TCA as i32,
    )?;

    let (cx, cy) = (long as f32 / 2.0, short as f32 / 2.0);
    let half = (cx * cx + cy * cy).sqrt();
    let (ux, uy) = (cx / half, cy / half);

    let mut red = Vec::with_capacity(KNOTS);
    let mut blue = Vec::with_capacity(KNOTS);
    for i in 0..KNOTS {
        let r = i as f32 / (KNOTS - 1) as f32;
        let mapped = modifier.subpixel_at(cx + ux * r * half, cy + uy * r * half)?;
        let reach = |pair: usize| {
            let (x, y) = (mapped[pair * 2], mapped[pair * 2 + 1]);
            (((x - cx).powi(2) + (y - cy).powi(2)).sqrt() / half) as f64
        };
        // Against green rather than against the undistorted radius, so what comes
        // out is the aberration alone and composes with whatever the distortion
        // tier separately decided.
        let (green, at) = (reach(1), r as f64);
        for (channel, out) in [(0usize, &mut red), (2usize, &mut blue)] {
            let value = match at > 0.0 && green > 0.0 {
                true => (reach(channel) / green - 1.0) * SPLINE_UNIT,
                // At the centre there is no radius to take a ratio against, so the
                // nearest knot that has one stands in - a lateral scale is flat
                // there rather than zero.
                false => 0.0,
            };
            out.push(value);
        }
    }
    // The centre knot is the one radius that could not be measured; the next one
    // out is the closest thing to it.
    red[0] = red[1];
    blue[0] = blue[1];
    Some([red, blue])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zoom_covers_its_range_and_nothing_past_it() {
        assert!(covers(24.0, 105.0, 4.0, 24.0, 4.0));
        assert!(covers(24.0, 105.0, 4.0, 105.0, 11.0));
        assert!(!covers(24.0, 105.0, 4.0, 16.0, 2.8));
        assert!(!covers(24.0, 105.0, 4.0, 200.0, 5.6));
    }

    #[test]
    fn a_rounded_focal_length_still_lands_inside_its_own_zoom() {
        // The reason for the tolerance: a body reports the marked focal length, and
        // a 17-70 at its long end has been seen to write 70 against a MaxFocal the
        // database rounds the other way.
        assert!(covers(17.0, 70.0, 2.8, 70.4, 2.8));
        assert!(covers(17.0, 70.0, 2.8, 16.6, 2.8));
    }

    #[test]
    fn a_lens_cannot_open_wider_than_it_opens_but_may_stop_down_freely() {
        assert!(!covers(50.0, 50.0, 1.8, 50.0, 1.4));
        assert!(covers(50.0, 50.0, 1.8, 50.0, 22.0));
    }

    #[test]
    fn an_unrecorded_range_constrains_nothing() {
        // Most entries leave MaxAperture at zero, and a compact records no aperture
        // at all; neither is a reason to reject the only profile there is.
        assert!(covers(0.0, 0.0, 0.0, 35.0, 0.0));
        assert!(covers(24.0, 105.0, 0.0, 50.0, 0.0));
    }
}
