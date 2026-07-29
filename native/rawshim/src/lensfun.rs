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
unsafe impl Send for Db {}
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

/// The database, loaded once per process from the system directories.
///
/// None when lensfun is present but its data is not, which is a deployment fault
/// rather than a per-photo one: every caller then behaves as it did before, fitting
/// the geometry instead.
fn db() -> Option<&'static Db> {
    static DB: OnceLock<Option<Db>> = OnceLock::new();
    DB.get_or_init(|| unsafe {
        let handle = raw::lf_db_new();
        if handle.is_null() {
            return None;
        }
        // Non-zero is a load failure, which would leave an empty database behind -
        // answering None for every lens instead of saying why.
        if raw::lf_db_load(handle) != 0 {
            raw::lf_db_destroy(handle);
            return None;
        }
        Some(Db(handle))
    })
    .as_ref()
}

/// Lens strings already resolved, negatives included.
///
/// A body writes one string per lens and a library holds a handful of lenses, so
/// this converges after the first photo of each. It saves 0.7ms of a ~450ms fit,
/// which is not why it is here - the negative entries are. Without them every photo
/// from an unlisted lens pays the full scored search to be told no again.
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

unsafe fn plausible(lens: *const raw::lfLens, focal: f32, aperture: f32) -> bool {
    let lens = &*lens;
    covers(lens.MinFocal, lens.MaxFocal, lens.MinAperture, focal, aperture)
}

/// The best entry the database has for this body and lens string.
unsafe fn search(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let db = db()?;
    let (c_make, c_model) = (CString::new(make).ok()?, CString::new(model).ok()?);
    let c_lens = CString::new(lens).ok()?;

    let cameras = raw::lf_db_find_cameras_ext(db.0, c_make.as_ptr(), c_model.as_ptr(), raw::LF_SEARCH_LOOSE as i32);
    if cameras.is_null() || (*cameras).is_null() {
        return None;
    }
    let camera = *cameras;
    let crop = (*camera).CropFactor;

    // A null pattern asks for whatever lens this body has, which is the query a
    // fixed-lens compact needs: it writes no lens name, and the database files its
    // optics under a mount only that body has.
    let pattern = if lens.is_empty() { std::ptr::null() } else { c_lens.as_ptr() };
    let found = raw::lf_db_find_lenses_hd(db.0, camera, std::ptr::null(), pattern, raw::LF_SEARCH_LOOSE as i32);
    raw::lf_free(cameras as *mut _);
    if found.is_null() {
        return None;
    }

    // Already ordered most- to least-likely, so this takes the best entry the file
    // does not contradict rather than re-ranking.
    let mut result = None;
    let mut i = 0;
    while !(*found.add(i)).is_null() {
        let entry = *found.add(i);
        if plausible(entry, focal, aperture) {
            result = Some(Resolved { lens: entry as usize, crop });
            break;
        }
        i += 1;
    }
    raw::lf_free(found as *mut _);
    result
}

/// `search`, memoised on the strings the RAW carries.
///
/// The cached entry is re-checked against this shot rather than trusted: one string
/// resolves to one zoom, and a zoom is only plausible over part of its range.
fn resolve(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let key = format!("{make}|{model}|{lens}");
    if let Some(hit) = cache().lock().ok()?.get(&key).copied() {
        return match hit {
            Some(entry) if unsafe { plausible(entry.lens as *const raw::lfLens, focal, aperture) } => Some(entry),
            // A hit that this frame contradicts is not a miss to re-search: the same
            // string resolved to the same entry last time, and re-running the search
            // would only return it again.
            _ => None,
        };
    }

    let found = unsafe { search(make, model, lens, focal, aperture) };
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key, found);
    }
    found
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

    unsafe {
        let modifier = raw::lf_modifier_new(entry, resolved.crop, long, short);
        if modifier.is_null() {
            return None;
        }
        let applied = raw::lf_modifier_initialize(
            modifier,
            entry,
            raw::lfPixelFormat_LF_PF_U8,
            focal,
            aperture,
            DISTANCE,
            SCALE,
            raw::lfLensType_LF_RECTILINEAR,
            raw::LF_MODIFY_DISTORTION as i32,
            // Forward: undo the lens rather than simulate it.
            0,
        );
        // What it could actually enable. Without this check a lens that is named in
        // the database but not calibrated yields an identity spline, and the fit
        // would take that over searching for the real one.
        if applied & raw::LF_MODIFY_DISTORTION as i32 == 0 {
            raw::lf_modifier_destroy(modifier);
            return None;
        }

        let (cx, cy) = (long as f32 / 2.0, short as f32 / 2.0);
        let half = (cx * cx + cy * cy).sqrt();
        let (ux, uy) = (cx / half, cy / half);

        let mut out = Vec::with_capacity(KNOTS);
        for i in 0..KNOTS {
            let r = i as f32 / (KNOTS - 1) as f32;
            let mut mapped = [0.0f32; 2];
            if raw::lf_modifier_apply_geometry_distortion(
                modifier,
                cx + ux * r * half,
                cy + uy * r * half,
                1,
                1,
                mapped.as_mut_ptr(),
            ) == 0
            {
                raw::lf_modifier_destroy(modifier);
                return None;
            }
            let source = ((mapped[0] - cx).powi(2) + (mapped[1] - cy).powi(2)).sqrt() / half;
            // The spline is anchored at zero in the centre, where there is no radius
            // to take a ratio against.
            out.push(if i == 0 { 0.0 } else { (source as f64 / r as f64 - 1.0) * SPLINE_UNIT });
        }
        raw::lf_modifier_destroy(modifier);
        Some(out)
    }
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
