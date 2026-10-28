//! What a file says about its lens geometry, tier by tier: the correction the body recorded for the
//! shot, then the lens database's profile for the lens it names.

/// How much of a RAW the spline parser is given before it is given all of it.
///
/// Not "the first few kilobytes", which is what this was assumed to be until it was
/// measured: over 1000 files sampled across the whole catalogue, a 128KB window
/// missed the spline on 971 of them and 256KB missed none. The tag is early, its
/// data is not - it lands past the previews IFD0 points at. So this is double what
/// was needed, and still two orders of magnitude below a whole frame.
const SPLINE_WINDOW: u64 = 512 * 1024;

/// The spline the body recorded for this shot, or None where it recorded none.
///
/// `geometry_for` reads this itself; this exists so the fixture test can hold the
/// parser against a real ARW, which `lens.rs`'s synthetic TIFFs cannot do.
#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_distortion_spline(path: &str) -> Option<Vec<f64>> {
    distortion_of(path).ok()?.spline
}

/// The spline, from as little of the file as will yield it.
///
/// Reading it whole was a page-cache hit in `bb_fit` - the decode had just pulled
/// the same file through - but it still allocated and copied 25-60MB per photo.
///
/// The whole file is still read when the window comes back empty, and that is
/// load-bearing rather than belt-and-braces: TIFF offsets are absolute, and the
/// parser answers a pointer past the end of its buffer with `None`, which is the
/// same answer as a body that recorded nothing. A window one byte too small would
/// not fail, it would silently drop the frame onto the fitted fallback - slower and
/// a worse grade, with nothing to say so.
///
/// `Err` is a file that could not be read, which the callers report separately from
/// a file that simply records no correction.
fn distortion_of(path: &str) -> std::io::Result<decode::lens::Distortion> {
    use std::io::Read;

    let mut window = SPLINE_WINDOW;
    loop {
        let mut head = Vec::new();
        std::fs::File::open(path)?
            .take(window)
            .read_to_end(&mut head)?;
        let found = decode::lens::read_distortion(&head);
        if found.spline.is_some() {
            return Ok(found);
        }
        // A short read means that was the whole file, so there is nothing further on.
        if (head.len() as u64) < window {
            return Ok(found);
        }
        // The one reason a larger buffer could answer differently is a pointer this walk could
        // not follow, and `needed` is the furthest of those - so no pointer left the window
        // means the file records no spline, whatever its size. That is every CR2, and every
        // CR3, whose byte order mark fails at offset 0 and reaches past nothing at all.
        let Some(reach) = found.needed.filter(|reach| *reach as u64 > window) else {
            return Ok(found);
        };
        // Never less than double, so a file naming its next pointer a page further on each
        // time costs a handful of reads rather than one per page.
        window = (reach as u64).max(window * 2);
    }
}

/// Which geometry tier this file falls into, from the file alone - no pixels decoded.
///
/// None is a file that could not be read, which the callers report separately from a
/// file that simply records no correction.
pub fn geometry_for(path: &str) -> Option<fit::profile::Geometry> {
    let Ok(found) = distortion_of(path) else {
        return None;
    };
    // The body's own word that it corrected nothing, which saves searching for a
    // correction that is not there (`fit::profile`). Only Sony states it; everything else
    // reads as unstated and falls through.
    Some(match (found.applied, found.spline) {
        (Some(false), _) => fit::profile::Geometry::Uncorrected,
        (_, Some(knots)) => fit::profile::Geometry::Recorded(knots),
        // Nothing in the file, so ask the database. The header read this needs is a
        // second open of the same file, which is why it is here rather than above:
        // a body that recorded its own spline never pays for it.
        (_, None) => lensfun_geometry(path).unwrap_or(fit::profile::Geometry::Unstated),
    })
}

/// The lateral aberration the body recorded for this shot, where it recorded one.
///
/// Preferred over measuring it, on the same grounds the distortion cascade prefers a
/// recorded spline: it is written per shot rather than per lens, so it tracks focal
/// length and focus distance that a database entry averages over. Only Sony writes it;
/// everything else reads as None and is measured off the frame.
///
/// Applied at face value (`tca::supplied_curve`), shape and magnitude both: refitting the
/// strength here measured worse than trusting it, and what makes trusting it safe is not a fit
/// but `tca::improves`, which drops the curve if the frame disagrees.
pub(crate) fn recorded_lateral(path: &str) -> Option<[Vec<f64>; 2]> {
    distortion_of(path).ok()?.lateral
}

/// The database's lateral aberration for whatever lens this file names, where it has
/// one.
///
/// Separate from `geometry_for` because the tiers are independent: lensfun's TCA
/// coverage is far thinner than its distortion coverage, so a lens routinely supplies
/// one and not the other.
///
/// Not on the fit's path - see `tca::supplied_curve` for the measurements that decided
/// that - so this is reached only by the test that keeps the reader honest.
#[cfg(all(test, feature = "fixtures"))]
pub(crate) fn database_lateral(path: &str) -> Option<[Vec<f64>; 2]> {
    let header = formats::header::read_path(path)?;
    let [red, blue] = lensdb::tca_knots(
        formats::header::name(&header.camera_make),
        formats::header::name(&header.camera_model),
        formats::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.crop(),
        header.width as usize,
        header.height as usize,
    )?;
    Some([in_spline_units(red), in_spline_units(blue)])
}

/// A radial offset as `lensdb` reports it - a fraction of the radius - into the unit a camera's
/// own spline is carried in, which is what the fit compares the two tiers in.
fn in_spline_units(knots: Vec<f64>) -> Vec<f64> {
    knots
        .into_iter()
        .map(|it| it * geometry::lens::SPLINE_UNIT)
        .collect()
}

/// The database's profile for whatever lens this file names.
///
/// None when the file names no lens, when nothing plausible matches, or when the
/// match carries no distortion data - each of which leaves the geometry to be
/// fitted, as it was before lensfun was here.
fn lensfun_geometry(path: &str) -> Option<fit::profile::Geometry> {
    let header = formats::header::read_path(path)?;
    let knots = lensdb::distortion_knots(
        formats::header::name(&header.camera_make),
        formats::header::name(&header.camera_model),
        formats::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.crop(),
        header.width as usize,
        header.height as usize,
    )?;
    Some(fit::profile::Geometry::Profiled(in_spline_units(knots)))
}
