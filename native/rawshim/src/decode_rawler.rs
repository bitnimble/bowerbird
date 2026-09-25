//! The decode without LibRaw: rawler reads the sensor, and everything after that is ours.
//!
//! LibRaw's `dcraw_process` did four things in one call - black subtraction, white balance, the
//! demosaic and the camera-to-output matrix. Only the demosaic was ever difficult, and it now
//! lives in `demosaic.rs`; the other three are arithmetic over coefficients rawler already carries
//! on its `RawImage`, so this module is mostly a matter of getting them in the right order and
//! the right space.

use crate::frame::{Frame, Pixels};
use crate::orientation::{code as orientation_code, orient, unoriented_rect as as_sensor_rect};

/// Which of a file's embedded JPEGs a caller wants.
///
/// **A body writes more than one, and the right answer differs by caller.** Sony puts a 1616x1080
/// preview in IFD0 and a full-resolution JPEG in a sub-IFD, and the two are not the same picture
/// at different sizes - they are two renderings the body made. So this is stated rather than
/// inferred from the size a caller then decodes to.
#[derive(Clone, Copy)]
pub enum Preview {
    /// The body's own full-size rendering, whatever it costs to read.
    ///
    /// For the viewer, which shows these pixels.
    Largest,
    /// The smallest one that still covers `at_least` on its long edge, falling back to the largest
    /// where none does.
    ///
    /// For a grid tile, which is downsized to 800px whatever it is handed. Reading the
    /// full-resolution preview to make one costs 4-14MB against 1MB and looks identical.
    SmallestCovering(usize),
}

impl Preview {
    /// The one the camera match is fitted against, on every route that fits one.
    ///
    /// **The small one, on purpose, though it is a rendering of its own.** Sony's 1616px preview
    /// is not the full-size JPEG smaller, and a match fitted against it lands about two counts of
    /// 255 from one fitted against the full JPEG, faintly warm. It is also what every body with no
    /// full-size JPEG has always been matched against, it costs a tenth of the decode - 430ms of
    /// a 60MP JPEG against 9ms - and the fit that follows runs at the grid it sets, 3.7x faster
    /// on a 61MP frame. Measured on crops with the lens off, and taken.
    ///
    /// Twice the geometry search's grid, so the search still has a real reduce to make; a body
    /// that embeds nothing that large falls back to its full JPEG, which
    /// `hdr_fit::fitted_preview_size` brings to the same grid in linear light.
    pub fn for_the_match() -> Preview {
        Preview::SmallestCovering(2 * crate::fit::FIT_LONG_EDGE)
    }
}

/// The JPEG `want` asks for, out of everything the file names.
fn chosen<'a>(previews: &[&'a [u8]], want: Preview) -> Option<&'a [u8]> {
    let largest = previews.iter().max_by_key(|jpeg| jpeg.len()).copied();
    let Preview::SmallestCovering(at_least) = want else {
        return largest;
    };
    previews
        .iter()
        .filter_map(|jpeg| {
            let (width, height) = crate::jpeg::dimensions(jpeg)?;
            (width.max(height) >= at_least).then_some((width.max(height), *jpeg))
        })
        .min_by_key(|(long, _)| *long)
        .map_or(largest, |(_, jpeg)| Some(jpeg))
}

/// The embedded JPEG, turned upright if it is not already.
///
/// **The preview is stored as the sensor read it, and LibRaw's thumbnail is not.** That is the one
/// behavioural difference between the two ways of reaching the same JPEG, and it is not cosmetic:
/// the camera match is fitted by comparing this against the render, so a sideways preview fits
/// against unrelated content. Measured, it cost 15% of the mean luma on a portrait frame.
///
/// A landscape frame is handed back untouched, which is most of them. The rest are handed back with
/// the turn written into their EXIF, and it is written here so that every caller is right rather
/// than each having to know.
pub fn upright_preview_jpeg(path: &str, want: Preview) -> Option<Vec<u8>> {
    // `new_lazy`, not `new`: every decoder answers `preview_jpegs` with `subview(offset, length)`
    // off its own tags, so the pages this faults are the JPEG's own. The prefault in `new` would
    // read the whole 25-90MB file to reach 10MB of it, once per grid tile of an import.
    upright_preview_of(
        &rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()?,
        want,
    )
}

/// The same, from a file already in memory.
pub fn upright_preview_jpeg_bytes(bytes: &[u8], want: Preview) -> Option<Vec<u8>> {
    upright_preview_of(&rawler::rawsource::RawSource::new_from_slice(bytes), want)
}

/// The same preview, upright, decoded to `long_edge` - for the callers that wanted pixels.
///
/// **Every caller but two immediately decoded what `upright_preview_jpeg` handed back**, and on a
/// rotated frame that is a full-size decode, a full-size encode and a second decode where one
/// scaled decode and a transpose do: the Canon fixture's preview alone decodes in 420ms, so the
/// round trip is most of a second on every portrait photograph. `jpeg::decode` already reduces
/// before it rotates, and a rotation is a permutation, so this reaches the same pixels - minus the
/// generation of quality-95 loss the re-encode was putting into what the colour fit measures.
///
/// The two that do want bytes - the editor's open and the FFI download - still have
/// `upright_preview_jpeg`, which is where the re-encode belongs.
pub fn upright_preview_rgb(
    path: &str,
    long_edge: usize,
    want: Preview,
) -> Option<crate::rgb::Rgb> {
    let source = rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    upright_preview_rgb_with(&source, decoder.as_ref(), long_edge, want)
}

/// The same, off a source and decoder the caller already opened.
pub fn upright_preview_rgb_with(
    source: &rawler::rawsource::RawSource,
    decoder: &dyn rawler::decoders::Decoder,
    long_edge: usize,
    want: Preview,
) -> Option<crate::rgb::Rgb> {
    let params = rawler::decoders::RawDecodeParams::default();
    let previews = decoder.preview_jpegs(source, &params).ok()?;
    let jpeg = chosen(&previews, want)?;
    let image = crate::jpeg::decode(jpeg, long_edge).ok()?;

    let upright = upright_of(decoder, source, &params);
    use rawler::decoders::Orientation as O;
    if matches!(upright, O::Normal | O::Unknown) {
        return Some(image);
    }
    let (data, width, height) = orient(image.data, image.width, image.height, upright);
    Some(crate::rgb::Rgb { width, height, data })
}

fn upright_preview_of(source: &rawler::rawsource::RawSource, want: Preview) -> Option<Vec<u8>> {
    let source = &source;
    let decoder = rawler::get_decoder(source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let previews = decoder.preview_jpegs(source, &params).ok()?;
    let jpeg = chosen(&previews, want)?;

    let upright = upright_of(decoder.as_ref(), &source, &params);
    use rawler::decoders::Orientation as O;
    if matches!(upright, O::Normal | O::Unknown) {
        return Some(jpeg.to_vec());
    }

    // **Said in EXIF rather than performed on the pixels.** `jpeg::with_orientation` says why: the
    // turn costs a 60MP decode and re-encode on a full-resolution preview, and thirty-six bytes
    // carry it instead. Everything downstream reads it - a browser, a downloaded file, and
    // `jpeg::decode`, which applies the tag before it reduces.
    let tag = match upright {
        O::HorizontalFlip => 2,
        O::Rotate180 => 3,
        O::VerticalFlip => 4,
        O::Transpose => 5,
        O::Rotate90 => 6,
        O::Transverse => 7,
        O::Rotate270 => 8,
        O::Normal | O::Unknown => 1,
    };
    crate::jpeg::with_orientation(jpeg, tag)
}

/// One tile of a photograph, decoding only the part of the file the tile needs.
///
/// `tile` is in the same space `decode` hands back: the recommended crop's pixels, before the
/// orientation is applied. That is what `cropbox` means on the LibRaw side, and a loupe asking both
/// decoders for the same rectangle has to get the same picture.
///
/// The saving is the point of the fork. `raw_image_region_tight` decodes only the tiles or subbands
/// the region touches and allocates only the rectangle it covered, and everything after it here -
/// conditioning, the denoise, the demosaic, the colour transform - runs over the region rather than
/// the frame.
pub fn decode_tile(
    path: &str,
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    dust: crate::dust::Known<'_>,
) -> Option<Frame> {
    blocking(decode_tile_source(&mapped(path)?, view, detail, fit, halo, dust))
}

/// A photograph mapped for a *region* read, which is the whole reason this is not `RawSource::new`.
///
/// **`new` asks the kernel for the whole file before a byte of it is wanted.** It maps with
/// `MAP_POPULATE` and then advises `WillNeed` and `Sequential`, all three of which read every
/// page. That is the right trade for a decode that goes on to touch them all, and the wrong one
/// here: a region decode indexes the tiles or the rows it needs and nothing else, so a lazy
/// mapping faults in what it reads and the I/O follows the rectangle on every format that can be
/// cut.
///
/// A format that cannot be cut still decodes whole and still touches every page. It just faults
/// them on demand instead of being handed them, which is the kernel's own readahead rather than
/// the advice `new` gives. ARW1 and the SRF fall-backs are the ones that reach it.
pub(crate) fn mapped(path: &str) -> Option<rawler::rawsource::RawSource> {
    rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()
}

pub(crate) async fn decode_tile_source(
    source: &rawler::rawsource::RawSource,
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    dust: crate::dust::Known<'_>,
) -> Option<Frame> {
    let region = match region_mosaic(source, view, detail, fit, halo, crate::px::Span::exact(0), dust).await? {
        Region::Mosaic(region) => region,
        Region::Linear(frame) => return Some(frame),
    };
    let gpu = crate::gpu::device()?;
    let rcd = crate::demosaic::device(gpu)?;
    let built = match region.halving {
        true => region.reduced(gpu, rcd).await?,
        false => {
            // One span or many, which `spans` already decides: a tile writes straight into the
            // frame now, so a single-tile region costs nothing that the loop did not.
            demosaic_in_tiles(
                gpu,
                rcd,
                &region.mosaic,
                &region.cfa,
                region.crop,
                region.colour,
                orientation_code(region.upright),
            )
            .await?
        }
    };
    Some(region.frame(built))
}

/// A window of a sensor-shift burst, merged on the photosite lattice where a single frame would be
/// demosaiced. `sources` are the burst's frames in its own order.
///
/// **Where the frame is halved, the merge buys nothing**: a halved frame reads one pixel per 2x2 site,
/// which already has every colour, so the four frames are the same picture below its Nyquist and the
/// reference alone is the answer.
pub(crate) async fn decode_shifted_tile(
    sources: &[rawler::rawsource::RawSource],
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    prior: &[crate::pixel_shift::Offset],
    recipe: &crate::composition::Composition,
) -> Option<Frame> {
    let (first, rest) = sources.split_first()?;
    if rest.len() + 1 != crate::pixel_shift::SHIFTS.len()
        || prior.len() != sources.len()
        || recipe.sources.len() != sources.len()
    {
        return None;
    }
    let reference_extra = crate::pixel_shift_align::REFERENCE_MARGIN.raw()
        .saturating_sub(RCD_MARGIN + crate::tile_halo(halo));
    let Region::Mosaic(reference) = region_mosaic(
        first, view, detail, fit, halo,
        crate::px::Span::exact(reference_extra),
        crate::dust::Known::Off,
    ).await? else {
        return None;
    };
    let gpu = crate::gpu::device()?;
    let rcd = crate::demosaic::device(gpu)?;
    if reference.halving {
        let built = reference.reduced(gpu, rcd).await?;
        return Some(reference.frame(built));
    }
    let reference_pyramid = crate::pixel_shift_align::Pyramid::of(gpu, &reference.mosaic);
    let (period_w, period_h) = reference.cfa.period();
    let reach_x = RCD_MARGIN + crate::pixel_shift::SETTLE_REACH.raw() + period_w;
    let reach_y = RCD_MARGIN + crate::pixel_shift::SETTLE_REACH.raw() + period_h;
    let (left, top) = reference.cfa.align_origin(
        reference.crop.0.saturating_sub(reach_x),
        reference.crop.1.saturating_sub(reach_y),
    );
    let right = (reference.crop.0 + reference.crop.2 + reach_x)
        .next_multiple_of(period_w).min(reference.mosaic.width);
    let bottom = (reference.crop.1 + reference.crop.3 + reach_y)
        .next_multiple_of(period_h).min(reference.mosaic.height);
    let (width, height) = reference.cfa.align_extent(right - left, bottom - top);
    let (reference_x, reference_y) = reference.origin.raw();
    let merge_region = crate::px::Rect::exact(reference_x + left, reference_y + top, width, height);
    let merged = crate::pixel_shift::Merged::over(gpu, merge_region);
    merged.gather(gpu, &reference.mosaic, &reference.cfa, reference.origin, None)?;
    let window = crate::px::Rect::exact(
        reference_x + reference.crop.0,
        reference_y + reference.crop.1,
        reference.crop.2,
        reference.crop.3,
    );
    for (at, source) in rest.iter().enumerate() {
        // The reference's fit, so every frame is denoised as the one it is merged into.
        let fit = reference.noise.map_or(fit, crate::galosh::Fit::Given);
        let Region::Mosaic(frame) = region_mosaic(
            source, view, detail, fit, halo,
            crate::pixel_shift_align::MARGIN,
            crate::dust::Known::Off,
        ).await? else {
            return None;
        };
        if frame.cfa != reference.cfa {
            return None;
        }
        let (photo_x, photo_y) = reference.photograph_origin.raw();
        let (frame_photo_x, frame_photo_y) = frame.photograph_origin.raw();
        let crop_shift_x = frame_photo_x as f64 - photo_x as f64;
        let crop_shift_y = frame_photo_y as f64 - photo_y as f64;
        let fallback = prior[at + 1];
        let field = crate::pixel_shift_align::measure(
            gpu,
            &reference_pyramid,
            &frame.mosaic,
            reference.origin,
            frame.origin,
            window,
            |sensor_x, sensor_y| {
                let point = [sensor_x - photo_x as f64, sensor_y - photo_y as f64];
                let projected = crate::pixel_shift::prior_at(recipe, at + 1, point).unwrap_or(fallback);
                crate::pixel_shift::Offset {
                    x: crate::px::Extent::measured(projected.x.raw() + crop_shift_x),
                    y: crate::px::Extent::measured(projected.y.raw() + crop_shift_y),
                }
            },
        );
        merged.gather(gpu, &frame.mosaic, &frame.cfa, frame.origin, Some(&field))?;
    }
    // The reference's own demosaic under the merge, which is what a site the frames disagree about
    // takes instead (`pixel_shift::Merged::settle`).
    let noise = reference.noise.map(|fit| fit.model());
    let built = demosaic_settled_in_tiles(
        gpu,
        rcd,
        &reference.mosaic,
        &reference.cfa,
        reference.crop,
        reference.colour,
        orientation_code(reference.upright),
        &|recording, rgb, window| merged.settle(
            gpu,
            recording,
            rgb,
            (reference_x + window.0 - merge_region.at.x.raw(),
             reference_y + window.1 - merge_region.at.y.raw(),
             window.2, window.3),
            noise,
        ),
    )
    .await?;
    Some(reference.frame(built))
}

/// What a window of a RAW is before the demosaic: its mosaic, or for a linear DNG, which has none,
/// the frame itself.
enum Region {
    Mosaic(RegionMosaic),
    Linear(Frame),
}

/// One window's region of the sensor, conditioned, cleaned and denoised: everything a decode does
/// before the demosaic.
struct RegionMosaic {
    mosaic: crate::condition::Mosaic,
    origin: crate::px::At<crate::px::Sensor>,
    photograph_origin: crate::px::At<crate::px::Sensor>,
    cfa: crate::cfa::Cfa,
    colour: crate::demosaic::Colour,
    /// The window inside the region, which is where the margin grown around it ends.
    crop: (usize, usize, usize, usize),
    upright: rawler::decoders::Orientation,
    halving: bool,
    noise: Option<crate::galosh::NoiseFit>,
    as_shot: Option<crate::white_balance::AsShot>,
}

impl RegionMosaic {
    async fn reduced(
        &self,
        gpu: &'static crate::gpu::Gpu,
        rcd: &'static crate::demosaic::Rcd,
    ) -> Option<crate::resident::Resident> {
        let crop = self.crop;
        let crop = (crop.0 / 2, crop.1 / 2, reduced_span(crop.2, 2), reduced_span(crop.3, 2));
        let orientation = orientation_code(self.upright);
        reduced_into(gpu, rcd, &self.mosaic, crop, self.mosaic.width, self.colour, orientation, &self.cfa).await
    }

    fn frame(&self, built: crate::resident::Resident) -> Frame {
        Frame {
            width: built.width,
            height: built.height,
            pixels: Pixels::Resident(built),
            reduced: match self.halving {
                true => 2,
                false => 1,
            },
            as_shot: self.as_shot,
            noise: self.noise,
            // A tile's whole-frame statistics are the photograph's to provide, not this crop's.
            dust: None,
            matrix: Some(self.colour.matrix),
            neutral_ceiling: neutral_ceiling_of(self.colour.ceiling),
            wb_gains: self.colour.ceiling,
            stated_white: None,
        }
    }
}

async fn region_mosaic(
    source: &rawler::rawsource::RawSource,
    view: crate::view::View,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    extra: crate::px::Span<crate::px::Sensor>,
    dust: crate::dust::Known<'_>,
) -> Option<Region> {
    // The window in the photograph's own pixels, which is the only space this function speaks.
    let window = view.window.raw();
    let tile = crate::Tile {
        left: window.0,
        top: window.1,
        width: window.2,
        height: window.3,
    };
    let halve = view.scale.halves();
    let decoder = rawler::get_decoder(source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let upright = upright_of(decoder.as_ref(), &source, &params);

    // Dummy first, for `crop_area`: the tile is in the crop's coordinates and the region to decode
    // is in the sensor's, so the offset between them has to be known before anything is read. A
    // dummy decode skips the decompression, which is the whole cost.
    let shape = decoder.raw_image(&source, &params, true).ok()?;
    // A DNG is read whole whatever `dummy` says, so a linear one is already here to window.
    if is_linear(&shape) {
        let held = linear(decoder.as_ref(), shape, upright).await;
        let held = held.map_err(|why| crate::warn(&format!("rawshim: {why}"))).ok()?;
        return held.window(view.window, view.scale).map(Region::Linear);
    }
    let (frame_w, frame_h) = (shape.width, shape.height);
    let (origin, extent) = shape.crop_area.map_or(((0, 0), (frame_w, frame_h)), |area| {
        ((area.p.x, area.p.y), (area.d.w, area.d.h))
    });
    let extent = (whole_sites(extent.0), whole_sites(extent.1));
    // Named upright, cropped in the sensor's coordinates, handed back upright again.
    let tile = as_sensor_rect(tile, extent.0, extent.1, upright);

    // Grown by what reads past the tile, and by the denoise's own window, then aligned so the
    // pattern inside the region is the pattern the frame has.
    //
    // **Down to `pass12`'s grid, not merely to a CFA site**, which `Held::window` learnt first and
    // this path did not: the shrinkage tiles from the region's own origin, so a window starting off
    // that lattice shrinks every pixel against a different neighbourhood and stops being a piece of
    // the frame. A whole CFA site is enough only to keep the colours right. Measured on the Sony at
    // Detail 40, a 512px loupe tile sat 254 counts of 65535 from the render it exists to predict.
    //
    // Costs the few rows it can add to two sides, which are halo either way.
    let halo = crate::tile_halo(halo);
    let reach = RCD_MARGIN + halo + extra.raw();
    // The pattern off the dummy decode, which is the whole reason that decode happens before this:
    // the region's origin has to land on a whole period as well as on the shrinkage's grid, and
    // which period that is is the file's to say.
    let cfa = cfa_of(&shape)?;
    let (lattice_x, lattice_y) = crate::galosh::lattice(&cfa);
    let (left, top) = (
        (origin.0 + tile.left).saturating_sub(reach) / lattice_x * lattice_x,
        (origin.1 + tile.top).saturating_sub(reach) / lattice_y * lattice_y,
    );
    let right = (origin.0 + tile.left + tile.width + reach).min(frame_w);
    let bottom = (origin.1 + tile.top + tile.height + reach).min(frame_h);
    // Both extents whole periods as well as both origins, because the denoise pairs samples into 2x2
    // sites and refuses a region that does not. Trimmed rather than grown: the last column is halo,
    // which is there to be eaten, and at the frame's own edge there is nothing to grow into. A caller
    // asking for an odd-sized tile is ordinary - the loupe rounds a span to whole pixels - so this
    // is the common path rather than a guard against a strange request.
    let (span_w, span_h) = cfa.align_extent(right - left, bottom - top);
    let (right, bottom) = (left + span_w, top + span_h);
    if right <= left || bottom <= top {
        return None;
    }
    let region = rawler::imgop::Rect::new(
        rawler::imgop::Point::new(left, top),
        rawler::imgop::Dim2::new(right - left, bottom - top),
    );

    let held = crate::raw_cache::region(source, &params, region, || {
        let (image, covered) = decoder.raw_image_region_tight(&source, &params, region, false).ok()?;
        Some(crate::raw_cache::Region { image, covered })
    })?;
    let (image, decoded) = (&held.image, held.covered);
    let rawler::RawImageData::Integer(samples) = &image.data else {
        return None;
    };
    if samples.len() < image.width * image.height {
        return None;
    }

    // The region's own mosaic, lifted out of the tile-aligned rectangle the decode actually covered.
    let (region_w, region_h) = (right - left, bottom - top);
    let mut window = vec![0u16; region_w * region_h];
    for row in 0..region_h {
        let from = (top - decoded.p.y + row) * image.width + (left - decoded.p.x);
        window[row * region_w..(row + 1) * region_w].copy_from_slice(&samples[from..from + region_w]);
    }

    let cfa = cfa_of(image)?;
    let gpu = crate::gpu::device();
    let mut mosaic = condition(gpu, &window, region_w, region_h, image, &cfa)?;

    // The photograph's own particles, offset into this region. A region cannot search for its own -
    // `Known` has no way to ask - because the gates read the frame's texture floor, so a tile that
    // found its own would be corrected differently from its neighbours and from the export it
    // exists to predict.
    if let Some(gpu) = gpu {
        crate::dust::apply(gpu, &mosaic, &dust, (left, top));
    }

    let noise =
        denoise_over(gpu, &mut mosaic, detail, fit, halo, &cfa, channel_ceilings(image)).await;

    let colour = colour_of(image)?;
    // The tile's place inside the region, which is where the margin that was grown on ends.
    let inset = (origin.0 + tile.left - left, origin.1 + tile.top - top);
    let crop = (inset.0, inset.1, tile.width.min(region_w - inset.0), tile.height.min(region_h - inset.1));
    // **Halved where the caller asked for it, which is the same fork `decode_source` takes over a
    // whole frame** - one RGB pixel read straight off each 2x2 site rather than RCD interpolating
    // between them. It is the *demosaic* that goes, not the read and not the denoise: both of those
    // have already run, at the sensor's own resolution, over this region.
    //
    // The caller decides, and decides from the *photograph* - whether a 61MP sensor is worth
    // halving for a 4K rendition is a question about the picture, not about whichever rectangle of
    // it this call happens to hold. A region asked that of its own dimensions would answer
    // differently for every tile.
    //
    // The inset has to stay on a whole CFA site or the colours in the half-size frame are the ones
    // next door, so an odd one declines rather than shifts. `reduced` on the way out says which was
    // taken, since the caller's coordinates are the sensor's either way.
    //
    // **Bayer only, which the whole-frame route is not.** `view::Scale` sizes the window this
    // caller asked for, so a frame that came back at a third of the sensor where the caller had
    // computed a half is the wrong size rather than a smaller one. That route reports its factor
    // and is read; this one is predicted, so a 6x6 pattern takes the demosaic until `Scale` carries
    // a third variant - which needs the CFA's period to reach whoever builds the view.
    let halving = halve && crop.0 % 2 == 0 && crop.1 % 2 == 0 && cfa.is_bayer();
    Some(Region::Mosaic(RegionMosaic {
        as_shot: as_shot_of(gpu?, image).await,
        mosaic,
        origin: crate::px::At::exact(left, top),
        photograph_origin: crate::px::At::exact(origin.0, origin.1),
        cfa,
        colour,
        crop,
        upright,
        halving,
        noise,
    }))
}

/// The whole frame, at the sensor's own resolution and with nothing taken off the glass.
pub fn decode(path: &str, detail: crate::galosh::Detail) -> Option<Frame> {
    decode_fitted(path, detail, 0, false, crate::galosh::Fit::Measure, crate::dust::Wanted::Off)
}

/// The frame, halved where the caller's floor allows it.
///
/// `at_least_long_edge` is the smallest long edge that would still serve. Halving a frame whose own
/// long edge is at least twice that leaves it still large enough, and saves the demosaic outright.
///
/// The frame comes back where the demosaic wrote it, on the device; `Frame::to_host` is the reader
/// that wants samples.
pub fn decode_fitted(
    path: &str,
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    force_half: bool,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<Frame> {
    let mut lap = crate::clock::laps("  decode ");
    let path = std::path::Path::new(path);
    let source = match uncached(path) {
        // `new_from_slice` takes its own copy, so the aligned buffer goes at the end of this arm
        // rather than sitting on eighty megabytes for the length of the decode.
        Ok((bytes, at)) => rawler::rawsource::RawSource::new_from_slice(&bytes[at..]),
        // `RawSource` maps the file with `populate`, so the read is here either way rather than
        // spread over the decode that follows it.
        Err(_) => rawler::rawsource::RawSource::new(path).ok()?,
    };
    lap("file");
    blocking(decode_source(&source, detail, at_least_long_edge, force_half, fit, dust))
}

/// The whole file, read past the page cache, and the offset it starts at.
///
/// The offset is not zero: O_DIRECT wants a page-aligned address, which a Vec cannot promise, so
/// the buffer is over-allocated and read into the middle.
///
/// Not for [`decode_tile`], which reads the same file once per tile and wants the cache.
#[cfg(target_os = "linux")]
fn uncached(path: &std::path::Path) -> std::io::Result<(Vec<u8>, usize)> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;

    // asm-generic's value, which is every architecture this ships to. libc is not a dependency.
    const O_DIRECT: i32 = 0o40000;
    const ALIGN: usize = 4096;
    // One NFS `rsize`, and the whole point: a larger read is split into that many requests and
    // issued at once, which is the interleaving this is here to avoid. Measured on the mount a
    // library lives on, cold, 512K 219MB/s, 1M 221, 2M 130, 4M 103, 8M 96.
    const CHUNK: usize = 1 << 20;

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_DIRECT)
        .open(path)?;
    let len = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    let padded = len.next_multiple_of(ALIGN);
    let mut bytes = vec![0u8; padded + ALIGN];
    let at = ALIGN - bytes.as_ptr() as usize % ALIGN;

    let mut got = 0;
    while got < len {
        // The offset, the address and the length all have to stay aligned, so a short read that is
        // not itself a multiple of one leaves nowhere legal to continue from. Linux only returns
        // one at the end of the file, where the loop has already stopped.
        if got % ALIGN != 0 {
            return Err(std::io::Error::other("a short read broke the alignment"));
        }
        let end = (got + CHUNK).min(padded);
        match file.read(&mut bytes[at + got..at + end])? {
            0 => return Err(std::io::Error::other("the file ended early")),
            n => got += n,
        }
    }

    bytes.truncate(at + len);
    Ok((bytes, at))
}

/// Where there is no O_DIRECT, so [`decode_fitted`] maps the file as it always did.
#[cfg(not(target_os = "linux"))]
fn uncached(_: &std::path::Path) -> std::io::Result<(Vec<u8>, usize)> {
    Err(std::io::Error::other("O_DIRECT is Linux's"))
}

/// The same decode, from bytes already in hand.
///
/// What preparing an edit needs: the server has read the file to hash it and hands the buffer
/// straight on, so opening the path again would read it twice.
pub fn decode_bytes(
    bytes: &[u8],
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<Frame> {
    blocking(decode_bytes_async(bytes, detail, at_least_long_edge, fit, dust))
}

/// The same, awaited, which is the only spelling a browser can take.
///
/// The chain's one readback is the demosaic's, and wgpu's WebGPU backend cannot be blocked for a
/// map ([`crate::gpu::read_back`]). Native drives this to completion without ever suspending, which
/// is what lets every blocking entry point above stay exactly as blocking as it was.
pub async fn decode_bytes_async(
    bytes: &[u8],
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<Frame> {
    decode_source(
        &rawler::rawsource::RawSource::new_from_slice(bytes),
        detail,
        at_least_long_edge,
        false,
        fit,
        dust,
    )
    .await
}

/// A decode driven to completion on this thread.
///
/// **Every host but a browser.** These futures suspend only on `wasm32`, where the readback awaits
/// the browser's own event loop; there the page's executor drives them
/// ([`decode_bytes_async`]) and nothing in the wasm build reaches the blocking spellings.
fn blocking<T>(work: impl std::future::Future<Output = T>) -> T {
    pollster::block_on(work)
}

/// Everything the rest of a decode needs of the file, once the mosaic has been conditioned.
///
/// Held rather than re-read because none of it depends on a Detail amount: a slider moves the
/// denoise and nothing above it, so a caller re-running the chain re-reads no bytes.
#[derive(Clone)]
struct Sensor {
    width: usize,
    height: usize,
    cfa: crate::cfa::Cfa,
    crop: (usize, usize, usize, usize),
    colour: crate::demosaic::Colour,
    upright: rawler::decoders::Orientation,
    as_shot: Option<crate::white_balance::AsShot>,
    /// What the lens was stopped down to, which decides how large and how deep a particle's shadow
    /// is (`crate::dust`). Zero where the file recorded none, and then nothing is looked for.
    aperture: f32,
    /// The picture's width across the silicon, in millimetres, which with the width in photosites
    /// is the pitch a particle's shadow is measured in (`crate::dust`).
    width_mm: f32,
}

impl Sensor {
    fn glass(&self) -> crate::dust::Sensor {
        crate::dust::Sensor {
            width: self.width,
            height: self.height,
            crop: self.crop,
            cfa: self.cfa,
            aperture: self.aperture,
            width_mm: self.width_mm,
        }
    }
}

impl Held {
    /// What `crate::dust` needs of this body to read its cover glass.
    pub fn glass(&self) -> crate::dust::Sensor {
        self.sensor.glass()
    }
}

/// A decode paused at the mosaic: conditioned, on the device where there is one, and not yet
/// denoised.
///
/// **What the editor holds while a photograph is open.** Everything above the denoise - the read,
/// the black levels, the white balance, the conditioning - depends on the file alone, and
/// everything below it depends on the Detail amounts. Splitting there is what lets a slider re-run
/// the denoise, the demosaic and the grade against a mosaic that is already on the GPU rather than
/// re-reading a 25MB file and conditioning it again.
///
/// A rendition holds one for a moment and takes [`Held::into_frame`], which filters in place; the
/// editor keeps one and takes [`Held::frame`], which filters a copy so the original survives the
/// next slider move.
pub struct Held {
    mosaic: crate::condition::Mosaic,
    sensor: Sensor,
}

/// The decode as far as the mosaic, from bytes a caller is already holding.
pub async fn hold_bytes(bytes: &[u8]) -> Option<Held> {
    match open_bytes(bytes).await.ok()? {
        crate::decode::Held::Mosaic(held) => Some(held),
        crate::decode::Held::Rendered(_) => None,
    }
}

/// The decode as far as a setting is irrelevant, from bytes a caller is already holding.
pub async fn open_bytes(bytes: &[u8]) -> Result<crate::decode::Held, String> {
    open(&rawler::rawsource::RawSource::new_from_slice(bytes)).await
}

/// The same, from a file this process can open.
#[cfg(feature = "renditions")]
pub async fn open_path(path: &str) -> Result<crate::decode::Held, String> {
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path))
        .map_err(|why| format!("could not read {path}: {why}"))?;
    open(&source).await
}

/// The mosaic, or for a linear DNG the picture, which has no mosaic to stop at.
async fn open(source: &rawler::rawsource::RawSource) -> Result<crate::decode::Held, String> {
    let mut lap = crate::clock::laps("  decode ");

    let decoder = rawler::get_decoder(source).map_err(|why| why.to_string())?;
    let params = rawler::decoders::RawDecodeParams::default();

    let upright = upright_of(decoder.as_ref(), source, &params);

    lap("open");
    let image = decoder.raw_image(source, &params, false).map_err(|why| why.to_string())?;
    lap("read");
    if is_linear(&image) {
        return linear(decoder.as_ref(), image, upright).await.map(crate::decode::Held::Rendered);
    }
    hold(decoder.as_ref(), source, &params, image, upright)
        .await
        .map(crate::decode::Held::Mosaic)
        .ok_or_else(|| "no decoder read these bytes".to_string())
}

/// Whether this file was demosaiced before it was written: a Lightroom merge, an Enhance, a DNG
/// converter asked for linear output.
fn is_linear(image: &rawler::RawImage) -> bool {
    matches!(image.photometric, rawler::rawimage::RawPhotometricInterpretation::LinearRaw)
}

/// A linear DNG as a picture on the device, conditioned through `linearise.slang`'s table.
///
/// The mosaic's arithmetic, a channel at a time: each channel's own black, the saturation, the
/// file's curve out of OpcodeList2, the white balance, and the camera's matrix, so a merge renders
/// as the frames it was made from do. Not the denoise, the dust search or RCD, which read a CFA
/// this file no longer has.
async fn linear(
    decoder: &dyn rawler::decoders::Decoder,
    mut image: rawler::RawImage,
    upright: rawler::decoders::Orientation,
) -> Result<crate::decode_rendered::Held, String> {
    let gpu = crate::gpu::device()
        .ok_or_else(|| crate::base::without_a_device("reading a linear DNG"))?;
    let (width, height) = (image.width, image.height);
    let values = width * height * 3;
    let stored = match &image.data {
        rawler::RawImageData::Integer(samples) => samples.len(),
        rawler::RawImageData::Float(samples) => samples.len(),
    };
    if image.cpp != 3 {
        return Err(format!("this linear DNG has {} samples a pixel where 3 were expected", image.cpp));
    }
    if stored < values {
        return Err(format!("this linear DNG holds {stored} samples where {values} were expected"));
    }
    let matrix = camera_to_rec2020(&image).ok_or("this DNG's camera matrix is singular")?;
    let curves = plane_curves(decoder, width, height)?;
    let crop = image.crop_area.map_or(crate::px::Rect::exact(0, 0, width, height), |area| {
        crate::px::Rect::exact(area.p.x, area.p.y, area.d.w, area.d.h)
    });
    let coding =
        crate::transfer::Coding { matrix, curve: crate::transfer::Curve::Linear, depth: 16 };
    let as_shot = as_shot_of(gpu, &image).await;

    let data = std::mem::replace(&mut image.data, rawler::RawImageData::Integer(Vec::new()));
    let (picture, ceiling) = match data {
        rawler::RawImageData::Integer(mut samples) => {
            let table = linear_table(&image, &curves);
            let ceiling = std::array::from_fn(|channel| {
                table.iter().skip(channel).step_by(3).copied().fold(0.0f32, f32::max)
            });
            samples.truncate(values);
            let picture = crate::linearise::Picture::camera(
                gpu, samples, width, height, crop, coding, &table, upright,
            );
            (picture, ceiling)
        }
        rawler::RawImageData::Float(mut samples) => {
            let affine = float_affine(decoder, &image, &curves)?;
            samples.truncate(values);
            let picture = crate::linearise::Picture::camera_float(
                gpu, samples, width, height, crop, coding, affine, upright,
            );
            // Nothing saturates short of the container: past white is what the file kept.
            (picture, [1.0; 3])
        }
    };
    let camera = crate::decode_rendered::Camera { as_shot, ceiling };
    Ok(crate::decode_rendered::Held::camera(picture, camera))
}

/// [`linear_table`]'s arithmetic for a DNG stored as floating point, whose samples are not codes.
///
/// The white level is 1.0 where the file states none, which is the DNG specification's default for
/// floating point and not rawler's, whose default is the bit depth's full scale. No curve: one
/// cannot be folded into a scale, and applying it in the kernel would be a second spelling of the
/// polynomial [`linear_table`] evaluates.
fn float_affine(
    decoder: &dyn rawler::decoders::Decoder,
    image: &rawler::RawImage,
    curves: &[Vec<f64>; 3],
) -> Result<crate::linearise::Affine, String> {
    if curves.iter().any(|curve| curve.as_slice() != [0.0, 1.0]) {
        return Err("this DNG maps its floating-point samples through a curve, which this build does not apply".into());
    }
    let stated = decoder
        .ifd(rawler::decoders::WellKnownIFD::Raw)
        .ok()
        .flatten()
        .and_then(|ifd| ifd.get_entry(rawler::tags::TiffCommonTag::WhiteLevel).cloned())
        .filter(|entry| entry.count() > 0);
    let white = |channel: usize| match &stated {
        Some(entry) => entry.force_f32(channel.min(entry.count() as usize - 1)),
        None => 1.0,
    };
    let black = &image.blacklevel.levels;
    let gains = white_balance_gains(image);
    let mut affine = crate::linearise::Affine { scale: [0.0; 3], offset: [0.0; 3] };
    for channel in 0..3 {
        let floor = black.get(channel).or(black.first()).map_or(0.0, |level| level.as_f32());
        let scale = gains[channel] / (white(channel) - floor).max(f32::MIN_POSITIVE);
        affine.scale[channel] = scale;
        affine.offset[channel] = -floor * scale;
    }
    Ok(affine)
}

/// Every sample a linear DNG can hold as the light it stands for, `code * 3 + channel`.
///
/// **Scaled so the brightest channel's ceiling is 1**, which [`white_balance_gains`] does for a
/// RAW: a file whose curve tops out at a sixth of full scale would otherwise leave the frame's `u16`
/// two and a half bits short in the shadows.
fn linear_table(image: &rawler::RawImage, curves: &[Vec<f64>; 3]) -> Vec<f32> {
    let black = &image.blacklevel.levels;
    let gains = white_balance_gains(image);
    // The file's own figure, not `saturation_of`'s: rounding a Canon level up to its converter's
    // width is a fact about the sensor, and a merge's curve was fitted to the level it states.
    let white = &image.whitelevel.0;
    let levels: [Coefficients; 3] = std::array::from_fn(|channel| {
        let floor = black.get(channel).or(black.first()).map_or(0.0, |level| level.as_f32());
        let white = white.get(channel).or(white.first()).map_or(65535.0, |level| *level as f32);
        Coefficients { floor, range: (white - floor).max(1.0), gain: gains[channel] }
    });
    table_of(levels, curves)
}

/// [`linear_table`] off the levels alone: the curve goes between the fill and the white balance,
/// which is where the DNG specification puts OpcodeList2.
fn table_of(levels: [Coefficients; 3], curves: &[Vec<f64>; 3]) -> Vec<f32> {
    let mut table: Vec<f32> = (0..=u16::MAX)
        .flat_map(|sample| {
            std::array::from_fn::<f32, 3, _>(|channel| {
                let level = levels[channel];
                let x = f64::from(conditioned(sample, Coefficients { gain: 1.0, ..level }));
                let y = curves[channel].iter().rev().fold(0.0, |sum, c| sum * x + c).min(1.0);
                y as f32 * level.gain
            })
        })
        .collect();
    let top = table.iter().copied().fold(0.0f32, f32::max);
    if top > 0.0 {
        table.iter_mut().for_each(|value| *value /= top);
    }
    table
}

/// Each plane's curve out of the DNG's OpcodeList2, as polynomial coefficients from the constant
/// up: `[0, 1]`, the identity, where it states none.
///
/// **Lightroom's merges store their samples white balanced and through a curve**, and write the
/// `MapPolynomial` per plane that takes them back to camera counts. Skipping it balances the
/// picture twice and renders it magenta.
///
/// Only a polynomial over the whole picture, a sample at a time, which folds into
/// [`linear_table`]; any other opcode the file does not mark optional is refused by name, since
/// rendering without it is a different picture.
fn plane_curves(
    decoder: &dyn rawler::decoders::Decoder,
    width: usize,
    height: usize,
) -> Result<[Vec<f64>; 3], String> {
    let list = decoder
        .ifd(rawler::decoders::WellKnownIFD::Raw)
        .ok()
        .flatten()
        .and_then(|ifd| ifd.get_entry(rawler::tags::DngTag::OpcodeList2).map(|entry| entry.value.clone()));
    match list {
        Some(rawler::formats::tiff::Value::Undefined(bytes)) => opcode_curves(&bytes, width, height),
        _ => Ok(identity_curves()),
    }
}

fn identity_curves() -> [Vec<f64>; 3] {
    std::array::from_fn(|_| vec![0.0, 1.0])
}

/// [`plane_curves`] off the opcode list's own bytes, which DNG writes big-endian whatever the file's
/// byte order.
fn opcode_curves(bytes: &[u8], width: usize, height: usize) -> Result<[Vec<f64>; 3], String> {
    const MAP_POLYNOMIAL: u32 = 8;
    const OPTIONAL: u32 = 1;
    let mut curves = identity_curves();
    let truncated = || "this DNG's OpcodeList2 is truncated".to_string();
    let word = |at: usize| -> Result<u32, String> {
        Ok(u32::from_be_bytes(bytes.get(at..at + 4).ok_or_else(truncated)?.try_into().unwrap()))
    };
    let float = |at: usize| -> Result<f64, String> {
        Ok(f64::from_be_bytes(bytes.get(at..at + 8).ok_or_else(truncated)?.try_into().unwrap()))
    };
    let mut at = 4;
    for _ in 0..word(0)? {
        let (id, flags, size) = (word(at)?, word(at + 8)?, word(at + 12)? as usize);
        let body = at + 16;
        at = body.saturating_add(size);
        if id != MAP_POLYNOMIAL {
            match flags & OPTIONAL {
                0 => return Err(format!("this DNG asks for opcode {id}, which this build does not apply")),
                _ => continue,
            }
        }
        let [top, left, bottom, right, plane, planes, row_pitch, column_pitch, degree] =
            std::array::from_fn(|k| word(body + k * 4));
        let whole = top? == 0
            && left? == 0
            && bottom? as usize >= height
            && right? as usize >= width
            && row_pitch? == 1
            && column_pitch? == 1;
        if !whole {
            return Err("this DNG maps only part of its picture through a polynomial".into());
        }
        let coefficients =
            (0..=degree? as usize).map(|k| float(body + 36 + k * 8)).collect::<Result<Vec<_>, _>>()?;
        let plane = plane? as usize;
        for curve in curves.iter_mut().skip(plane).take(planes? as usize) {
            *curve = coefficients.clone();
        }
    }
    Ok(curves)
}

/// The decode as far as the mosaic, which is as far as a Detail amount is irrelevant.
async fn hold(
    decoder: &dyn rawler::decoders::Decoder,
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
    image: rawler::RawImage,
    upright: rawler::decoders::Orientation,
) -> Option<Held> {
    let mut lap = crate::clock::laps("  decode ");
    let (width, height) = (image.width, image.height);

    let cfa = cfa_of(&image)?;

    let rawler::RawImageData::Integer(samples) = &image.data else {
        return None;
    };
    if samples.len() < width * height {
        return None;
    }

    let gpu = crate::gpu::device();
    let mosaic = condition(gpu, &samples[..width * height], width, height, &image, &cfa)?;

    lap("condition");

    // The sensor's readable area is larger than the picture: there are masked columns for the
    // black level and a few rows the manufacturer does not consider valid. LibRaw hands back the
    // cropped frame, so this must too, or every photograph shifts and every fitted camera match
    // describes a different framing.
    let crop = image
        .crop_area
        .map(|area| (area.p.x, area.p.y, area.d.w, area.d.h))
        .unwrap_or((0, 0, width, height));
    let crop = (crop.0, crop.1, whole_sites(crop.2), whole_sites(crop.3));

    let (aperture, width_mm) = optics_of(decoder, source, params);

    Some(Held {
        mosaic,
        sensor: Sensor {
            width,
            height,
            cfa,
            crop,
            colour: colour_of(&image)?,
            upright,
            as_shot: as_shot_of(gpu?, &image).await,
            aperture,
            width_mm,
        },
    })
}

/// What the lens was stopped down to, and how wide the picture is across the silicon.
///
/// Both come out of the same EXIF parse, which is a second walk of the file's IFDs, so they are
/// asked for together.
///
/// The aperture is zero where the file recorded nothing usable. The width falls back to
/// [`crate::dust::FULL_FRAME_MM`], because the 35mm-equivalent focal length is the only reading of
/// a body's size that crosses makers and plenty of them omit it.
fn optics_of(
    decoder: &dyn rawler::decoders::Decoder,
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
) -> (f32, f32) {
    let Ok(metadata) = decoder.raw_metadata(source, params) else {
        return (0.0, crate::dust::FULL_FRAME_MM);
    };
    let exif = &metadata.exif;
    let rational = |r: &rawler::formats::tiff::Rational| match r.d {
        0 => 0.0,
        d => r.n as f32 / d as f32,
    };

    let stated = exif.fnumber.as_ref().map_or(0.0, rational);
    let aperture = match stated.is_finite() && (0.5..=256.0).contains(&stated) {
        true => stated,
        false => 0.0,
    };

    let focal = exif.focal_length.as_ref().map_or(0.0, rational);
    let equivalent = exif.focal_length_in_35mm.unwrap_or(0) as f32;
    (aperture, width_mm_of(focal, equivalent))
}

/// The picture's width across the silicon, from the two focal lengths whose ratio is the crop
/// factor, or [`crate::dust::FULL_FRAME_MM`] where they do not give one.
///
/// A body that shoots a smaller frame out of a larger sensor reports the equivalent of the *cropped*
/// picture, which is the width the crop is, and so the width that goes with the photosites decoded.
fn width_mm_of(focal: f32, equivalent: f32) -> f32 {
    let crop = match focal > 0.0 && equivalent > 0.0 {
        true => equivalent / focal,
        false => 1.0,
    };
    // Medium format at one end and a phone-sized compact at the other; outside that a body has
    // written one of the two focal lengths in units the other is not in.
    match crop.is_finite() && (0.5..=8.0).contains(&crop) {
        true => crate::dust::FULL_FRAME_MM / crop,
        false => crate::dust::FULL_FRAME_MM,
    }
}

async fn decode_source(
    source: &rawler::rawsource::RawSource,
    detail: crate::galosh::Detail,
    at_least_long_edge: u32,
    force_half: bool,
    fit: crate::galosh::Fit,
    dust: crate::dust::Wanted<'_>,
) -> Option<Frame> {
    let opened = open(source).await.map_err(|why| crate::warn(&format!("rawshim: {why}")));
    match opened.ok()? {
        crate::decode::Held::Mosaic(held) => {
            held.into_frame(detail, at_least_long_edge, force_half, fit, dust, &crate::open_stage::quiet)
                .await
        }
        crate::decode::Held::Rendered(held) => crate::decode::whole(&held, at_least_long_edge).await,
    }
}

impl Held {
    /// This photograph's noise and its capture blur, measured over the whole mosaic and
    /// filtering nothing.
    ///
    /// Whole-frame on purpose, and the same argument `decode_source` already makes about handing a
    /// tile the frame's fit: Phase 0 reduces over everything it is shown, so a region's own
    /// statistics are not the photograph's.
    /// None for a pattern GALOSH does not filter, which is a photograph with no mosaic noise to
    /// report rather than one measured wrong ([`crate::galosh::filters`]).
    pub async fn fit(&self) -> Option<crate::galosh::NoiseFit> {
        let gpu = crate::gpu::device()?;
        let kernels = crate::galosh::device(gpu)?;
        crate::galosh::filters(&self.sensor.cfa).then_some(())?;
        Some(crate::galosh::fit(gpu, kernels, &self.mosaic, &self.sensor.cfa).await)
    }

    pub fn width(&self) -> usize {
        self.sensor.width
    }

    pub fn height(&self) -> usize {
        self.sensor.height
    }

    /// The longest edge of the *picture*, in sensor photosites.
    ///
    /// **Not [`Self::width`]**, which is the readable area - masked columns and invalid rows and
    /// all, trimmed off before anything is demosaiced. What every other caller means by "the
    /// sensor's long edge" is this one: `edit::from_frame` and `job::Base::build` both arrive at it
    /// as the decoded frame's own long edge doubled when the decode halved, and `header::read_path`
    /// answers with `crop_area`. Composing a capture sigma against the readable area instead scales
    /// it by the few dozen masked columns, so a band would re-sharpen the frame at a sigma the open
    /// that produced it never used.
    pub fn picture_long(&self) -> usize {
        let (_, _, width, height) = self.sensor.crop;
        width.max(height)
    }

    /// The conditioned mosaic where it sits on the device, for a probe that wants to watch the
    /// denoise at the mosaic rather than through the demosaic.
    pub fn device_mosaic(&self) -> &crate::condition::Mosaic {
        &self.mosaic
    }

    /// The sensor's 2x2 CFA, row-major, as the demosaic takes it.
    pub fn cfa(&self) -> crate::cfa::Cfa {
        self.sensor.cfa
    }

    /// The picture inside the readable area: `left, top, width, height`.
    pub fn crop(&self) -> (usize, usize, usize, usize) {
        self.sensor.crop
    }

    /// Which way up the file says the picture goes, which the crop above is named before.
    pub fn upright(&self) -> rawler::decoders::Orientation {
        self.sensor.upright
    }

    /// One window of this photograph, cut out of the mosaic rather than decoded again.
    ///
    /// **`decode_tile_source`'s region walk, with the read already done.** The rectangle arrives
    /// in the crop's upright coordinates, becomes a sensor rectangle, is grown by everything that
    /// reads past it and aligned to whole CFA sites - an odd origin would relabel every colour in
    /// it - and then the mosaic is windowed instead of the file being decompressed. Everything
    /// below that is the same sequence: denoise at the photograph's fit, demosaic, colour, crop to
    /// what was asked for, orient.
    ///
    /// This is what a band of a re-prepare is. `tile::Source::Held` reaches it, so a band and a
    /// loupe tile are one path and cannot come to disagree.
    pub async fn window(
        &self,
        tile: crate::Tile,
        scale: crate::view::Scale,
        detail: crate::galosh::Detail,
        fit: crate::galosh::Fit,
        halo: usize,
        dust: crate::dust::Known<'_>,
    ) -> Option<Frame> {
        let gpu = crate::gpu::device();
        let whole = &self.mosaic;
        let Sensor {
            width: frame_w, height: frame_h, cfa, crop, colour, upright, as_shot, ..
        } = self.sensor;
        let (origin, extent) = ((crop.0, crop.1), (crop.2, crop.3));
        let tile = as_sensor_rect(tile, extent.0, extent.1, upright);

        let halo = crate::tile_halo(halo);
        let reach = RCD_MARGIN + halo;
        // **Down to `pass12`'s grid, not merely to a CFA site.** The shrinkage tiles from the
        // region's own origin, so a window that starts off that lattice shrinks every pixel
        // against a different neighbourhood and the band stops being the frame. Costs the few
        // rows it can add to two sides, which are halo either way.
        // And a whole period with it, which the lattice alone only happens to give for a pattern
        // whose period divides it. See `decode_region`'s copy of this.
        let (lattice_x, lattice_y) = crate::galosh::lattice(&cfa);
        let (left, top) = (
            (origin.0 + tile.left).saturating_sub(reach) / lattice_x * lattice_x,
            (origin.1 + tile.top).saturating_sub(reach) / lattice_y * lattice_y,
        );
        let right = (origin.0 + tile.left + tile.width + reach).min(frame_w);
        let bottom = (origin.1 + tile.top + tile.height + reach).min(frame_h);
        // Both extents whole periods as well as both origins: the denoise pairs samples into 2x2
        // sites and refuses a region that does not.
        let (span_w, span_h) = cfa.align_extent(right - left, bottom - top);
        let (right, bottom) = (left + span_w, top + span_h);
        if right <= left || bottom <= top {
            return None;
        }
        let (region_w, region_h) = (right - left, bottom - top);

        // A window of the conditioned mosaic, which is a copy: the denoise writes where it reads,
        // and the photograph has to survive this band and the next.
        let mut mosaic = whole.window(gpu?, left, top, region_w, region_h);
        // The photograph's own particles, offset into this window - never a search of its own,
        // which `Known` leaves no way to ask for and which would find a different set from the
        // bands either side of it.
        crate::dust::apply(gpu?, &mosaic, &dust, (left, top));

        let noise =
            denoise_over(gpu, &mut mosaic, detail, fit, halo, &cfa, colour.ceiling).await;

        let inset = (origin.0 + tile.left - left, origin.1 + tile.top - top);
        let region_crop = (
            inset.0,
            inset.1,
            tile.width.min(region_w - inset.0),
            tile.height.min(region_h - inset.1),
        );
        let (gpu, rcd) = gpu.and_then(|gpu| crate::demosaic::device(gpu).map(|rcd| (gpu, rcd)))?;
        let halving = scale.halves() && region_crop.0 % 2 == 0 && region_crop.1 % 2 == 0 && cfa.is_bayer();
        let built = if halving {
            let crop = (
                region_crop.0 / 2,
                region_crop.1 / 2,
                reduced_span(region_crop.2, 2),
                reduced_span(region_crop.3, 2),
            );
            reduced_into(gpu, rcd, &mosaic, crop, region_w, colour, orientation_code(upright), &cfa)
                .await
        } else {
            demosaic_in_tiles(gpu, rcd, &mosaic, &cfa, region_crop, colour, orientation_code(upright))
                .await
        };
        drop(mosaic);
        let built = built?;
        Some(Frame {
            width: built.width,
            height: built.height,
            pixels: Pixels::Resident(built),
            reduced: if halving { 2 } else { 1 },
            as_shot,
            noise,
            // A window is handed the photograph's list rather than finding one, and its sigma for
            // the same reason.
            dust: None,
            matrix: Some(colour.matrix),
            neutral_ceiling: neutral_ceiling_of(colour.ceiling),
            wb_gains: colour.ceiling,
            stated_white: None,
        })
    }

    /// The frame this mosaic makes at this Detail, filtering a *copy* so this stays pristine.
    ///
    /// For a caller that will ask again at another amount, which is what a Detail slider is.
    pub async fn frame(
        &self,
        detail: crate::galosh::Detail,
        at_least_long_edge: u32,
        fit: crate::galosh::Fit,
        dust: crate::dust::Wanted<'_>,
        report: crate::open_stage::Report<'_>,
    ) -> Option<Frame> {
        let copy = self.mosaic.duplicate(crate::gpu::device()?);
        Held { mosaic: copy, sensor: self.sensor.clone() }
            .into_frame(detail, at_least_long_edge, false, fit, dust, report)
            .await
    }

    /// The same, filtering this mosaic where it lies. For a caller that will not ask twice.
    ///
    /// `force_half` halves whatever the size floor would have allowed, for a caller that asked
    /// for the trade rather than for a size.
    pub async fn into_frame(
        mut self,
        detail: crate::galosh::Detail,
        at_least_long_edge: u32,
        force_half: bool,
        fit: crate::galosh::Fit,
        dust: crate::dust::Wanted<'_>,
        report: crate::open_stage::Report<'_>,
    ) -> Option<Frame> {
        let mut lap = crate::clock::laps("  decode ");
        let gpu = crate::gpu::device();
        let glass = self.sensor.glass();
        let Sensor { width, height, cfa, crop, colour, upright, as_shot, .. } = self.sensor;
        let mosaic = &mut self.mosaic;

        // **Above the denoise, so the shadow is gone before anything tries to preserve it**, and
        // because the detection's own noise floor is the sensor's rather than what a filter left.
        // The whole mosaic, never a window: the gates read this frame's texture floor.
        let mut spots = None;
        if let Some(gpu) = gpu {
            spots = crate::dust::run(gpu, mosaic, &glass, &dust).await;
            if dust.does_anything() {
                lap("dust");
            }
        }
        // **Tiled, and at the halo a loupe takes.** A render assembled from the same regions as the
        // magnifier that predicts it is the same arithmetic rather than two routes that ought to
        // agree, which is the argument `job::Base::build` already makes about handing a tile the
        // frame's fit. It also bounds the GPU: whole-frame RCD is 3.1GB of planes at 61MP.
        //
        // `Fit::Measure` becomes a whole-frame fit and then a tiled denoise against it, which is
        // the same denoise - `open_bench` puts a measured fit against a given one at `worst 0e0`.
        // The fit has to be whole-frame either way, since Phase 0 reduces over everything it is
        // shown and a tile's own statistics are not the photograph's.
        let mut noise = None;
        if let Some(gpu) = gpu {
            let frame = &mut *mosaic;
            if let Some(kernels) =
                crate::galosh::device(gpu).filter(|_| crate::galosh::filters(&cfa))
            {
                let only = matches!(fit, crate::galosh::Fit::Only);
                let brought = matches!(fit, crate::galosh::Fit::Given(_));
                // **Measured ahead of the filtering rather than on its way past**, which
                // `Fit::Only` always wanted and a slider the document leaves unset now needs too:
                // the amount is this frame's own until somebody says otherwise, so there is nothing
                // to filter at until the frame has been measured. A fit the caller brought is the
                // photograph's whatever this decode was asked to do with it, and it is what every
                // loupe tile and every band of a re-prepare is then handed.
                let measured = match fit {
                    crate::galosh::Fit::Given(fit) => Some(fit),
                    _ if only || detail.could_do_anything() => {
                        report(crate::open_stage::Stage::MeasuringNoise);
                        Some(crate::galosh::fit(gpu, kernels, frame, &cfa).await)
                    }
                    _ => None,
                };
                let amounts = detail.amounts(measured);
                noise = match measured {
                    Some(measured) if !only && amounts.does_anything() => {
                        // **A fit this side measured is checked as hard as one crossing the API.**
                        // Every pixel is scaled by these numbers, so a reduction that came back
                        // wrong does not fail - it renders, confidently, in the wrong colours. An
                        // undenoised photograph is a photograph.
                        match brought || measured.usable() {
                            true => {
                                report(crate::open_stage::Stage::Denoising);
                                match detail.denoiser {
                                    crate::galosh::Denoiser::Pmrid => match crate::pmrid::device(gpu)
                                    {
                                        Some(net) => crate::pmrid::denoise(
                                            gpu,
                                            net,
                                            frame,
                                            &cfa,
                                            colour.ceiling,
                                            detail,
                                            measured,
                                        ),
                                        None => crate::warn(
                                            "rawshim: PMRID's weights have not been handed over, \
                                             so this frame was not denoised",
                                        ),
                                    },
                                    crate::galosh::Denoiser::Galosh => {
                                        denoise_in_tiles(
                                            gpu,
                                            kernels,
                                            frame,
                                            &cfa,
                                            amounts,
                                            measured,
                                            crate::RENDITION_TILE_HALO,
                                        )
                                        .await;
                                    }
                                }
                                Some(measured)
                            }
                            false => {
                                crate::warn(&format!(
                                    "rawshim: this frame's noise fit is not one to filter with, so it is not denoised: {measured:?}"
                                ));
                                None
                            }
                        }
                    }
                    other => other,
                };
            }
        }
        // Every way GALOSH can be missed at once - no adapter, no kernels, a mosaic that never
        // reached the device - said where the decode wanted something from it, since a frame that
        // carries no fit and was never filtered is otherwise indistinguishable from one that was.
        declined_galosh(&noise, detail, fit, &cfa);

        lap("denoise");

        // Reduced where the caller said a smaller frame would do, or asked for it outright, which
        // skips the demosaic.
        //
        // **No longer gated on the crop's origin, and that is a consequence of the kernel reading
        // colours rather than assuming them.** The old test was `crop % 2 == 0`, and its reason was
        // colour: a 2x2 block taken from an odd row holds the same four colours in a different
        // arrangement, and a kernel that assigned red from a fixed corner read the one next door.
        // `pixel_of_reduced` asks `colour_at` for every photosite it touches, so the arrangement
        // stops mattering - any 2x2 of a Bayer pattern holds one of each, and any 3x3 of an X-Trans
        // one does too (`every_three_by_three_window_holds_every_colour`).
        //
        // What is left is framing: the origin floors to a whole block, so the picture can start up
        // to `by - 1` photosites above where the crop says. That is two thirds of one pixel of a
        // frame at a third of the sensor, and it is what let this run at all on real files - the
        // X-T3 fixture crops at row 13, which is on no multiple of six, and every Fuji frame would
        // otherwise have taken the demosaic at every size.
        //
        // **The factor is the sensor's and the decision is the caller's.** A Bayer 2x2 holds every
        // colour and an X-Trans 3x3 is the smallest window that does, so a Fuji frame reduces by
        // three - and whether a third of the sensor still serves is a different question from
        // whether half of it would, which is why the divisor is asked for before `would_serve` is.
        //
        // Nothing upstream predicts the answer: this route reports the frame it built and the
        // caller reads its dimensions. The loupe's route cannot say the same - `view::Scale` sizes
        // the window a caller asked for - so that one still takes the demosaic on a 6x6 pattern.
        let by = reduction(&cfa).unwrap_or(1);
        let would_serve =
            at_least_long_edge > 0 && (width.max(height) / by) as u32 >= at_least_long_edge;
        let reduces = by > 1 && (would_serve || force_half);
        report(crate::open_stage::Stage::Demosaicing);

        // **The sensor reads in its own orientation; the photograph has another one.** LibRaw
        // applies this from `sizes.flip` and hands back an upright frame, so this must too - and
        // not only because the picture would be sideways. The camera match is fitted by comparing
        // this frame against the camera's own embedded JPEG, which is always upright, so a frame
        // left in sensor orientation produces a fit against unrelated content and a grade built
        // on it.
        //
        // The turn is part of the write the demosaic's tiles make, so what a tile lands is already
        // where it belongs in the upright frame. Only the reduced path, which skips the demosaic
        // outright, still turns the frame afterwards.
        let built = match reduces {
            true => {
                let (gpu, rcd) =
                    gpu.and_then(|gpu| crate::demosaic::device(gpu).map(|rcd| (gpu, rcd)))?;
                let crop = (
                    crop.0 / by,
                    crop.1 / by,
                    reduced_span(crop.2, by),
                    reduced_span(crop.3, by),
                );
                reduced_into(gpu, rcd, &mosaic, crop, width, colour, orientation_code(upright), &cfa)
                    .await?
            }
            false => {
                let (gpu, rcd) =
                    gpu.and_then(|gpu| crate::demosaic::device(gpu).map(|rcd| (gpu, rcd)))?;
                demosaic_in_tiles(gpu, rcd, &mosaic, &cfa, crop, colour, orientation_code(upright))
                    .await?
            }
        };

        lap("demosaic, colour, crop, orient");

        Some(Frame {
            width: built.width,
            height: built.height,
            pixels: Pixels::Resident(built),
            reduced: match reduces {
                true => by,
                false => 1,
            },
            as_shot,
            noise,
            dust: spots,
            matrix: Some(colour.matrix),
            neutral_ceiling: neutral_ceiling_of(colour.ceiling),
            wb_gains: colour.ceiling,
            stated_white: None,
        })
    }
}

/// How wide a tile the denoise and the demosaic are cut into, for a whole frame as much as for a
/// loupe.
///
/// **Measured against the halo rather than chosen.** Over a 61MP frame the whole 16-to-64 halo
/// range costs 9% at this size and 37% at 512, so a large tile is what makes a generous halo
/// affordable; and 2048 at halo 32 is cheaper than 512 at any halo at all. Smaller than this buys
/// only finer progressive updates, which is a latency question and not this module's.
pub const RENDER_TILE: usize = 2048;

/// Where the tiles fall along one axis, as `(start, end)` pairs.
///
/// **Split evenly rather than into whole `RENDER_TILE`s, so that no strip is a few pixels wide.**
/// The demosaic declines a window narrower than twice its own margin, and a loupe names an
/// arbitrary rectangle - a tile 2049 pixels across would leave a one-pixel column and take the
/// whole decode down with it. The boundaries are free to move: each tile is computed with the halo
/// its stage reads through, so where they fall does not change the answer.
fn spans(total: usize) -> impl Iterator<Item = (usize, usize)> {
    let count = total.div_ceil(RENDER_TILE).max(1);
    let step = total.div_ceil(count);
    (0..count).map(move |at| (at * step, ((at + 1) * step).min(total)))
}

/// What a region decode does about its noise: measure it, filter with it, or both.
///
/// **Which filter is the document's, and the measurement is not.** Both denoisers are driven by the
/// same fit - GALOSH filters on it, PMRID converts it into the anchor its weights were trained at -
/// so the choice reaches only as far as the filtering itself. `gains` are the conditioning's own,
/// which only PMRID needs.
async fn denoise_over(
    gpu: Option<&'static crate::gpu::Gpu>,
    mosaic: &mut crate::condition::Mosaic,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    halo: usize,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
) -> Option<crate::galosh::NoiseFit> {
    let mut noise = None;
    let only = matches!(fit, crate::galosh::Fit::Only);
    let brought = matches!(fit, crate::galosh::Fit::Given(_));
    // **Tiled inside the region, once the region is worth tiling.** A loupe window is not the size
    // of the glass - it is grown by the reach of everything after the gather - so the region
    // reaches the size at which whole-region RCD is gigabytes of planes. Safe within a grown region
    // because the tiles' halos read real mosaic either side of every interior seam, and the band at
    // the region's own edge is the halo the crop discards. Below one tile the machinery would cut
    // one tile and copy it twice, so that stays the single pass it has always been.
    let tiled = mosaic.width > RENDER_TILE || mosaic.height > RENDER_TILE;
    if let Some(gpu) = gpu {
        let denoises = (only || detail.could_do_anything()) && crate::galosh::filters(cfa);
        if let Some(kernels) = crate::galosh::device(gpu).filter(|_| denoises) {
            // **The frame's fit, where the caller had one.** Every whole-region reduction in Phase
            // 0 and Phase 2 measures this crop rather than the photograph, and a crop is not a
            // sample of the frame: measured on the fixtures, a 512px tile fitted between 0.49 and
            // 1.51 times its own frame's noise, which is the strength it is then denoised at. So a
            // loupe disagreed with the export it exists to predict, and moved as the reader panned.
            let network = detail.denoiser == crate::galosh::Denoiser::Pmrid;
            let measured = match fit {
                crate::galosh::Fit::Given(fit) => Some(fit),
                // A tile fitting itself is the case above's cost, not its correctness: it is what a
                // caller with no frame's fit to hand back gets, and it is what the numbers describe.
                // Measured by the one filtering run below rather than by a pass of its own.
                //
                // Only GALOSH can fold the measurement into its filtering: PMRID needs the numbers
                // before it reads a photosite, since what they scale is its input.
                _ if !only && !tiled && !detail.needs_a_fit() && !network => None,
                // Tiled, the fit has to be taken over the whole region first: measured inside the
                // filtering run it would be each tile's own statistics, which is the disagreement
                // above at a smaller scale and against itself. An unset slider needs it ahead of
                // the filtering for a second reason: it has no number until the frame is measured.
                _ => Some(crate::galosh::fit(gpu, kernels, mosaic, cfa).await),
            };
            let amounts = detail.amounts(measured);
            noise = match (measured, tiled) {
                _ if only || !amounts.does_anything() => measured,
                // **A fit this side measured is checked as hard as one crossing the API.** Every
                // pixel is scaled by these numbers, so a reduction that came back wrong does not
                // fail - it renders, confidently, in the wrong colours. An undenoised photograph is
                // a photograph.
                (Some(fit), _) if !brought && !fit.usable() => {
                    crate::warn(&format!(
                        "rawshim: this frame's noise fit is not one to filter with, so it is not denoised: {fit:?}"
                    ));
                    None
                }
                // The network tiles itself, and with a halo of its own, so the region's is not
                // used: what a tile of it needs on every side is the reach of four halvings rather
                // than of a kernel.
                (Some(fit), _) if network => match crate::pmrid::device(gpu) {
                    Some(net) => {
                        crate::pmrid::denoise(gpu, net, mosaic, cfa, gains, detail, fit);
                        Some(fit)
                    }
                    // A page that asked for the network before handing over what it fetched. Said
                    // here rather than left to the line below, which would name GALOSH and send a
                    // reader looking at the wrong filter.
                    None => {
                        crate::warn(
                            "rawshim: PMRID's weights have not been handed over, so this frame was \
                             not denoised",
                        );
                        None
                    }
                },
                (Some(fit), true) => {
                    denoise_in_tiles(gpu, kernels, mosaic, cfa, amounts, fit, halo).await;
                    Some(fit)
                }
                (Some(fit), false) => {
                    Some(crate::galosh::denoise_with(gpu, kernels, mosaic, cfa, amounts, fit).await)
                }
                (None, _) => Some(crate::galosh::denoise(gpu, kernels, mosaic, cfa, amounts).await),
            };
        }
    }
    declined_galosh(&noise, detail, fit, cfa);
    noise
}

/// Says so where a decode asked GALOSH for something and got nothing.
///
/// A decode that filters nothing measures nothing, so `None` is the ordinary answer for most
/// callers and only means a decline when the caller wanted the fit or asked for an amount.
fn declined_galosh(
    noise: &Option<crate::galosh::NoiseFit>,
    detail: crate::galosh::Detail,
    fit: crate::galosh::Fit,
    cfa: &crate::cfa::Cfa,
) {
    let wanted = matches!(fit, crate::galosh::Fit::Only) || detail.could_do_anything();
    if !wanted || noise.is_some() {
        return;
    }
    // **Two reasons, and only one of them is a fault.** No adapter is a frame that should have been
    // denoised and was not, which is what the browser's own spec watches this line for. A pattern
    // GALOSH has no colour to separate is the documented answer for that sensor, and saying so in
    // the same words would teach a reader - and that spec - to ignore the one that matters.
    match crate::galosh::filters(cfa) {
        true => crate::warn(
            "rawshim: no GPU for GALOSH, so this frame carries no noise fit and was not denoised",
        ),
        false => crate::warn(
            "rawshim: this sensor's pattern is not one GALOSH filters, so the frame carries no \
             noise fit and was not denoised",
        ),
    }
}

/// The mosaic denoise, tile by tile, at the halo this caller grew its region by.
async fn denoise_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    kernels: &'static crate::galosh::Galosh,
    mosaic: &mut crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::NoiseFit,
    halo: usize,
) {
    // `galosh`'s own, which rounds each region's origin to the shrinkage's grid. This had the same
    // geometry without that rounding, and so denoised every rendition against a neighbourhood the
    // whole-frame answer never uses - `pass12` shrinks inside a tile indexed from the region
    // origin, so a region off the grid shifts the tiling under every pixel in it.
    crate::galosh::denoise_in_tiles(
        gpu, kernels, mosaic, cfa, amounts, fit, halo, RENDER_TILE, |_| {},
    )
    .await;
}

/// A tile's extent at half resolution, which is never none where it was something.
///
/// **A pixel that halves to nothing takes the render down with it.** The extents are whole pixels,
/// so a one-pixel tile floors to zero, and an empty crop reaches `Placement::oriented_rect` as an
/// empty frame where `frame_w - 1` underflows. A panorama is where a one-pixel tile is ordinary
/// rather than strange: a source can clip the window being composited by a single column, and the
/// footprint that finds it is right to say the source is there.
fn reduced_span(of: usize, by: usize) -> usize {
    match of {
        0 => 0,
        _ => (of / by.max(1)).max(1),
    }
}

/// The reduced frame, upright, off the mosaic where it already is.
///
/// Tiled for the *turn* rather than for a halo, which this route has none of - a block is read by
/// the one output pixel it becomes. A sensor's orientation is usually a quarter turn, and then a
/// row of the destination is a column of the mosaic: untiled, every lane of a wave lands on its own
/// cache line, and 61MP costs 1409ms against 860ms.
#[allow(clippy::too_many_arguments)]
async fn reduced_into(
    gpu: &'static crate::gpu::Gpu,
    rcd: &'static crate::demosaic::Rcd,
    mosaic: &crate::condition::Mosaic,
    crop: (usize, usize, usize, usize),
    stride: usize,
    colour: crate::demosaic::Colour,
    orientation: u32,
    cfa: &crate::cfa::Cfa,
) -> Option<crate::resident::Resident> {
    let (crop_left, crop_top, crop_w, crop_h) = crop;
    let reduce = reduction(cfa)? as u32;
    // Once for the region, not once per tile: `demosaic::shape_group` says what that measured.
    let (_shape, shape_group) = crate::demosaic::shape_group(gpu, rcd, cfa, mosaic, 0);
    let placed = |dest: (usize, usize), inner: (usize, usize, usize, usize)| {
        crate::demosaic::Placement {
            stride: crate::px::Span::exact(stride),
            crop: crate::px::Rect::exact(inner.0, inner.1, inner.2, inner.3),
            dest: crate::px::At::exact(dest.0, dest.1),
            frame: crate::px::Size::exact(crop_w, crop_h),
            orientation,
            reduce,
        }
    };
    let (out_w, out_h) = placed((0, 0), (0, 0, 1, 1)).out();
    let frame = crate::resident::Resident::empty(gpu, out_w, out_h);
    for (ty0, ty1) in spans(crop_h) {
        for (tx0, tx1) in spans(crop_w) {
            let at = placed((tx0, ty0), (crop_left + tx0, crop_top + ty0, tx1 - tx0, ty1 - ty0));
            crate::demosaic::reduce_into(
                gpu,
                rcd,
                mosaic,
                &at,
                colour,
                frame.buffer(),
                &shape_group,
            )
            .await?;
        }
    }
    Some(frame)
}

/// Photosites a side in the smallest block of this pattern that holds every colour, which is the
/// factor a frame skipping the demosaic reduces by.
///
/// **2 and 3 rather than one number, because the two patterns differ in exactly this.** A Bayer 2x2
/// carries a red, a blue and two greens; no 2x2 of a 6x6 carries all three, and X-Trans's smallest
/// window that does is the 3x3 - which every one of them is
/// (`every_three_by_three_window_holds_every_colour`). None for a pattern with no such block, which
/// takes the demosaic at every size.
pub fn reduction(cfa: &crate::cfa::Cfa) -> Option<usize> {
    if cfa.is_bayer() {
        return Some(2);
    }
    cfa.is_xtrans().then_some(3)
}

/// The demosaic and the colour transform, tile by tile, straight into the cropped frame.
///
/// Tiled over the *crop* rather than the sensor, since that is the frame being built; the region
/// each tile needs is that rectangle in sensor coordinates grown by RCD's own margin. Whole-frame
/// RCD holds thirteen planes at once - 3.1GB at 61MP - which is the allocation this removes.
async fn demosaic_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    rcd: &'static crate::demosaic::Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    crop: (usize, usize, usize, usize),
    colour: crate::demosaic::Colour,
    orientation: u32,
) -> Option<crate::resident::Resident> {
    demosaic_settled_in_tiles(gpu, rcd, mosaic, cfa, crop, colour, orientation, &|_, _, _| ()).await
}

/// A tile's RCD plane, and the rectangle of the mosaic it covers as `(left, top, width, height)`.
type Settle<'a> = dyn Fn(&mut crate::gpu::Recording<'static>, &crate::gpu::Buffer, (usize, usize, usize, usize)) + 'a;

/// [`demosaic_in_tiles`], with each tile's plane handed to `settle` before it is coloured
/// (`demosaic::demosaic_settled_into`).
#[allow(clippy::too_many_arguments)]
async fn demosaic_settled_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    rcd: &'static crate::demosaic::Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    crop: (usize, usize, usize, usize),
    colour: crate::demosaic::Colour,
    orientation: u32,
    settle: &Settle<'_>,
) -> Option<crate::resident::Resident> {
    let (width, height) = (mosaic.width, mosaic.height);
    let (crop_left, crop_top, crop_w, crop_h) = crop;

    // One buffer for the whole upright frame, written into by every tile and handed on where it is.
    // The stitch and the quarter turn were both host passes over the frame before this - 366MB of
    // allocation each at 61MP, and the turn single-threaded.
    let placed = |dest: (usize, usize), inner: (usize, usize, usize, usize), stride: usize| {
        crate::demosaic::Placement {
            stride: crate::px::Span::exact(stride),
            crop: crate::px::Rect::exact(inner.0, inner.1, inner.2, inner.3),
            dest: crate::px::At::exact(dest.0, dest.1),
            frame: crate::px::Size::exact(crop_w, crop_h),
            orientation,
            // The demosaic has already turned every block into a pixel; this route reads its plane
            // one sample at a time.
            reduce: 1,
        }
    };
    let (out_w, out_h) = placed((0, 0), (0, 0, 1, 1), 1).out();
    let frame = crate::resident::Resident::empty(gpu, out_w, out_h);

    for (ty0, ty1) in spans(crop_h) {
        for (tx0, tx1) in spans(crop_w) {
            // **Grown in the sensor's coordinates and clamped to the sensor, not to the crop.**
            // The crop is inset from the readable area, so there is real mosaic outside it, and
            // the whole-frame demosaic this replaces read that: it ran over everything and was
            // cropped afterwards. Clamping the halo to the crop instead border-fills the frame's
            // own edge, which came out as the first six samples of a pinned render moving and
            // nothing else in the row.
            let (sx0, sy0) = (crop_left + tx0, crop_top + ty0);
            let (sx1, sy1) = (crop_left + tx1, crop_top + ty1);
            let (period_w, period_h) = cfa.period();
            let (left, top) = cfa.align_origin(
                sx0.saturating_sub(RCD_MARGIN),
                sy0.saturating_sub(RCD_MARGIN),
            );
            // **Rounded out to a whole period, never in.** The origin is aligned down to a whole CFA
            // site, so the far edge has to move to keep the extent a whole number of them - and
            // trimming it is a pixel off the margin, which on a boundary inside a site leaves the
            // demosaic nine pixels of context where it reads ten and border-extends the last column.
            // That is one seam, worth nothing to a mean and thousands of counts on an edge. Only at
            // the field's own edge does the clamp below take it back, and there the trimmed pixel is
            // outside the picture anyway.
            let right = (sx1 + RCD_MARGIN).next_multiple_of(period_w).min(width);
            let bottom = (sy1 + RCD_MARGIN).next_multiple_of(period_h).min(height);
            let (span_w, span_h) = cfa.align_extent(right - left, bottom - top);
            let (right, bottom) = (left + span_w, top + span_h);
            if right <= left || bottom <= top {
                continue;
            }
            let (region_w, region_h) = (right - left, bottom - top);

            let window = mosaic.window(gpu, left, top, region_w, region_h);
            // Where this tile sits inside its own region, which is where the halo ends.
            let inner = (
                sx0 - left,
                sy0 - top,
                (sx1 - sx0).min(region_w - (sx0 - left)),
                (sy1 - sy0).min(region_h - (sy0 - top)),
            );
            let at = placed((tx0, ty0), inner, region_w);
            // Per tile here, unlike the reduced route: each tile cuts its own window out of the
            // mosaic, so the group binds a different buffer every time and there is nothing to
            // hoist. The seven dispatches that follow hide the allocation.
            let (_shape, shape_group) =
                crate::demosaic::shape_group(gpu, rcd, cfa, &window, crate::demosaic::MARGIN);
            crate::demosaic::demosaic_settled_into(
                gpu,
                rcd,
                &window,
                cfa,
                &at,
                colour,
                frame.buffer(),
                &shape_group,
                |recording, rgb| settle(recording, rgb, (left, top, region_w, region_h)),
            )
            .await?;
        }
    }
    Some(frame)
}

/// How far past a tile the pipeline reads, in sensor pixels.
const RCD_MARGIN: usize = crate::demosaic::MARGIN as usize;

/// An extent cut back to whole CFA sites.
///
/// **A half site at the far edge has nothing to reconstruct from.** The demosaic reads 2x2, and the
/// region grown around the last tile is rounded back to an even extent so its own origin stays on a
/// site - so where the readable area is an odd number of pixels across, that final column falls
/// outside every tile's inner rectangle and is never written. It came back black, in a frame that
/// claimed to be a pixel wider than it had reconstructed. Trimmed here instead, so the frame is one
/// line smaller and entirely a picture.
///
/// Only the extent moves; the origin does not, so the framing a camera match is fitted against is
/// the framing it always was. Sensors that declare a `crop_area` are almost all even already and
/// nothing about them changes.
fn whole_sites(extent: usize) -> usize {
    extent & !1
}

/// **From the metadata, not from `RawImage::orientation`.** That field exists but the decoders here
/// leave it `Normal` even for a frame shot in portrait; the EXIF tag is where the answer actually
/// is. Reading the wrong one leaves every upright photograph on its side.
fn upright_of(
    decoder: &dyn rawler::decoders::Decoder,
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
) -> rawler::decoders::Orientation {
    decoder
        .raw_metadata(source, params)
        .ok()
        .and_then(|meta| meta.exif.orientation)
        .map_or(rawler::decoders::Orientation::Normal, rawler::decoders::Orientation::from_u16)
}

/// The sensor's pattern, as its own period rather than as a 2x2.
///
/// None for a pattern `crate::cfa` cannot carry - an RGBW or CMYG sensor - and None for a body whose
/// samples the pattern does not describe, which is the whole of [`staggered`] below. A decode that
/// stops here reads nothing, rather than rendering a picture in the wrong colours.
fn cfa_of(image: &rawler::RawImage) -> Option<crate::cfa::Cfa> {
    if staggered(&image.camera) {
        return None;
    }
    crate::cfa::Cfa::from_rawler(&image.camera.cfa)
}

/// Fujifilm's SuperCCD and EXR bodies, whose photosites sit on a 45-degree lattice.
///
/// **The pattern these files name is true of the sensor and false of the samples.** rawler rotates
/// the octagonal array into a rectangle before handing it over (`raf.rs`, `rotate_image`), and says
/// in the same breath that describing the result would need rectangular patterns like 2x4 - so the
/// 2x2 the camera table carries no longer says which colour any sample is. Nothing downstream can
/// notice: every stage would run, and the picture would come out in the wrong colours with the right
/// shape. Refused by name instead.
///
/// `double_width` is the other half of the same family: those bodies record a second, darker frame
/// beside the first, and rawler keeps only one of the pair.
fn staggered(camera: &rawler::decoders::Camera) -> bool {
    camera.find_hint("fuji_rotation")
        || camera.find_hint("fuji_rotation_alt")
        || camera.find_hint("double_width")
}

/// Black subtracted, normalised by the sensor's saturation, and white balanced, into the roughly
/// unit interval the demosaic's specification asks for.
///
/// **Black first, then white balance, then the demosaic.** The order is not free. The directional
/// statistic in RCD is built to be blind to a per-channel gain, so it does not care either way, but
/// the colour-difference stages assume the difference between a chroma channel and green is locally
/// smooth - and before white balance green sits about twice as high as red and blue, so that
/// difference carries the imbalance rather than the scene.
///
/// `samples` may be a region lifted out of the frame rather than the frame, in which case its origin
/// has to sit on a whole CFA site or every colour in it is relabelled.
///
/// On the GPU, which is where the halving is: the samples go up packed `u16` where the mosaic they
/// become is `f32`, 120MB against 241MB at 61MP. The kernel reads [`conditioned`] through the table
/// [`curve`] builds from it, so the arithmetic is written once, and
/// `the_kernel_conditions_every_sample_at_its_own_position` holds the kernel to that table.
/// `condition.rs` says what it costs on a server, which is more than the CPU and nothing the open
/// can measure.
/// None where no adapter answered, which is a decode that reads nothing rather than one that reads
/// a second arithmetic (DESIGN 2.1). The caller says so; this only declines.
fn condition(
    gpu: Option<&'static crate::gpu::Gpu>,
    samples: &[u16],
    width: usize,
    height: usize,
    image: &rawler::RawImage,
    cfa: &crate::cfa::Cfa,
) -> Option<crate::condition::Mosaic> {
    let levels = Levels {
        black: per_position_black(image, cfa),
        white: saturation_of(image),
        gains: white_balance_gains(image),
    };
    let gpu = gpu?;
    let curve = curve(cfa, &levels);
    crate::condition::normalise(gpu, crate::condition::device(gpu), samples, width, height, &curve)
}

/// What the file says about where the signal sits, read once for the frame.
struct Levels {
    /// By position in the period, not by colour. See `per_position_black`.
    black: Vec<f32>,
    white: f32,
    /// By colour, which is what a pattern's greens share however many of them there are.
    gains: [f32; 4],
}

/// What the arithmetic varies by at one position: where the photosite's signal starts, how far it
/// runs, and what the white balance multiplies it by.
///
/// **Black by position and the gain by colour, which is not an inconsistency:** black is a property
/// of the photosite and a Bayer sensor's two greens have their own, while the white balance is a
/// property of the colour and they share it. Resolving the gain onto a position here is what lets
/// the shader work without a CFA of its own.
///
/// Compared bitwise rather than approximately, which is what makes the deduplication in [`curve`]
/// safe: two positions collapse only where their arithmetic is the same arithmetic.
#[derive(Clone, Copy, PartialEq)]
struct Coefficients {
    floor: f32,
    range: f32,
    gain: f32,
}

impl Coefficients {
    fn at(position: usize, cfa: &crate::cfa::Cfa, levels: &Levels) -> Self {
        let floor = levels.black.get(position).copied().unwrap_or(0.0);
        Self {
            floor,
            range: (levels.white - floor).max(1.0),
            gain: levels.gains[usize::from(cfa.colour_of_slot(position)).min(3)],
        }
    }

    fn same(&self, other: &Self) -> bool {
        self.floor.to_bits() == other.floor.to_bits()
            && self.range.to_bits() == other.range.to_bits()
            && self.gain.to_bits() == other.gain.to_bits()
    }
}

/// One sample conditioned, and the only place the arithmetic is written.
///
/// **Not floored at black.** Read noise straddles the black level, so a floor keeps the upper half
/// of it and lifts every dark channel by a share of its own noise - which the white balance then
/// multiplies, putting a purple cast on a high-ISO shadow. Light is clipped below only at the gamut
/// step, where all three channels exist at once.
///
/// **Clipped at saturation ahead of the gain, which is where the photosite's own information
/// stops.** The gain is a statement about the light rather than about the sensor, so a ceiling
/// applied on the far side of it cuts every channel off at the *least* amplified channel's
/// saturation instead of at its own: on a night frame carrying a blue gain of 1.99 that is a full
/// stop of unsaturated blue discarded, and a magenta light renders white. What genuinely did
/// saturate is reconstructed in `assemble.slang`, where all three channels exist at once and a
/// blown pixel can be told from a clipped channel.
#[inline]
fn conditioned(sample: u16, at: Coefficients) -> f32 {
    let filled = ((f32::from(sample) - at.floor) / at.range).min(1.0);
    filled * at.gain
}

/// What [`conditioned`] answers for every level the sensor can report, at each distinct slot of the
/// pattern, which is the whole domain of the conditioning.
///
/// **The kernel reads this rather than evaluating the expression, and that is not an
/// optimisation.** Vulkan requires only 2.5 ULP of `OpFDiv` and RADV takes it, lowering the divide
/// to a reciprocal and a multiply - measured, the shader's own arithmetic disagreed with this in
/// the last bit. Tabulating the domain leaves one spelling rather than two to hold together.
///
/// **Deduplicated, which is what keeps a 6x6 pattern affordable.** A run is 65536 floats, and
/// writing one per position would be 9.4MB for X-Trans against Bayer's 1MB - uploaded for every
/// tile of every decode. What the arithmetic actually varies by is [`Coefficients`], and a sensor
/// has far fewer of those than positions: X-Trans reports a single black level repeated 36 times,
/// so its 36 positions collapse onto three runs, one per colour. Bayer's four are untouched where
/// its greens differ and collapse where they do not.
fn curve(cfa: &crate::cfa::Cfa, levels: &Levels) -> crate::condition::Curve {
    let mut distinct: Vec<Coefficients> = Vec::new();
    let mut slot_of = Vec::with_capacity(cfa.slots());
    for position in 0..cfa.slots() {
        let here = Coefficients::at(position, cfa, levels);
        let slot = match distinct.iter().position(|seen| seen.same(&here)) {
            Some(slot) => slot,
            None => {
                distinct.push(here);
                distinct.len() - 1
            }
        };
        slot_of.push(slot as u32);
    }

    let values = distinct
        .iter()
        .flat_map(|&at| (0..=u16::MAX).map(move |sample| conditioned(sample, at)))
        .collect();
    crate::condition::Curve { values, slot_of, period: cfa.period() }
}

/// The black level of each position in the period, in sensor counts.
///
/// **By position, not by colour, and that distinction is the whole reason this exists.** A Bayer
/// sensor reports four and they are not equal; the two greens in particular can differ by enough to
/// leave a visible checkerboard. Indexing by colour cannot hold that, because the two greens are one
/// colour - it keeps whichever of them is written last and subtracts it from both.
///
/// A file reporting one level for the whole sensor - which is what the X-Trans fixture does, 36
/// copies of the same number - spreads it over every position, and [`curve`] then collapses them
/// back to one run per colour.
fn per_position_black(image: &rawler::RawImage, cfa: &crate::cfa::Cfa) -> Vec<f32> {
    let levels = &image.blacklevel.levels;
    (0..cfa.slots())
        .map(|position| match levels.len() >= cfa.slots() {
            true => levels[position].as_f32(),
            false => levels.first().map_or(0.0, |first| first.as_f32()),
        })
        .collect()
}

/// Whether this make's stated level is the sensor's own saturation.
fn stated_only(image: &rawler::RawImage) -> bool {
    !image.clean_make.eq_ignore_ascii_case("canon")
}

/// Set by the comparison harness to render the stated level and the sensor's cap from one process,
/// which is the only way to search a frame for where the choice between them matters.
static STATED_WHITE_LEVEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn use_stated_white_level(on: bool) {
    STATED_WHITE_LEVEL.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The largest value this sensor can report, in raw counts.
///
/// **The one place a white level is decided**, and everything that needs one asks here: the whole
/// frame, a region decode, and any probe that wants to say how much of a frame is blown. Nothing
/// reads `whitelevel` for itself, because the answer is a policy per make rather than a field.
///
/// `conditioned` clips against this, and `assemble.slang` calls a channel saturated by where that
/// clip put it, so this figure decides which pixels are treated as blown. Hand back a level above
/// where the sensor really saturates and nothing ever reads as blown, so a blown pixel keeps the
/// gains' own ratios and the highlight takes their hue - which is what a sun renders pink.
///
/// **Canon's `SpecularWhiteLevel` is conservative by enough to cost picture**, so it is rounded up
/// to the ADC's own width. An R8 states 14888 and its data runs to 16383, the full 14 bits; every
/// photosite between the two is real signal the clip flattens into one value and the
/// reconstruction then reads as blown, so bright water loses its foam. That is a tenth of a stop
/// of headroom and it is visible.
///
/// **Rounded up rather than read off the data**, which is what keeps a tile agreeing with the
/// render it is magnifying: the largest sample present is a property of the frame, so a corner
/// holding no highlight would be scaled differently from the picture around it. The next power of
/// two is a property of the camera, and every crop of one photograph gets the same one.
///
/// Not `image.bps`, which cannot say this: rawler's is `real_bps`, defaulted to 16 and set only by
/// the DNG and NEF decoders, so a CR3 reports 16 and the ceiling comes back 65535 - four times the
/// sensor's own, and far enough above it that nothing ever clips.
///
/// **Sony's is not rounded, and is left alone.** An A7CR states 15360 against the same 14-bit
/// ceiling: a fifteenth of a stop, and although 4.4% of a frame exceeds it, none of that is
/// highlight worth recovering - searched for specifically, the regions where raising the level
/// changes anything are shadows, where it changes the noise. Taking the data's word there buys
/// pixel noise and nothing else, so the file's figure is better trusted.
pub fn saturation_of(image: &rawler::RawImage) -> f32 {
    let reported = image.whitelevel.0.iter().copied().max().unwrap_or(65535) as u16;
    // The seam the pictures in the log were compared with, and the only way to render both
    // choices from one process.
    let stated = stated_only(image)
        || STATED_WHITE_LEVEL.load(std::sync::atomic::Ordering::Relaxed)
        || std::env::var("BOWERBIRD_WHITE_LEVEL").is_ok_and(|value| value == "stated");
    if stated {
        return f32::from(reported);
    }
    f32::from(adc_ceiling(reported))
}

/// A stated level rounded up to the width of the converter that produced it.
fn adc_ceiling(stated: u16) -> u16 {
    // `max` because a level that is already a power of two rounds to just below itself.
    stated.checked_next_power_of_two().map_or(u16::MAX, |n| n - 1).max(stated)
}

/// Per-channel gains, scaled so the largest of them is unity.
///
/// **On the largest, so that the mosaic fits the unit interval §2.2 asks for while every channel
/// keeps its own ceiling.** `conditioned` clips a photosite at saturation and then gains it, so
/// channel `c` tops out at `gains[c]` - the level its own silicon stopped at, which is what a
/// highlight's colour is carried in. Normalised on the smallest instead, the most amplified channel
/// would need to reach `gains[c] / gains[min]` and the container has nowhere to put it.
///
/// These double as the ceilings `assemble.slang` reads: a channel sitting on its own says that
/// photosite saturated, and a pixel whose three all do is the only kind with no colour left.
fn white_balance_gains(image: &rawler::RawImage) -> [f32; 4] {
    scaled_gains(image.wb_coeffs)
}

/// The arithmetic of the above, off the coefficients alone.
fn scaled_gains(wb: [f32; 4]) -> [f32; 4] {
    let usable = |c: f32| c.is_finite() && c > 0.0;
    let largest = wb.iter().copied().filter(|c| usable(*c)).fold(0.0f32, f32::max);
    let scale = if usable(largest) { largest } else { 1.0 };
    let mut out = [1f32; 4];
    for (channel, slot) in out.iter_mut().enumerate() {
        let coefficient = wb[channel.min(3)];
        *slot = if usable(coefficient) { coefficient / scale } else { 1.0 };
    }
    out
}

/// The ceilings `assemble.slang` tests a demosaiced pixel against, by colour.
///
/// The same numbers [`white_balance_gains`] resolves onto a CFA position, read out as R, G and B -
/// which is the shape the shader wants, having no CFA of its own by the time the plane is
/// interleaved.
pub fn channel_ceilings(image: &rawler::RawImage) -> [f32; 3] {
    let gains = white_balance_gains(image);
    [gains[0], gains[1], gains[2]]
}

/// Both halves of what the demosaic's colour pass needs, read off the file together.
///
/// None where the camera matrix is singular, which is a file that cannot be rendered at all.
fn colour_of(image: &rawler::RawImage) -> Option<crate::demosaic::Colour> {
    Some(crate::demosaic::Colour {
        matrix: camera_to_rec2020(image)?,
        ceiling: channel_ceilings(image),
    })
}

/// The lowest of those, which is [`crate::frame::Frame::neutral_ceiling`]: the level a neutral
/// clips at, since it clips as soon as any one of its channels does.
fn neutral_ceiling_of(ceiling: [f32; 3]) -> f32 {
    ceiling.iter().copied().fold(f32::INFINITY, f32::min)
}

/// The camera's XYZ matrix, as three rows of three.
///
/// **Not `xyz_to_cam`, which is dead.** That field is marked deprecated in rawler and comes back
/// all zeros for at least the Canon bodies here, which makes `cam_to_xyz_normalized` return NaN
/// and every pixel black. The live data is `color_matrix`, a flat row-major matrix per illuminant.
fn xyz_to_cam_of(image: &rawler::RawImage) -> Option<[[f32; 3]; 4]> {
    // D65 to agree with LibRaw, which references its `cam_xyz` to daylight, and by the enum's
    // ordering rather than the map's when there is no D65: `color_matrix` is a `HashMap` and its
    // iteration order is seeded per process, so taking whatever came first made the decode differ
    // between runs of the same binary on the same file.
    let illuminant = image
        .color_matrix
        .keys()
        .copied()
        .find(|i| *i == rawler::imgop::xyz::Illuminant::D65)
        .or_else(|| image.color_matrix.keys().copied().min_by_key(|i| *i as u16))?;
    let flat = image.color_matrix.get(&illuminant)?;
    if flat.len() < 9 || flat.len() % 3 != 0 {
        return None;
    }
    let mut out = [[0f32; 3]; 4];
    for row in 0..(flat.len() / 3).min(4) {
        for col in 0..3 {
            out[row][col] = flat[row * 3 + col];
        }
    }
    Some(out)
}

/// Camera native primaries to linear Rec.2020.
///
/// **The rows are normalised in sRGB, and moving that step is a colour cast.** A camera matrix has
/// an arbitrary per-row scale and something has to pin it; normalising `xyz_to_cam` where it stands
/// pins camera (1,1,1) to XYZ (1,1,1), which is not a colour anyone means by white - D65 is about
/// (0.9505, 1.0, 1.0890) - and the difference is a per-channel gain the white balance does not
/// undo. dcraw's `cam_xyz_coeff` multiplies through `xyz_rgb` first for exactly this reason, and
/// `xyz_rgb` there is sRGB's matrix whatever `output_color` eventually asks for. sRGB rather than
/// the Rec.2020 this returns, then, because every camera match ever fitted is against a frame that
/// came out of `cam_xyz_coeff`.
pub fn camera_to_rec2020(image: &rawler::RawImage) -> Option<[[f32; 3]; 3]> {
    camera_to_rec2020_from(xyz_to_cam_of(image)?)
}

/// [`camera_to_rec2020`] off a file's tags, without decoding a photosite.
pub fn camera_to_rec2020_at(path: &str) -> Option<[[f32; 3]; 3]> {
    let source = rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let image = decoder
        .raw_image(&source, &rawler::decoders::RawDecodeParams::default(), true)
        .ok()?;
    camera_to_rec2020(&image)
}

fn camera_to_rec2020_from(xyz_to_cam: [[f32; 3]; 4]) -> Option<[[f32; 3]; 3]> {
    // Camera from sRGB: how much of each camera channel an sRGB primary excites.
    let mut cam_from_srgb = [[0f64; 3]; 3];
    for (row, slot) in cam_from_srgb.iter_mut().enumerate() {
        for (col, cell) in slot.iter_mut().enumerate() {
            for k in 0..3 {
                *cell += f64::from(xyz_to_cam[row][k]) * crate::hdr_fit::SRGB_TO_XYZ[k][col];
            }
        }
        let sum: f64 = slot.iter().sum();
        if sum.abs() > 1e-9 {
            for cell in slot.iter_mut() {
                *cell /= sum;
            }
        }
    }

    // Singular means the file described something impossible, and declining leaves the caller
    // without a frame rather than with one in invented colours.
    let srgb_from_cam = crate::hdr_fit::invert3(&cam_from_srgb)?;

    let rec2020_from_cam =
        crate::hdr_fit::multiply(&crate::hdr_fit::srgb_to_rec2020(), &srgb_from_cam);

    let mut out = [[0f32; 3]; 3];
    for (row, slot) in out.iter_mut().enumerate() {
        for (col, cell) in slot.iter_mut().enumerate() {
            *cell = rec2020_from_cam[row][col] as f32;
        }
    }
    Some(out)
}

/// The illuminant the decode balanced against.
///
/// `white_balance::as_shot` already takes the camera's multipliers and its XYZ matrix, which is
/// exactly what rawler carries, so this is a shape conversion and not a second implementation -
/// the temperature and tint a photograph reports must not depend on which decoder read it.
async fn as_shot_of(
    gpu: &'static crate::gpu::Gpu,
    image: &rawler::RawImage,
) -> Option<crate::white_balance::AsShot> {
    let wb = image.wb_coeffs;
    let cam_mul = [wb[0], wb[1], wb[2], wb[3]];
    crate::white_balance::as_shot(gpu, &cam_mul, &xyz_to_cam_of(image)?).await
}

#[cfg(test)]
mod tests {
    /// The uncached read hands back the file, whatever the alignment cost it.
    ///
    /// A RAW is never a multiple of the page size, so the last read runs past the end of the file
    /// and the buffer starts wherever the allocator happened to land - the two places this can
    /// return the right length and the wrong bytes.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_uncached_read_is_the_file() {
        // Two pages and a bit, so there is a tail and more than one page to get in the wrong order.
        let want: Vec<u8> = (0..9001u32).map(|i| (i % 251) as u8).collect();
        // Under the build directory rather than the temporary one, which is tmpfs on most
        // machines - and tmpfs refuses the flag, so the whole test would skip itself.
        let path = std::path::Path::new(env!("OUT_DIR")).join("uncached-read.bin");
        std::fs::write(&path, &want).expect("wrote the file");

        match super::uncached(&path) {
            Ok((bytes, at)) => {
                let address = bytes.as_ptr() as usize + at;
                assert_eq!(address % 4096, 0, "the read started at an unaligned address");
                assert_eq!(&bytes[at..], &want[..], "the bytes came back changed");
            }
            // A filesystem may still refuse the flag, and the decode maps the file there instead.
            // What must not happen is the read starting and then giving up part way, which is the
            // only thing `uncached` reports as `Other`.
            Err(e) => assert_ne!(e.kind(), std::io::ErrorKind::Other, "the read broke: {e}"),
        }

        std::fs::remove_file(&path).ok();
    }

    /// One opcode as DNG writes it: id, version, flags, then its parameters' length and bytes.
    fn opcode(id: u32, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for word in [id, 0x0103_0000, flags, body.len() as u32] {
            out.extend_from_slice(&word.to_be_bytes());
        }
        out.extend_from_slice(body);
        out
    }

    fn map_polynomial(plane: u32, rect: [u32; 4], coefficients: &[f64]) -> Vec<u8> {
        let mut body = Vec::new();
        let words = [rect[0], rect[1], rect[2], rect[3], plane, 1, 1, 1, coefficients.len() as u32 - 1];
        for word in words {
            body.extend_from_slice(&word.to_be_bytes());
        }
        for coefficient in coefficients {
            body.extend_from_slice(&coefficient.to_be_bytes());
        }
        opcode(8, 0, &body)
    }

    fn list(opcodes: &[Vec<u8>]) -> Vec<u8> {
        let mut out = (opcodes.len() as u32).to_be_bytes().to_vec();
        opcodes.iter().for_each(|it| out.extend_from_slice(it));
        out
    }

    /// A Lightroom merge's curve reaches the plane it names, and an optional opcode this cannot
    /// apply is passed over rather than refusing the file.
    #[test]
    fn a_polynomial_opcode_is_its_planes_curve() {
        let bytes = list(&[
            opcode(9, 1, &[0; 12]),
            map_polynomial(1, [0, 0, 20, 30], &[0.25, 0.0, 0.0, 0.5]),
        ]);
        let curves = super::opcode_curves(&bytes, 30, 20).expect("the list is read");
        assert_eq!(curves[0], vec![0.0, 1.0]);
        assert_eq!(curves[1], vec![0.25, 0.0, 0.0, 0.5]);
        assert_eq!(curves[2], vec![0.0, 1.0]);
    }

    /// What would render a different picture if skipped is refused rather than skipped.
    #[test]
    fn an_opcode_that_cannot_be_folded_is_refused() {
        let required = list(&[opcode(9, 0, &[0; 12])]);
        assert!(super::opcode_curves(&required, 30, 20).is_err());
        let partial = list(&[map_polynomial(0, [0, 0, 10, 30], &[0.0, 1.0])]);
        assert!(super::opcode_curves(&partial, 30, 20).is_err());
        let truncated = list(&[map_polynomial(0, [0, 0, 20, 30], &[0.0, 1.0])]);
        assert!(super::opcode_curves(&truncated[..truncated.len() - 1], 30, 20).is_err());
    }

    /// A little-endian DNG of one row of floating-point RGB pixels with no WhiteLevel, which is
    /// what a Lightroom HDR merge stores, down to the tags rawler needs to read one.
    fn float_dng(pixels: &[[f32; 3]]) -> Vec<u8> {
        const SHORT: u16 = 3;
        const LONG: u16 = 4;
        let rational = |n: i32, d: u32| [n.to_le_bytes(), d.to_le_bytes()].concat();
        let shorts = |values: &[u16]| values.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>();
        let long = |value: u32| value.to_le_bytes().to_vec();
        // Rec.709's own XYZ matrix, so the camera is sRGB and a neutral stays one.
        let matrix = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570];
        let strip: Vec<u8> = pixels.iter().flatten().flat_map(|v| v.to_le_bytes()).collect();
        let mut entries: Vec<(u16, u16, u32, Vec<u8>)> = vec![
            (254, LONG, 1, long(0)),
            (256, LONG, 1, long(pixels.len() as u32)),
            (257, LONG, 1, long(1)),
            (258, SHORT, 3, shorts(&[32, 32, 32])),
            (259, SHORT, 1, shorts(&[1])),
            (262, SHORT, 1, shorts(&[34892])),
            (271, 2, 5, b"Test\0".to_vec()),
            (272, 2, 6, b"Float\0".to_vec()),
            (273, LONG, 1, Vec::new()),
            (277, SHORT, 1, shorts(&[3])),
            (278, LONG, 1, long(1)),
            (279, LONG, 1, long(strip.len() as u32)),
            (284, SHORT, 1, shorts(&[1])),
            (339, SHORT, 3, shorts(&[3, 3, 3])),
            (50706, 1, 4, vec![1, 4, 0, 0]),
            (50721, 10, 9, matrix.iter().flat_map(|v| rational((v * 10000.0) as i32, 10000)).collect()),
            (50728, 5, 3, [rational(1, 1), rational(1, 1), rational(1, 1)].concat()),
        ];
        let ifd_bytes = 2 + entries.len() * 12 + 4;
        let mut spill = Vec::new();
        let spill_at = 8 + ifd_bytes;
        let strip_at = spill_at + entries.iter().filter(|e| e.3.len() > 4).map(|e| e.3.len()).sum::<usize>();
        entries.iter_mut().find(|e| e.0 == 273).unwrap().3 = long(strip_at as u32);

        let mut out = b"II*\0".to_vec();
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, kind, count, value) in &entries {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
            match value.len() > 4 {
                true => {
                    out.extend_from_slice(&((spill_at + spill.len()) as u32).to_le_bytes());
                    spill.extend_from_slice(value);
                }
                false => {
                    let mut inline = value.clone();
                    inline.resize(4, 0);
                    out.extend_from_slice(&inline);
                }
            }
        }
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&spill);
        out.extend_from_slice(&strip);
        out
    }

    /// Black off, filled, through the plane's curve, then balanced, and the whole table scaled so
    /// its brightest entry is 1.
    #[test]
    fn a_linear_dngs_table_puts_the_curve_between_the_fill_and_the_balance() {
        let level = |floor: f32, gain: f32| super::Coefficients { floor, range: 1000.0 - floor, gain };
        let levels = [level(100.0, 1.0), level(0.0, 0.5), level(0.0, 1.0)];
        let squared = vec![0.0, 0.0, 1.0];
        let table = super::table_of(levels, &[squared, vec![0.0, 1.0], vec![0.0, 0.5]]);
        let at = |sample: usize, channel: usize| table[sample * 3 + channel];

        // Red is the brightest ceiling, so it is what the table was divided by.
        assert!((at(1000, 0) - 1.0).abs() < 1e-6);
        // Half filled past its own black, then squared.
        assert!((at(550, 0) - 0.25).abs() < 1e-6, "red at 550: {}", at(550, 0));
        // Green's balance applies after its curve, and its ceiling is half red's.
        assert!((at(500, 1) - 0.25).abs() < 1e-6, "green at 500: {}", at(500, 1));
        assert!((at(2000, 1) - 0.5).abs() < 1e-6, "green past white: {}", at(2000, 1));
        assert!((at(1000, 2) - 0.5).abs() < 1e-6, "blue's curve tops out at half");
    }

    /// A floating-point DNG decodes, reads 1.0 as its white, and keeps a sample two stops past
    /// it where a count past white would have clipped. A NaN reads as black rather than as noise.
    #[test]
    fn a_floating_point_dng_keeps_what_it_holds_above_white() {
        if crate::gpu::device().is_none() {
            eprintln!("SKIPPED: no adapter answered, so the float DNG was not decoded.");
            return;
        }
        let bytes = float_dng(&[[0.25; 3], [1.0; 3], [4.0; 3], [f32::NAN; 3]]);
        let held = match pollster::block_on(super::open_bytes(&bytes)).expect("the DNG opens") {
            crate::decode::Held::Rendered(held) => held,
            crate::decode::Held::Mosaic(_) => panic!("a linear DNG was read as a mosaic"),
        };
        let window = crate::px::Rect { at: crate::px::At::ORIGIN, size: held.size() };
        let frame = held.window(window, crate::view::Scale::Full).expect("the window is drawn");
        assert_eq!(frame.stated_white, None, "a camera's white is measured, as a RAW's is");
        let crate::frame::Pixels::Resident(resident) = frame.pixels else { panic!("not on the device") };
        let samples = pollster::block_on(resident.into_host()).expect("the frame reads back");

        let white = 65535.0 / crate::transfer::HDR_HEADROOM;
        for (at, sample) in samples.iter().enumerate() {
            let want = [0.25, 1.0, 4.0, 0.0][at / 3] * white;
            assert!(
                (f64::from(*sample) - want).abs() <= 0.01 * white,
                "pixel {} channel {}: {sample} against {want}",
                at / 3,
                at % 3,
            );
        }
    }

    /// Each of the four photosites has its own black level removed, the two greens included.
    ///
    /// **The bug this pins subtracted one green's black from both.** The four levels were read by
    /// position, correctly, and then reordered into an array indexed by colour - where the two
    /// greens are one entry, so whichever was written second won and the other's level was lost.
    /// The frame it produces has a residual of the difference on every other green, a checkerboard
    /// at the sensor's own pitch, worst in the shadows where it is the largest part of the signal.
    #[test]
    fn every_photosite_loses_its_own_black_level() {
        // The four positions of an RGGB site, so the two greens are colour 1 and the ones that
        // collapsed onto each other.
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let levels = super::Levels {
            black: vec![500.0, 528.0, 512.0, 516.0],
            white: 16383.0,
            gains: [1.0, 1.0, 1.0, 1.0],
        };
        // Every sample sits exactly on its own black level, so a correct subtraction is zero
        // everywhere and anything left is the wrong level having been used.
        let samples: Vec<u16> = (0..16)
            .map(|at: usize| {
                let (row, col) = (at / 4, at % 4);
                levels.black[(row & 1) * 2 + (col & 1)] as u16
            })
            .collect();

        // Read out of the table the kernel reads, which is the only place the arithmetic lives.
        let curve = super::curve(&cfa, &levels);
        // Four distinct black levels are four distinct runs: nothing collapses here, which is the
        // whole point of the case.
        assert_eq!(curve.slot_of, vec![0, 1, 2, 3]);
        for (at, sample) in samples.iter().enumerate() {
            let (row, col) = (at / 4, at % 4);
            let position = (row & 1) * 2 + (col & 1);
            let slot = curve.slot_of[position] as usize;
            let value = curve.values[slot * (u16::MAX as usize + 1) + *sample as usize];
            assert!(
                value.abs() < 1e-6,
                "the sample at {row},{col} kept {value} of the black level at position {position}",
            );
        }
    }

    /// Read noise below black stays below it, so a dark patch averages to its light rather than to
    /// the upper half of its noise.
    #[test]
    fn a_sample_below_black_is_conditioned_negative() {
        let at = super::Coefficients { floor: 512.0, range: 16383.0 - 512.0, gain: 2.0 };
        let below = super::conditioned(462, at);
        let above = super::conditioned(562, at);
        assert!((below + above).abs() < 1e-7, "{below} and {above} are not symmetric about black");
        assert!((above - 2.0 * 50.0 / (16383.0 - 512.0)).abs() < 1e-7);
        assert_eq!(super::conditioned(u16::MAX, at), 2.0, "saturation still clips ahead of the gain");
    }

    /// A body's size comes off the two focal lengths, and nothing else is guessed at.
    ///
    /// The pairs are a 24mm on APS-C, a 50mm on full frame, a 63mm on a GFX and a 4.3mm on a phone
    /// -sized compact. What follows them is every way a file can decline to say: no equivalent at
    /// all, no focal length to take a ratio against, and a pair whose ratio is nothing a camera is.
    #[test]
    fn a_bodys_width_comes_off_the_pair_of_focal_lengths() {
        let width = super::width_mm_of;
        assert!((width(24.0, 36.0) - 24.0).abs() < 0.01, "an APS-C body is not read as full frame");
        assert_eq!(width(50.0, 50.0), 36.0);
        assert!((width(63.0, 50.0) - 45.36).abs() < 0.01, "medium format is wider, not narrower");
        assert!((width(4.3, 24.0) - 6.45).abs() < 0.01);
        for (focal, equivalent) in [(24.0, 0.0), (0.0, 36.0), (0.0, 0.0), (1.0, 400.0), (400.0, 1.0)] {
            assert_eq!(super::width_mm_of(focal, equivalent), 36.0, "{focal} against {equivalent}");
        }
    }

    /// A 14-bit converter's stated levels all round to the same ceiling, whatever they state.
    ///
    /// The two Canon figures are an R8 at two exposures; the Sony is an A7CR, which does not take
    /// this path and is here because it lands on the same converter width and shows the rule is
    /// about the ADC rather than about a make. The rest are the arithmetic's own edges: a level
    /// already one below a power of two must not climb, one exactly on a power of two must not
    /// round *down* to below itself, and full scale has no next power of two to reach for.
    #[test]
    fn a_stated_level_rounds_up_to_its_converters_width() {
        for (stated, want) in [
            (14008u16, 16383u16),
            (14888, 16383),
            (15360, 16383),
            (4095, 4095),
            (16383, 16383),
            (16384, 16384),
            (65535, 65535),
        ] {
            assert_eq!(super::adc_ceiling(stated), want, "{stated}");
        }
    }

    /// A photosite at saturation leaves the conditioning on its own channel's ceiling, exactly.
    ///
    /// **`assemble.slang` reads a blown pixel off this equality**, so it is the one place the
    /// conditioning has to be exact rather than close: a channel landing a ULP under its ceiling is
    /// a saturated photosite the reconstruction does not raise, and a sun keeps the gains' own
    /// ratios - 1 : 0.49 : 0.72 on this body, which renders pink.
    ///
    /// Every position rather than every colour, because the two greens carry their own black levels
    /// and share a gain, and it is the pair of tables that has to land them on the same ceiling.
    #[test]
    fn a_photosite_at_saturation_conditions_to_its_own_ceiling() {
        let quad = [0u32, 1, 1, 2];
        let cfa = crate::cfa::Cfa::bayer(quad).unwrap();
        // An R8's, as the file states them and as `white_balance_gains` scales them.
        let levels = super::Levels {
            black: vec![512.0; 4],
            white: f32::from(super::adc_ceiling(14008)),
            gains: [1.0, 0.48831692, 0.71626157, 0.48831692],
        };
        let curve = super::curve(&cfa, &levels);
        // One black level shared by four positions, so the two greens collapse onto one run and
        // three survive - the deduplication working, on the case it was written for.
        assert_eq!(curve.slot_of, vec![0, 1, 1, 2]);
        for position in 0..4 {
            let slot = curve.slot_of[position] as usize;
            let value = curve.values[slot * (u16::MAX as usize + 1) + 16383];
            let want = levels.gains[quad[position] as usize];
            assert_eq!(value, want, "position {position} left saturation at {value}");
        }
    }

    /// The gains leave the most amplified channel at one, which is what the mosaic has room for.
    ///
    /// A channel's ceiling is where its own photosites saturate, so the ceilings *are* these gains -
    /// and RCD is specified on the unit interval, so the largest of them has to be the one that
    /// lands on it. Scaled on the smallest instead, a blue carrying twice red's coefficient would
    /// need to reach two and the container has nowhere to put it.
    #[test]
    fn the_gains_put_the_most_amplified_channel_on_one() {
        let gains = super::scaled_gains([1.6074219, 1.0, 1.9921875, 1.0]);
        assert_eq!(gains[2], 1.0, "blue carries the largest coefficient here");
        assert!((gains[0] - 0.80686).abs() < 1e-4, "red came back {}", gains[0]);
        assert!((gains[1] - 0.50196).abs() < 1e-4, "green came back {}", gains[1]);
        // Nothing usable to scale against is the identity rather than a divide by zero.
        assert_eq!(super::scaled_gains([0.0, f32::NAN, -1.0, 0.0]), [1.0; 4]);
    }

    /// The kernel reads the table at the position each sample sits on, exactly.
    ///
    /// **Equality and not a bound**, since this frame is what every later stage and every rendition
    /// is built from: a drift here moves every picture rather than showing up as one failing
    /// assertion. Reachable because the arithmetic is not in the shader at all - `curve` tabulates
    /// the whole domain and the kernel looks the answer up, the shader's own expression having been
    /// off by a ULP where Vulkan requires only 2.5 of them from `OpFDiv`.
    ///
    /// So what is left to get wrong is the packing and the indexing, and the sizes are the shapes
    /// that break them
    /// rather than a sample of ordinary ones. WGSL has no `u16`, so the samples travel two to a
    /// word; **an odd width then leaves every second row starting in the high half of a word**,
    /// which a kernel assuming a per-row stride shears subtly and a fixture suite of even-width
    /// sensors never notices. The last size is over four million samples, which is 70k workgroups
    /// against the 65535 a dispatch dimension allows - the one thing a small frame cannot say
    /// anything about.
    #[test]
    fn the_kernel_conditions_every_sample_at_its_own_position() {
        let Some(gpu) = crate::gpu::device() else { return };
        let kernels = crate::condition::device(gpu);

        // RGGB, so the two greens are one colour on two positions with two black levels, which is
        // the distinction the tables exist to hold.
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let levels = super::Levels {
            black: vec![500.0, 528.0, 512.0, 516.0],
            white: 16383.0,
            gains: [2.394, 1.0, 1.597, 1.0],
        };
        let curve = super::curve(&cfa, &levels);

        // Under every black level, on each of them, across the range and past the white level, so
        // negative values and the saturation clip are exercised; every fifth index lands on odd
        // columns as well as even ones. The rest is a spread wide enough that a mispacked sample
        // could not read its neighbour's level and agree by coincidence.
        let corners = [0u16, 499, 500, 512, 516, 528, 529, 8191, 16382, 16383, 16384, 32767, 65535];
        let sample = |at: usize| -> u16 {
            match at % 5 {
                0 => corners[at % corners.len()],
                _ => ((at * 7919) % 20011) as u16,
            }
        };

        for (width, height) in [(64usize, 48usize), (63, 47), (1, 1), (3, 2), (2049, 2201)] {
            let samples: Vec<u16> = (0..width * height).map(sample).collect();
            let theirs: Vec<f32> = samples
                .iter()
                .enumerate()
                .map(|(at, sample)| {
                    let position = ((at / width) & 1) * 2 + ((at % width) & 1);
                    let slot = curve.slot_of[position] as usize;
                    curve.values[slot * (u16::MAX as usize + 1) + *sample as usize]
                })
                .collect();
            let mine = pollster::block_on(
                crate::condition::normalise(gpu, kernels, &samples, width, height, &curve)
                    .expect("the kernel runs")
                    .read(gpu),
            )
            .expect("the mosaic reads back");

            let differs = mine
                .iter()
                .zip(&theirs)
                .position(|(mine, theirs)| mine != theirs)
                .map(|at| (at, mine[at], theirs[at]));
            assert_eq!(
                differs, None,
                "at {width}x{height}, sample {:?} at position {:?}",
                differs.map(|(at, _, _)| samples[at]),
                differs.map(|(at, _, _)| ((at / width) & 1) * 2 + ((at % width) & 1)),
            );
        }
    }

    /// A camera reading its own neutral is what the white balance hands the matrix, so this is the
    /// one colour the matrix is not free to choose: it has to come out grey.
    ///
    /// Normalising the camera matrix in XYZ instead of sRGB failed exactly here, and only here -
    /// a neutral came out scaled by (1.108, 0.966, 0.917), which is the Rec.2020 of XYZ (1,1,1),
    /// a 15% red-over-green cast that no saturated colour would have made as obvious.
    #[test]
    fn a_camera_neutral_stays_neutral() {
        // Canon R5, D65.
        let xyz_to_cam = [
            [0.7695, -0.2686, -0.0805],
            [-0.3428, 1.0964, 0.2861],
            [-0.0136, 0.0428, 0.6461],
            [0.0, 0.0, 0.0],
        ];
        let matrix = super::camera_to_rec2020_from(xyz_to_cam).expect("an invertible matrix");
        let neutral: Vec<f32> = (0..3)
            .map(|row| matrix[row][0] + matrix[row][1] + matrix[row][2])
            .collect();
        for channel in &neutral {
            assert!(
                (channel - neutral[1]).abs() < 1e-3,
                "camera white renders as {neutral:?}",
            );
        }
    }

    /// **A strip a few pixels wide is a decode that declines**, because the demosaic refuses a
    /// window narrower than twice its margin - and a loupe names the width, so one pixel past a
    /// whole tile is an ordinary request rather than a contrived one.
    #[test]
    fn no_tile_is_left_a_runt_strip() {
        for total in [1usize, 2047, 2048, 2049, 4096, 4097, 6024, 9504] {
            let spans: Vec<(usize, usize)> = super::spans(total).collect();
            assert_eq!(spans.first().map(|s| s.0), Some(0), "{total} starts short");
            assert_eq!(spans.last().map(|s| s.1), Some(total), "{total} ends short");
            for pair in spans.windows(2) {
                assert_eq!(pair[0].1, pair[1].0, "{total} leaves a gap");
            }
            let smallest = spans.iter().map(|(a, b)| b - a).min().expect("a span");
            assert!(smallest >= total.min(1024), "{total} cut a {smallest}-wide strip");
        }
    }

    #[test]
    fn a_singular_matrix_is_declined_rather_than_rendered() {
        let flat = [[1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0], [0.0; 3]];
        assert!(super::camera_to_rec2020_from(flat).is_none());
    }
}
