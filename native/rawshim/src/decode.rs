//! Which decoder a photograph gets, and the one thing every caller above them holds.
//!
//! **Two front ends and one pipeline.** A RAW is read by `decode_rawler` and stops at the
//! conditioned mosaic; a JPEG, PNG, HEIC or AVIF is read by `decode_rendered` and stops at its code
//! values. Below both, everything is the same code: the coding, the defringe, the lens gather, the
//! sharpen, the grade, the crop and the roll-off. This module is the seam, and it is deliberately
//! the *only* one - the alternative is every caller asking what kind of file it has, which is a
//! branch that gets added in one place and forgotten in four.
//!
//! What a rendered photograph does not answer, and why nothing above has to know: it has no mosaic,
//! so [`Held::fit`] finds no noise, the Detail amounts filter nothing, and the dust search has no
//! lattice to read. Each of those is already an `Option` or a no-op for a RAW that arrived without
//! an adapter, so the callers were written for it.

use crate::px::{Photograph, Rect, Size};

/// A photograph opened as far as the stage a setting can still move.
pub enum Held {
    /// A RAW, at the conditioned mosaic.
    Mosaic(crate::decode_rawler::Held),
    /// A finished picture, or a linear DNG, at its code values: neither has a mosaic.
    Rendered(crate::decode_rendered::Held),
}

/// Opens whatever these bytes are, as far as the device.
pub async fn hold_bytes(bytes: &[u8]) -> Result<Held, String> {
    match crate::decode_rendered::is_rendered_bytes(bytes) {
        true => crate::decode_rendered::hold(bytes).map(Held::Rendered),
        false => crate::decode_rawler::open_bytes(bytes).await,
    }
}

/// Opens the photograph at `path`, as far as the device.
#[cfg(feature = "renditions")]
pub async fn hold_path(path: &str) -> Result<Held, String> {
    if !crate::decode_rendered::is_rendered(path) {
        return crate::decode_rawler::open_path(path).await;
    }
    let bytes = std::fs::read(path).map_err(|why| format!("could not read {path}: {why}"))?;
    crate::decode_rendered::hold(&bytes).map(Held::Rendered)
}

/// The whole photograph as a scene-linear frame, from bytes a caller already holds.
///
/// `at_least_long_edge` is the floor `decode_rawler::decode_fitted` documents: the smallest long
/// edge that would still serve, which a photograph at least twice that is halved to.
pub async fn frame_from_bytes(
    bytes: &[u8],
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<crate::frame::Frame> {
    match crate::decode_rendered::is_rendered_bytes(bytes) {
        true => whole(&crate::decode_rendered::hold(bytes).ok()?, at_least_long_edge).await,
        false => {
            crate::decode_rawler::decode_bytes_async(bytes, detail, at_least_long_edge, fit, dust)
                .await
        }
    }
}

/// The same, from a path this process can open.
///
/// `force_half` halves a RAW whatever the floor would have allowed, for an export whose reader
/// chose the trade rather than a size. A finished picture ignores it: there is no mosaic to
/// collapse, so halving one is a resample the caller can ask for through the floor instead.
pub fn frame_from_path(
    path: &str,
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    force_half: bool,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<crate::frame::Frame> {
    if !crate::decode_rendered::is_rendered(path) {
        return crate::decode_rawler::decode_fitted(path, detail, at_least_long_edge, force_half, fit, dust);
    }
    let bytes = std::fs::read(path).ok()?;
    let held = crate::decode_rendered::hold(&bytes).ok()?;
    pollster::block_on(whole(&held, at_least_long_edge))
}

#[cfg(feature = "renditions")]
pub fn frame_from_path_unturned(path: &str, at_least_long_edge: u32) -> Option<crate::frame::Frame> {
    let held = held_unturned(path).ok()?;
    pollster::block_on(whole(&held, at_least_long_edge))
}

/// The finished picture at `path` held as it is stored, ignoring the turn it asks a reader for.
#[cfg(feature = "renditions")]
pub fn hold_path_unturned(path: &str) -> Result<Held, String> {
    held_unturned(path).map(Held::Rendered)
}

#[cfg(feature = "renditions")]
fn held_unturned(path: &str) -> Result<crate::decode_rendered::Held, String> {
    let bytes = std::fs::read(path).map_err(|why| format!("could not read {path}: {why}"))?;
    let mut read = crate::decode_rendered::read(&bytes)?;
    read.turn = rawler::decoders::Orientation::Normal;
    crate::decode_rendered::holding(read)
}

/// A held finished picture as its whole self, halved where the caller's floor allows it.
pub(crate) async fn whole(
    held: &crate::decode_rendered::Held,
    at_least_long_edge: u32,
) -> Option<crate::frame::Frame> {
    let size = held.size();
    let scale = crate::view::Scale::for_long_edge(size.raw(), at_least_long_edge);
    held.window(Rect { at: crate::px::At::ORIGIN, size }, scale)
}

/// One window of a photograph on disk or in hand, which is what a loupe tile and a band of a
/// rendition both are.
///
/// **A finished picture is read whole and then windowed**, where a RAW's region decode reads only
/// the tiles of the file the rectangle touches. There is nothing to restrict: a HEIC's grid is
/// entropy-coded per tile but its gain map, its colour and its turn are the picture's, and the
/// saving would be a second windowing path to keep in step with this one.
///
/// ponytail: so a loupe over HTTP decodes the whole HEIC per tile, where the editor - which holds
/// one open - decodes it once. If that ever reads as slow, the fix is to decode only the grid
/// tiles the rectangle covers rather than to cache a decode here: a tile is a pure function of its
/// arguments, and that is the property the loupe's correctness rests on.
pub async fn tile_from(
    source: Source<'_>,
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    dust: crate::dust::Known<'_>,
) -> Option<crate::frame::Frame> {
    let bytes;
    let rendered = match source {
        Source::Path(path) if crate::decode_rendered::is_rendered(path) => {
            bytes = std::fs::read(path).ok()?;
            Some(bytes.as_slice())
        }
        Source::Bytes(it) if crate::decode_rendered::is_rendered_bytes(it) => Some(it),
        _ => None,
    };
    if let Some(bytes) = rendered {
        return crate::decode_rendered::hold(bytes).ok()?.window(view.window, view.scale);
    }
    let raw = match source {
        // Lazily, because this is a region read: `decode_rawler::mapped` says what the prefault in
        // `RawSource::new` would cost a caller that indexes a rectangle of the file.
        Source::Path(path) => crate::decode_rawler::mapped(path)?,
        Source::Bytes(it) => rawler::rawsource::RawSource::new_from_slice(it),
    };
    crate::decode_rawler::decode_tile_source(&raw, view, detail, fit, halo, dust).await
}

/// [`tile_from`] over a sensor-shift burst's RAWs, merged on the mosaic (`pixel_shift`).
pub async fn shifted_tile_from(
    paths: &[&str],
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    prior: &[crate::pixel_shift::Offset],
    recipe: &crate::composition::Composition,
) -> Option<crate::frame::Frame> {
    if paths.iter().any(|path| crate::decode_rendered::is_rendered(path)) {
        return None;
    }
    let sources = paths
        .iter()
        .map(|path| crate::decode_rawler::mapped(path))
        .collect::<Option<Vec<_>>>()?;
    crate::decode_rawler::decode_shifted_tile(&sources, view, detail, fit, halo, prior, recipe).await
}

/// Where a photograph's bytes are, for the two entry points that take a file rather than an open.
#[derive(Clone, Copy)]
pub enum Source<'a> {
    Path(&'a str),
    Bytes(&'a [u8]),
}

impl Held {
    /// This photograph's noise, where it has any that means anything.
    ///
    /// None for a finished picture: GALOSH's model is of a photosite's own noise on the CFA, and a
    /// frame somebody else's camera has already demosaiced and denoised has neither the lattice
    /// nor the statistics. Reporting a number read off one anyway is what would make the Detail
    /// panel filter a reconstruction.
    pub async fn fit(&self) -> Option<crate::galosh::NoiseFit> {
        match self {
            Held::Mosaic(held) => held.fit().await,
            Held::Rendered(_) => None,
        }
    }

    /// The picture's size the way a reader sees it.
    pub fn size(&self) -> Size<Photograph> {
        match self {
            Held::Mosaic(held) => {
                let (_, _, width, height) = held.crop();
                match crate::orientation::transposes(held.upright()) {
                    true => Size::exact(height, width),
                    false => Size::exact(width, height),
                }
            }
            Held::Rendered(held) => held.size(),
        }
    }

    /// The longest edge of the picture, in the pixels a sigma is measured in.
    pub fn picture_long(&self) -> usize {
        match self {
            Held::Mosaic(held) => held.picture_long(),
            Held::Rendered(held) => held.size().long().raw(),
        }
    }

    /// The whole photograph as a frame, at these mosaic settings, leaving this open untouched.
    ///
    /// **A copy, not this one.** The editor asks again at the next slider position, so the frame
    /// the Detail panel filters has to be one that can be thrown away - which for a RAW is a copy
    /// of the mosaic and for a finished picture is free, nothing above the transfer being able to
    /// move at all.
    pub async fn frame(
        &self,
        detail: crate::galosh::Detail,
        at_least_long_edge: u32,
        fit: crate::galosh::Fit,
        dust: crate::dust::Wanted<'_>,
        report: crate::open_stage::Report<'_>,
    ) -> Option<crate::frame::Frame> {
        match self {
            Held::Mosaic(held) => held.frame(detail, at_least_long_edge, fit, dust, report).await,
            Held::Rendered(held) => whole(held, at_least_long_edge).await,
        }
    }

    /// The particles this photograph's cover glass carries.
    ///
    /// None for a finished picture, and not because it is expensive: the detection reads a
    /// photosite against its own colour's neighbours on the CFA, and a frame that has been
    /// demosaiced has no such neighbours - what it would find on one is the reconstruction's own
    /// texture, everywhere.
    pub async fn dust(&self) -> Option<Vec<crate::dust::Spot>> {
        let Held::Mosaic(held) = self else { return None };
        let gpu = crate::gpu::device()?;
        crate::dust::detect(gpu, held.device_mosaic(), &held.glass()).await
    }

    /// One window of the photograph, as the scene-linear frame the pipeline reads.
    ///
    /// `detail`, `fit`, `halo` and `dust` are the mosaic's, and a finished picture ignores all
    /// four - which is the same thing a RAW does when the reader has left every Detail slider at
    /// rest, so there is nothing here for a caller to branch on.
    ///
    pub async fn window(
        &self,
        window: Rect<Photograph>,
        scale: crate::view::Scale,
        detail: crate::galosh::Detail,
        fit: crate::galosh::Fit,
        halo: usize,
        dust: crate::dust::Known<'_>,
    ) -> Option<crate::frame::Frame> {
        match self {
            Held::Mosaic(held) => {
                let tile = crate::Tile {
                    left: window.at.x.raw(),
                    top: window.at.y.raw(),
                    width: window.size.width.raw(),
                    height: window.size.height.raw(),
                };
                held.window(tile, scale, detail, fit, halo, dust).await
            }
            Held::Rendered(held) => held.window(window, scale),
        }
    }
}
