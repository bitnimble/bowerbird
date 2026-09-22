// Geometry from the lensfun database, for the bodies that record none of their own.
//
// What comes out is a radial offset as a fraction of the radius, over a radius normalised
// to the half-diagonal. `rawshim` scales that into the SPLINE_UNITs a camera's own spline
// is carried in and treats the two interchangeably, reporting only which one it used.
//
// Second in that cascade rather than first, which was measured rather than assumed. Over 83
// Sony frames carrying both, the body's own spline beat lensfun 31 times to 4 with 48 ties,
// by a mean 0.034 deltaE and up to 0.86. The reason is visible in the numbers: a spline is
// recorded per shot, so one FE 40mm prime ranges from -0.69% to -3.09% at the corner across a
// session as focus distance moves it, while lensfun has one profile for that lens and answers
// -2.10% every time. Where a lensfun entry is simply wrong the gap is larger still - it has
// the Tamron 28-75 at +0.64% where the body says +4.7%, and the body wins by 0.55 deltaE.
//
// The knots are sampled out of a modifier rather than evaluated from the stored polynomial,
// which looks like the long way round and is not. lensfun's coefficients are expressed in its
// own normalised coordinates, that normalisation is stated nowhere it can be read off, it has
// changed between releases, and the ACM model uses a different one again. Sixteen 1x1 calls
// read the mapping the library actually produces, which cannot drift from it.

use lensfun::{Camera, Database, FuzzyStrCmp, Lens, Modifier};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};

/// Matches what a camera's spline carries, so both reach `image::sample_radius` at the same
/// resolution and neither is resampled to suit the other.
const KNOTS: usize = 16;

/// Simulate the lens rather than correct an already-corrected frame, which is the direction
/// that answers "where did this photosite's light come from".
const REVERSE: bool = false;

/// The variable naming a directory to read the database from instead of the bundled copy.
///
/// Nothing needs it: the database travels inside the binary. It exists because lensfun's data
/// gains lenses continuously and the bundled copy is frozen at whichever release the crate was
/// cut from, so a reader whose lens landed since can point at a fresher one.
pub const DATA: &str = "BOWERBIRD_LENSFUN_DATA";

/// A database entry and the crop factor of the body it was matched for.
#[derive(Clone, Copy)]
struct Resolved {
    lens: &'static Lens,
    crop: f32,
}

/// The database, loaded once per process.
fn db() -> &'static Database {
    static DB: OnceLock<Loaded> = OnceLock::new();
    match DB.get_or_init(load) {
        Loaded::Ready(db) => db,
        // Outside the initialiser on purpose. A panic inside one leaves the cell empty and
        // `ffi::guard` catches it, so raising it there would parse a database, throw it away
        // and panic again for every photograph rather than once.
        Loaded::Refused(why) => panic!("{why}"),
    }
}

enum Loaded {
    Ready(Database),
    Refused(String),
}

fn load() -> Loaded {
    let Some(dir) = std::env::var_os(DATA) else {
        return match Database::load_bundled() {
            Ok(db) => Loaded::Ready(guessing(db)),
            Err(why) => Loaded::Refused(format!("the bundled lens database did not parse: {why}")),
        };
    };
    let at = dir.to_string_lossy().into_owned();
    // Refused rather than fallen back to the bundled copy, which is the one failure a named
    // directory must not hide: the reader named it because they wanted its answers, and a silent
    // fall-back produces plausible pictures from the database they were replacing.
    let refuse = |why: String| {
        Loaded::Refused(format!(
            "{DATA}={at}: no lens database could be read here. It wants the directory of XML \
             files itself - a database's `version_2` - rather than the one above it, and the \
             parser is stricter than the C library's: a database old enough to file a \
             `<real-focal-length>` element is refused rather than read around. ({why})"
        ))
    };
    match Database::load_dir(&dir) {
        Err(why) => refuse(why.to_string()),
        // **A directory with no XML in it is the failure above, not an empty database.**
        // `load_dir` globs `*.xml` and loops, so a directory holding none of them - the level
        // above a `version_2`, which is exactly the mistake the message describes - returns an
        // empty database and no error. Answering None for every photograph afterwards is
        // indistinguishable from a lens nothing matches, which is the silence this refuses.
        Ok(db) if db.lenses.is_empty() => refuse("it holds no lenses".to_owned()),
        Ok(db) => Loaded::Ready(guessing(db)),
    }
}

/// Reads each entry's focal and aperture ranges out of its own name, which the C library does as
/// it parses and this port does not.
///
/// **Load-bearing, and silently so.** Sixty of the database's 1300 lenses state a range in the
/// XML; every other one has it inferred from a model string like "70-200mm f/2.8". Left
/// unguessed, `covers` sees zeroes and rejects nothing, so the 70-200 this body happens to own
/// answers for a 24mm frame and the render is warped by a curve from the wrong lens - and
/// `match_score`'s own range gates go neutral at the same time, so the ranking that picked the
/// entry was worse as well.
fn guessing(mut db: Database) -> Database {
    for lens in &mut db.lenses {
        lens.guess_parameters();
    }
    db
}

/// Lens searches already run, negatives included.
///
/// One entry per lens per focal length and aperture, so a zoom shot across its range fills
/// hundreds rather than one - still nothing beside a library's frame count, and the alternative
/// was answering the wrong lens (see `resolve`). The negative entries are why it is here:
/// without them every photo from an unlisted lens pays the full scored search to be told no
/// again.
fn cache() -> &'static Mutex<HashMap<String, Option<Resolved>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Resolved>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether an entry can be the lens that took this shot.
///
/// lensfun's search scores names and returns everything that scored above zero, so a 16mm prime
/// comes back as a candidate for a 150mm frame. The ranges settle it, and they are the only part
/// of a match that can be checked against the file rather than trusted.
fn covers(min_focal: f32, max_focal: f32, min_aperture: f32, focal: f32, aperture: f32) -> bool {
    // Half a millimetre, because EXIF focal lengths are integers and a 105mm zoom reports 105
    // at a true 104.6.
    if min_focal > 0.0 && focal < min_focal - 0.5 {
        return false;
    }
    if max_focal > 0.0 && focal > max_focal + 0.5 {
        return false;
    }
    // Only the fast end is checked. A body can stop down past anything an entry records, and
    // most entries leave the slow end at zero, but no lens opens wider than it opens.
    if min_aperture > 0.0 && aperture > 0.0 && aperture < min_aperture - 0.05 {
        return false;
    }
    true
}

/// The best entry the database has for this body and lens string.
fn search(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let camera = body(make, model)?;
    // Ordered most- to least-likely, so this takes the best entry the file does not contradict
    // rather than re-ranking.
    lenses(camera, lens)
        .into_iter()
        .find(|entry| covers(entry.focal_min, entry.focal_max, entry.aperture_min, focal, aperture))
        .map(|lens| Resolved { lens, crop: camera.crop_factor })
}

fn body(make: &str, model: &str) -> Option<&'static Camera> {
    cameras(make, model).into_iter().next()
}

/// Every body whose maker and model both score, best first.
///
/// Ours rather than `Database::find_cameras` for the two reasons `lenses` is, below.
fn cameras(make: &str, model: &str) -> Vec<&'static Camera> {
    let maker = (!make.is_empty()).then(|| FuzzyStrCmp::new(make, REQUIRE_EVERY_WORD));
    let model = (!model.is_empty()).then(|| FuzzyStrCmp::new(model, REQUIRE_EVERY_WORD));
    let mut scored: Vec<(i32, &'static Camera)> = Vec::new();
    for camera in &db().cameras {
        let mut score = 0;
        for (against, default, localized) in [
            (&maker, &camera.maker, &camera.maker_localized),
            (&model, &camera.model, &camera.model_localized),
        ] {
            let Some(against) = against else { continue };
            match best_name(against, default, localized) {
                0 => {
                    score = 0;
                    break;
                }
                it => score += it,
            }
        }
        if score > 0 {
            scored.push((score, camera));
        }
    }
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().map(|(_, camera)| camera).collect()
}

/// Every entry that could be this lens on this body, best first.
///
/// An empty pattern asks for whatever lens this body has, which is the query a fixed-lens compact
/// needs: it writes no lens name, and the database files its optics under a mount only that body
/// has.
///
/// **Ours rather than `Database::find_lenses`, which is the same search missing two things the C
/// library does.** It scores an entry's default name alone, where 1618 of the database's names
/// are filed under `<model lang="en">` - a Tamron reading "E 17-70mm F2.8 B070" by default and
/// "Tamron 17-70mm F/2.8 Di III-A VC RXD" in English, which is the string the body writes. And it
/// requires every word of the query to appear in the entry, where we ask for the looser search a
/// camera's punctuation needs: "F2.8" against a database that writes "F/2.8" is a word the entry
/// does not have.
fn lenses(camera: &Camera, model: &str) -> Vec<&'static Lens> {
    let mut pattern = Lens { model: model.to_owned(), ..Lens::default() };
    pattern.guess_parameters();
    let fuzzy = FuzzyStrCmp::new(&pattern.model, REQUIRE_EVERY_WORD);

    let compatible: Vec<&str> = db()
        .mounts
        .iter()
        .find(|it| it.name == camera.mount)
        .map(|it| it.compat.iter().map(String::as_str).collect())
        .unwrap_or_default();

    let mut scored: Vec<(i32, &'static Lens)> = db()
        .lenses
        .iter()
        .map(|entry| (match_score(&pattern, entry, camera, &fuzzy, &compatible), entry))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().map(|(_, lens)| lens).collect()
}

/// False, which selects the looser of lensfun's two matchers (`LF_SEARCH_LOOSE`): an entry
/// missing one of the query's words is kept and scored rather than discarded.
const REQUIRE_EVERY_WORD: bool = false;

/// The best score over an entry's default name and every localised one, which is what
/// `lfFuzzyStrCmp::Compare (lfMLstr)` does.
fn best_name(fuzzy: &FuzzyStrCmp, default: &str, localized: &BTreeMap<String, String>) -> i32 {
    std::iter::once(default)
        .chain(localized.values().map(String::as_str))
        .map(|name| fuzzy.compare(name))
        .max()
        .unwrap_or(0)
}

/// How well `entry` satisfies the query, or zero where it cannot be the lens at all.
///
/// A port of `lfDatabase::MatchScore`, which is not reachable through the crate's API.
fn match_score(
    pattern: &Lens,
    entry: &Lens,
    camera: &Camera,
    fuzzy: &FuzzyStrCmp,
    compatible: &[&str],
) -> i32 {
    let mut score = 0;

    if entry.crop_factor > 0.0 {
        match crop_bucket(camera.crop_factor, entry.crop_factor) {
            0 => return 0,
            bucket => score += bucket,
        }
    }

    for (asked, has) in [
        (pattern.focal_min, entry.focal_min),
        (pattern.focal_max, entry.focal_max),
        (pattern.aperture_min, entry.aperture_min),
        (pattern.aperture_max, entry.aperture_max),
    ] {
        match compare_num(asked, has) {
            -1 => return 0,
            1 => score += 10,
            _ => {}
        }
    }

    if !entry.mounts.is_empty() {
        let fits = entry.mounts.iter().any(|it| it.eq_ignore_ascii_case(&camera.mount));
        let adapts =
            || compatible.iter().any(|c| entry.mounts.iter().any(|it| it.eq_ignore_ascii_case(c)));
        match (fits, adapts()) {
            (true, _) => score += 10,
            (false, true) => score += 9,
            (false, false) => return 0,
        }
    }

    let named = !entry.model.is_empty() || !entry.model_localized.is_empty();
    if !pattern.model.is_empty() && named {
        match best_name(fuzzy, &entry.model, &entry.model_localized) {
            0 => return 0,
            it => score += (it * 4 / 10).max(1),
        }
    }

    score
}

/// How well a profile's sensor format suits the body's, or zero where it cannot serve it at all.
///
/// A profile measured on a smaller sensor than this body's says nothing about the corners the
/// body sees and the measurement never reached, so it is refused rather than ranked. The rest
/// rank by how far inside the calibrated image circle the body sits.
fn crop_bucket(camera: f32, calibrated: f32) -> i32 {
    match camera {
        it if it > 0.01 && it < calibrated * 0.96 => 0,
        it if it >= calibrated * 1.41 => 2,
        it if it >= calibrated * 1.31 => 4,
        it if it >= calibrated * 1.21 => 6,
        it if it >= calibrated * 1.11 => 8,
        it if it >= calibrated * 1.01 => 10,
        it if it >= calibrated => 5,
        it if it >= calibrated * 0.96 => 3,
        _ => 0,
    }
}

/// Whether two of an entry's numbers agree, where zero on either side means the database or the
/// query declined to say and the comparison is skipped.
fn compare_num(asked: f32, has: f32) -> i32 {
    if asked == 0.0 || has == 0.0 {
        return 0;
    }
    let ratio = asked / has;
    match ratio > 0.99 && ratio < 1.01 {
        true => 1,
        false => -1,
    }
}

/// `search`, memoised on everything it looks at.
///
/// Focal length and aperture belong in the key, not only in the search: `covers` filters
/// candidates by them, so one string resolves to different entries at different ends of a zoom.
/// Keyed on the string alone, whichever frame of a lens was processed first decided the answer
/// for every other - a 24-70 shot at 24 caches an entry the 70mm frames then read as a
/// contradiction and correct nothing for. Which frame got there first is arrival order, so a
/// library rendered in parallel corrected different photos on different runs.
fn resolve(make: &str, model: &str, lens: &str, focal: f32, aperture: f32) -> Option<Resolved> {
    let key = format!("{make}|{model}|{lens}|{focal}|{aperture}");
    if let Some(hit) = cache().lock().ok()?.get(&key).copied() {
        return hit;
    }
    let found = search(make, model, lens, focal, aperture);
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
/// The body alone, unlike every other search here: a crop factor is a property of the sensor,
/// and asking through a lens would answer None for a body whose lens the database has never
/// listed. None where lensfun has never heard of the body, and the caller falls back to an
/// assumed field of view.
pub fn crop_factor(make: &str, model: &str) -> Option<f64> {
    let key = format!("{make}|{model}");
    if let Some(hit) = cropped().lock().ok()?.get(&key).copied() {
        return hit;
    }
    let found = body(make, model).map(|it| it.crop_factor).filter(|it| *it > 0.0).map(f64::from);
    if let Ok(mut cache) = cropped().lock() {
        cache.insert(key, found);
    }
    found
}

fn cropped() -> &'static Mutex<HashMap<String, Option<f64>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<f64>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The grid every reading here is taken on: `KNOTS` radii out to the half-diagonal, and the
/// unit vector along it.
struct Diagonal {
    centre: (f32, f32),
    half: f32,
    along: (f32, f32),
}

impl Diagonal {
    /// Landscape, always. The model is radial and it is read along the diagonal, so the
    /// orientation of the frame cannot change the answer - but the aspect ratio can, and
    /// passing it one way keeps it out.
    fn of(width: usize, height: usize) -> (Diagonal, u32, u32) {
        let (long, short) = (width.max(height) as u32, width.min(height) as u32);
        let (cx, cy) = (long as f32 / 2.0, short as f32 / 2.0);
        let half = (cx * cx + cy * cy).sqrt();
        (Diagonal { centre: (cx, cy), half, along: (cx / half, cy / half) }, long, short)
    }

    fn at(&self, r: f32) -> (f32, f32) {
        (self.centre.0 + self.along.0 * r * self.half, self.centre.1 + self.along.1 * r * self.half)
    }

    /// How far a point that landed at `mapped` sits from the centre, as a fraction of the
    /// half-diagonal.
    fn reach(&self, mapped: (f32, f32)) -> f64 {
        let (dx, dy) = (mapped.0 - self.centre.0, mapped.1 - self.centre.1);
        ((dx * dx + dy * dy).sqrt() / self.half) as f64
    }
}

/// A modifier for this shot with the correction `enable` asks for in force, or None where the
/// entry carries no calibration for it.
///
/// The check on what `enable` returned is the point: a lens that is named in the database but
/// not calibrated builds a modifier happily and yields an identity, and the fit would take that
/// over searching for the real one.
fn enabling(
    resolved: &Resolved,
    focal: f32,
    long: u32,
    short: u32,
    enable: impl Fn(&mut Modifier, &Lens) -> bool,
) -> Option<Modifier> {
    let mut modifier = Modifier::new(resolved.lens, focal, resolved.crop, long, short, REVERSE);
    enable(&mut modifier, resolved.lens).then_some(modifier)
}

/// The radial correction for one shot, as a fraction of the radius at each of `KNOTS` radii.
///
/// None when no plausible lens matches, or when the match carries no distortion calibration at
/// this focal length - in either case the caller fits instead.
pub fn distortion_knots(
    make: &str,
    model: &str,
    lens: &str,
    focal: f32,
    aperture: f32,
    width: usize,
    height: usize,
) -> Option<Vec<f64>> {
    let resolved = resolve(make, model, lens, focal, aperture)?;
    let (diagonal, long, short) = Diagonal::of(width, height);
    let modifier = enabling(&resolved, focal, long, short, Modifier::enable_distortion_correction)?;

    let mut out = Vec::with_capacity(KNOTS);
    for i in 0..KNOTS {
        let r = i as f32 / (KNOTS - 1) as f32;
        let (x, y) = diagonal.at(r);
        let mut mapped = [0.0f32; 2];
        if !modifier.apply_geometry_distortion(x, y, 1, 1, &mut mapped) {
            return None;
        }
        let source = diagonal.reach((mapped[0], mapped[1]));
        // The spline is anchored at zero in the centre, where there is no radius to take a
        // ratio against.
        out.push(if i == 0 { 0.0 } else { source / r as f64 - 1.0 });
    }
    Some(out)
}

/// The lateral aberration the database has for this shot, as red and blue's radial corrections
/// against green, each a fraction of green's radius.
///
/// Sampled out of a modifier for the same reason the distortion is, on the same grid, so the two
/// compose knot for knot.
///
/// None when nothing plausible matches or the entry carries no TCA calibration - which is most
/// of them, since lensfun's TCA coverage is far thinner than its distortion coverage. The caller
/// falls back to measuring it off the frame.
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
    let (diagonal, long, short) = Diagonal::of(width, height);
    let modifier = enabling(&resolved, focal, long, short, Modifier::enable_tca_correction)?;

    let mut red = Vec::with_capacity(KNOTS);
    let mut blue = Vec::with_capacity(KNOTS);
    for i in 0..KNOTS {
        let r = i as f32 / (KNOTS - 1) as f32;
        let (x, y) = diagonal.at(r);
        let mut mapped = [0.0f32; 6];
        if !modifier.apply_subpixel_distortion(x, y, 1, 1, &mut mapped) {
            return None;
        }
        let reach = |channel: usize| diagonal.reach((mapped[channel * 2], mapped[channel * 2 + 1]));
        // Against green rather than against the undistorted radius, so what comes out is the
        // aberration alone and composes with whatever the distortion tier separately decided.
        let (green, at) = (reach(1), r as f64);
        for (channel, out) in [(0usize, &mut red), (2usize, &mut blue)] {
            out.push(match at > 0.0 && green > 0.0 {
                true => reach(channel) / green - 1.0,
                false => 0.0,
            });
        }
    }
    // The centre knot is the one radius that could not be measured; the next one out is the
    // closest thing to it, a lateral scale being flat there rather than zero.
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
        // The reason for the tolerance: a body reports the marked focal length, and a 17-70 at
        // its long end has been seen to write 70 against a MaxFocal the database rounds the
        // other way.
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
        // Most entries leave the slow end at zero, and a compact records no aperture at all;
        // neither is a reason to reject the only profile there is.
        assert!(covers(0.0, 0.0, 0.0, 35.0, 0.0));
        assert!(covers(24.0, 105.0, 0.0, 50.0, 0.0));
    }

    #[test]
    fn a_profile_calibrated_on_a_smaller_sensor_than_the_body_is_refused() {
        // A full-frame body against an APS-C profile: the measurement stops well inside the
        // corners this body reads, so there is nothing to extrapolate from.
        assert_eq!(crop_bucket(1.0, 1.53), 0);
    }

    #[test]
    fn a_body_further_inside_the_image_circle_scores_lower() {
        // A full-frame profile is worth most to the body it was measured on and less to each
        // smaller sensor, which reads only the middle of it.
        assert_eq!(crop_bucket(1.0, 1.0), 5);
        assert_eq!(crop_bucket(1.05, 1.0), 10);
        assert_eq!(crop_bucket(1.15, 1.0), 8);
        assert_eq!(crop_bucket(1.25, 1.0), 6);
        assert_eq!(crop_bucket(1.35, 1.0), 4);
        assert_eq!(crop_bucket(1.6, 1.0), 2);
        // Within the 4% the formats are treated as the same one.
        assert_eq!(crop_bucket(0.97, 1.0), 3);
    }
}
