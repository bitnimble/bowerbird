//! One rectangle of a photograph, carried to the point the grade reads it.
//!
//! **Both hosts that magnify come through here.** A rendition job answers the loupe over HTTP
//! (`job::graded`) and a tab answers it for itself (`wasm::render_tile`), and what a loupe claims
//! is that its pixels are the export's - so the decode, the window it is grown to, the coding, the
//! warp and the sharpen have to be one implementation rather than two that agree today.
//!
//! What is *not* here is the grade. That is a dispatch over the same WGSL on either host, from a
//! uniform each builds for itself, and the tile's half of that uniform is `gpu::uniform_words` -
//! so a tab grades its tile through the shaders it grades everything else with rather than through
//! a second copy of the rule.

use crate::image::Strengths;
use crate::px::{At, Drawn, Photograph, Place, Rect, Size, Span};
use serde::Deserialize;

/// What a tile needs that its own rectangle cannot tell it.
///
/// Three of these fields are the photograph's rather than the crop's - the levels, the noise fit
/// and, through `frame`, everything the window is measured against - and that is the whole of what
/// a tile gets wrong when it is left to work them out ([`crate::job::graded`] says what each was
/// worth).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRequest {
    /// `[left, top, width, height]` in the photograph's own pixels, which is the space the
    /// editor's frame speaks.
    pub tile: [usize; 4],
    /// The photograph the rectangle is a piece of.
    pub frame: [usize; 2],
    pub grade: crate::hdr::Grade,
    pub strengths: Strengths,
    /// The Detail panel's two sliders, 0 to 100, which drive the denoise on the mosaic.
    ///
    /// Null is the document not having said, answered by the frame's own fit - which a tile has to
    /// be handed rather than measure, so a window resolves the same number the whole frame does
    /// (`galosh::Detail`, and `noise_fit` below).
    #[serde(default)]
    pub denoise_luminance: Option<f64>,
    #[serde(default)]
    pub denoise_colour: Option<f64>,
    /// Which filter those two positions drive, which a window has to match the frame on or a loupe
    /// would predict an export it does not resemble.
    #[serde(default)]
    pub denoiser: crate::galosh::Denoiser,
    /// The dust panel's switch and two sliders, which correct the mosaic beside the denoise.
    ///
    /// The particles themselves are not here: they are in `photo_analysis`, because they are the
    /// photograph's rather than the reader's, and a window must never look for its own
    /// (`crate::dust::Wanted`).
    #[serde(default)]
    pub dust: crate::dust::Settings,
    /// The reader's sliders. Only the presence three are read here, for how far past the tile the
    /// guided filter reaches; the grade reads the rest.
    #[serde(default)]
    pub adjust: crate::gpu::Adjust,
    /// The photograph's own diffuse white and scene peak, measured at the open.
    #[serde(default)]
    pub levels: Option<crate::tone::Levels>,
    /// The photograph's mosaic noise, measured at the open.
    #[serde(default)]
    pub noise_fit: Option<crate::galosh::NoiseFit>,
    /// The capture's blur sigma in sensor pixels, measured at the open
    /// (`crate::galosh::NoiseFit` rides beside it for the same reason). Absent, the sharpen
    /// deconvolves its fixed default.
    #[serde(default)]
    pub capture_sigma: Option<f32>,
    /// The sensor's long edge the sigma above is in pixels of. `frame` cannot stand in for
    /// it: a caller whose decode halved hands a `frame` at half the sensor's density, and a
    /// sigma composed against that is twice as wide as the blur it deconvolves. Absent,
    /// `frame` is taken to be the sensor's own, which is what a loupe request over HTTP has.
    #[serde(default)]
    pub sensor_long: Option<usize>,
    /// The photograph's longitudinal aberration, fitted at the open.
    ///
    /// Global like the levels are, and wrong here for the same reason: the fit reads channel
    /// residuals over the whole frame, so a window fitting its own is defringed at whatever that
    /// window's edges say, and the strips of a re-prepare are corrected by amounts that walk down
    /// the picture. Absent fits this window's own, which is what a caller with no open behind it -
    /// a rendition's loupe, over HTTP - has to do.
    #[serde(default)]
    pub defocus: crate::base::Defringe,
    /// What is already known about the photograph, so a tile fits none of it (`crate::photo_analysis`).
    #[serde(default)]
    pub photo_analysis: Option<Vec<u8>>,
    /// How much of the sensor's resolution this render wants (`crate::view::Scale`).
    ///
    /// **The photograph's answer, handed down.** A loupe is showing the reader the export's own
    /// pixels and always wants all of it; a rendition small enough that the sensor is worth halving
    /// says so here, and then the window is demosaiced the same way the whole frame would have
    /// been. Working it out from the window's own dimensions is how two pieces of one picture end
    /// up demosaiced two different ways.
    #[serde(default)]
    pub scale: crate::view::Scale,
    /// The reader's repairs, which a window grows to hold the fill of wherever one reaches it
    /// (`crate::repair::reaching`).
    #[serde(default)]
    pub repairs: Vec<crate::repair::Repair>,
}

impl TileRequest {
    fn detail(&self) -> crate::galosh::Detail {
        crate::galosh::Detail {
            luminance: self.denoise_luminance,
            colour: self.denoise_colour,
            denoiser: self.denoiser,
        }
    }

    /// What is already known about the photograph, as far as this build can read it.
    fn stored(&self) -> crate::photo_analysis::PhotoAnalysis {
        self.photo_analysis
            .as_deref()
            .and_then(crate::photo_analysis::decode)
            .unwrap_or_default()
    }
}

/// The window a tile was built in, ready for the grade.
pub struct Prepared {
    /// Normalised PQ Rec.2020 ([`crate::tone::encode_base`]), the window and its margin.
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    /// `[left, top, width, height]` of the rectangle actually asked for, inside that window.
    pub keep: [usize; 4],
    /// The levels the samples above were coded against, which the grade anchors to.
    pub levels: crate::tone::Anchored,
    pub matched: Option<crate::hdr_fit::HdrMatch>,
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// The camera's own multipliers, which a composite files as its balance
    /// (`photo_analysis::FromRaw::balance`).
    ///
    /// **A composite's are the reference source's**, the frame a composite is graded as. None where
    /// no source of this window carried any - the case a synthetic fixture and a finished picture
    /// both are.
    pub wb_gains: Option<[f32; 3]>,
    /// The photograph the window is a piece of, which is the scale the presence sliders read at.
    pub photograph: (usize, usize),
    /// Where the window starts in that photograph, which is where the grade reads the
    /// surround thumb.
    pub origin: (usize, usize),
    /// The longitudinal aberration the defringe took off, measured here where the caller had none
    /// to hand. Whole-frame, so what a window is *given* it must hand on rather than refit.
    pub defocus: (f32, f32),
    /// The library's reference white, which the coding above already used.
    pub(crate) reference_nits: crate::light::Light<crate::light::SceneNits>,
}

impl Prepared {
    /// The scene this window is graded as part of: the photograph's colour and levels, with the
    /// reader's own exposure and sliders.
    pub fn scene(
        &self,
        exposure: crate::light::Stops,
        adjust: crate::gpu::Adjust,
    ) -> crate::tone::SceneGrade<'_> {
        crate::tone::SceneGrade::new(
            self.matched.as_ref().and_then(|m| m.colour.as_ref()),
            self.levels,
            self.reference_nits,
            exposure,
            adjust,
            self.as_shot,
        )
    }

    /// That scene over this window, which differs from a whole frame's in one word.
    pub fn grade<'a>(
        &self,
        scene: &'a crate::tone::SceneGrade<'a>,
        peak_nits: crate::light::Light<crate::light::DisplayNits>,
        output: crate::gpu::Output,
    ) -> crate::gpu::Grade<'a> {
        scene
            .gpu_grade(self.width, self.height, peak_nits, output)
            .within(self.photograph)
            .surrounded(
                Size::exact(self.photograph.0, self.photograph.1),
                At::exact(self.origin.0, self.origin.1),
            )
    }
}

/// Where the RAW is: a file this process can open, bytes a page already holds, or a photograph
/// already conditioned onto the device.
///
/// The third is the editor's, and it is what makes a band of a re-prepare cost a window rather
/// than a file: everything above the denoise was settled when the photograph was opened, so a
/// window of it is cut out of the mosaic that is already there.
pub enum Source<'a> {
    Path(&'a str),
    Bytes(&'a [u8]),
    Held(&'a crate::decode::Held),
    /// A scene-linear frame the caller already has, which is the editor's open.
    ///
    /// **The open cannot decode twice.** It reads the frame once because the camera match is fitted
    /// against *scene-linear* samples, before any coding - so by the time it wants the rest of the
    /// chain it is holding the pixels, not a path. Only a whole view may arrive this way: a window
    /// restricts what is read off the disk, and there is nothing left to restrict here.
    Frame(crate::frame::Frame),
}

/// The window, decoded and filtered, with the turn already taken.
pub fn prepared(source: Source<'_>, request: &TileRequest) -> Result<Prepared, String> {
    pollster::block_on(prepared_async(source, request))
}

/// The same, awaited: the readback below cannot be blocked for in a tab
/// ([`crate::gpu::read_back`] says why).
pub async fn prepared_async(source: Source<'_>, request: &TileRequest) -> Result<Prepared, String> {
    let (frame, mut prepared) = prepared_on_device(source, request).await?;
    prepared.samples = frame
        .into_frame()
        .into_host()
        .await
        .ok_or("the prepared frame could not be read")?;
    Ok(prepared)
}

/// The same window, left in the buffer the chain wrote it into.
///
/// **For a caller that draws it rather than reads it.** The editor's own frame is graded on this
/// device for the life of an open, so taking it to the host would be a copy down and a copy back
/// up for every photograph opened - and the browser cannot even do that within one device, a
/// `GPUDevice` being a thing a worker boundary does not carry.
///
/// The `Prepared` that comes back is everything about the window *except* its pixels: `samples` is
/// empty, and the buffer beside it holds them, with what its repairs were drawn over.
pub async fn prepared_on_device(
    source: Source<'_>,
    request: &TileRequest,
) -> Result<(crate::retouched_frame::RetouchedFrame, Prepared), String> {
    let grown = grown(request)?;
    let detail = request.detail();
    let stored = request.stored();
    // `noise_fit` is the photograph's, measured at the editor's open and handed back with the
    // request: a tile that fits its own is denoised at its own crop's strength rather than at the
    // photograph's, which is a loupe that disagrees with the export it exists to predict and
    // changes as the reader pans. Refused rather than trusted where it does not describe a sensor,
    // since it crosses an API from a client - and falling back to what is stored beside the
    // photograph, for the caller with no open behind it to have measured one.
    let noise = request
        .noise_fit
        .filter(crate::galosh::NoiseFit::usable)
        .or(stored.from_raw.noise);
    let fit = noise.map_or(crate::galosh::Fit::Measure, crate::galosh::Fit::Given);
    // The rendition's halo, not the editor's, though a loupe is an editor feature: what it is for
    // is showing what the export will be, and a magnifier denoised to a different standard from
    // the export is one that lies.
    let halo = crate::RENDITION_TILE_HALO;
    // The region to read, in the photograph's own pixels, at the scale this render wants. Both come
    // off the request rather than off the rectangle: whether the sensor is worth halving is a
    // question about the picture, and a window asked of its own dimensions answers differently for
    // every tile (`view::Scale::for_long_edge`).
    let reading = grown.reading();
    // The photograph's particles, as the same request already carries its noise and its match. A
    // `Known` rather than a `Wanted`: everything below this is a window, and a window that went
    // looking would read the frame's own texture floor over a few hundred thousand photosites and
    // find a different set from its neighbours and from the export it exists to predict. Absent is
    // an empty list - correct nothing - which is why this takes a slice and not an option.
    let spots: &[crate::dust::Spot] = stored.from_raw.dust.as_deref().unwrap_or(&[]);
    let dust = request.dust.known(spots);
    let frame = match source {
        Source::Frame(frame) => Some(frame),
        Source::Held(held) => {
            held.window(reading.window, reading.scale, detail, fit, halo, dust)
                .await
        }
        // **One decode, two ways in.** A path and a slice differ only in how the file is handed
        // over - rawler maps one and borrows the other - so they meet at `decode::tile_from`
        // rather than at two calls that have to be kept saying the same thing. Reading the path
        // into a `Vec` to reach the slice would meet even sooner and cost the mapping, which on a
        // rendition worker's hot path is fifty megabytes a photograph that the kernel was paging
        // in for free.
        Source::Path(path) => {
            crate::decode::tile_from(
                crate::decode::Source::Path(path),
                reading,
                detail,
                fit,
                halo,
                dust,
            )
            .await
        }
        Source::Bytes(bytes) => {
            crate::decode::tile_from(
                crate::decode::Source::Bytes(bytes),
                reading,
                detail,
                fit,
                halo,
                dust,
            )
            .await
        }
    }
    .ok_or("could not decode the photograph scene-linear")?;

    let (width, height) = (frame.width, frame.height);
    // What came back is the rectangle that was asked for, or nothing is: `decode_tile` trims its
    // region to whole CFA sites and takes the trim off the *far* edge, so a region flush against
    // the sensor's own can come back a pixel short - and everything below is sized from the window
    // rather than from this, down to the buffer the GPU is handed. Refused rather than corrected,
    // because a tile one pixel narrower than the reader asked for is not the rectangle the glass
    // is drawing.
    // Against what the *view* produces, not the region it reads: a halved decode answers half the
    // rectangle it was given, and comparing the two would refuse every one of them.
    if (width, height) != reading.size().raw() {
        let (want_w, want_h) = reading.size().raw();
        return Err(format!(
            "the decoder answered {width}x{height} for a {want_w}x{want_h} view",
        ));
    }

    let as_shot = frame.as_shot;
    let refused = || {
        crate::base::without_a_device("the coding, the defringe, the lens gather and the sharpen")
    };
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;
    // This crop's own, and the photograph's by construction: the matrix is built from the file's
    // illuminant and colour matrix (`decode_rawler::camera_to_rec2020`) rather than from any pixel,
    // so a window decodes the same one the whole frame would. Unlike the noise fit beside it, there
    // is nothing here for a window to get wrong and nothing stored for it to fall back to.
    let matrix = frame.matrix;
    // The photograph's where there is one, and this crop's where there is not. What the fit is used
    // for here is a ceiling on a median, so a window's own is worth far more than the flat constant
    // it would otherwise fall back to - the pan-instability that keeps a crop's fit out of the
    // denoise *strength* above does not follow it into a bound.
    let noise = noise.or(frame.noise);
    // This window's own decode read them off the same file the whole frame's did, so they are the
    // photograph's and not the crop's however small the crop is.
    let wb_gains = frame.wb_gains;
    // Where the decode left it, which is on the device: the coding, the defringe and the gather are
    // all shaders, so a window that came out of `decode_tile_source` never crosses the bus at all.
    let resident = match frame.pixels {
        crate::frame::Pixels::Resident(resident) => resident,
        crate::frame::Pixels::Sixteen(samples) => {
            crate::resident::Resident::upload(gpu, &samples, width, height)
        }
        crate::frame::Pixels::Eight(_) => {
            return Err("a tile needs a 16-bit scene-linear decode".to_string());
        }
    };
    // The editor's, where it sent them: a quantile of a crop describes where the reader is
    // pointing rather than the photograph, so a tile measuring its own is graded against a white
    // that changes as the loupe moves - and over anything dark, against one far below the frame's,
    // which lifts the crop to reference white.
    let known = request
        .levels
        .filter(crate::tone::Levels::usable)
        .or_else(|| {
            stored
                .from_render
                .levels
                .and_then(|m| m.levels_at(request.grade.white_quantile))
        });
    let levels = match known {
        Some(levels) => levels,
        None => crate::fit_source::levels(gpu, &resident, request.grade.white_quantile)
            .await
            .ok_or("the frame's levels could not be measured")?,
    }
    .anchored();
    // Coded against those levels and defringed, as `job::Base::build` codes a whole frame: no lens
    // here, because a window's warp is the photograph's own over that window and happens below.
    let strengths = request.strengths.before_the_fit();
    // The photograph's, from the request where an open measured one and otherwise from what is
    // stored beside it. Both beat this window fitting its own, which is a defringe read off the
    // crop's own edges - see `MeasuredDefocus`.
    // Keyed on the *photograph's* long edge rather than this window's: the pair was fitted over the
    // whole frame, and it is that frame's pixels the coefficient is in.
    let defocus = match request.defocus {
        crate::base::Defringe::Measure => stored
            .from_render
            .defocus
            .and_then(|d| d.pair_for(strengths.defringe, grown.frame.0.max(grown.frame.1)))
            .map_or(crate::base::Defringe::Measure, crate::base::Defringe::Take),
        given => given,
    };
    // **The coding, the defringe and the frame's own gather over this window, in one chain.** The
    // gather is the photograph's, restricted to what this window writes (`base::Gather::window`) -
    // a crop corrected as though it were the whole picture bends at the wrong radius. The reader's
    // geometry is not applied, because a tile is named in coordinates that already carry it.
    let none = crate::fit::Lens::none();
    // Every rectangle here is the buffer's, which is what `grown` hands back and what the frame in
    // hand actually is - the decode's own region is the one thing named in the photograph's pixels,
    // and it is `reading`'s business rather than the gather's.
    let gather = crate::base::Gather::window(
        Size::exact(grown.frame.0, grown.frame.1),
        Rect::exact(
            grown.window.0,
            grown.window.1,
            grown.window.2,
            grown.window.3,
        ),
        Rect {
            at: reading.origin(),
            size: Size::exact(width, height),
        },
    );
    // The sharpen rides the same chain now, after the gather whose resample it undoes - as
    // `job::run` sharpens, and where: a tile skipped it entirely once, and showed a softer
    // photograph than the export at the one magnification a reader could have seen the
    // difference at. Its sigma is the capture's, carried to this scale's pixels.
    let sensor_long = request
        .sensor_long
        .unwrap_or_else(|| grown.photograph.0.max(grown.photograph.1));
    let drawn_long = grown.frame.0.max(grown.frame.1);
    let sigma = crate::image::deconvolve_split(
        request.capture_sigma.or(stored.from_raw.capture_sigma),
        sensor_long,
        drawn_long,
    );
    let sharpen_noise = crate::base::sharpen_noise(
        levels,
        request.grade.reference_white_nits,
        noise,
        matrix,
        wb_gains,
        frame.reduced,
    )
    .at(
        crate::px::Span::<crate::px::Sensor>::exact(sensor_long),
        crate::px::Span::<crate::px::Drawn>::exact(drawn_long),
    );
    let chained = crate::base::prepare(
        gpu,
        base,
        resident,
        gather,
        levels,
        request.grade.reference_white_nits,
        Strengths {
            sharpen: request.strengths.sharpen,
            ..strengths
        },
        sigma,
        sharpen_noise,
        grown.lens.as_ref().unwrap_or(&none),
        defocus,
        noise,
        matrix,
    )
    .await;
    let Some((frame, took_off)) = chained else {
        return Err(refused());
    };
    let frame = crate::retouched_frame::RetouchedFrame::drawn(
        frame,
        Size::exact(grown.frame.0, grown.frame.1),
        At::exact(grown.window.0, grown.window.1),
        &request.repairs,
    )?;

    Ok((
        frame,
        Prepared {
            // The caller's to fill from the buffer beside it, and empty for one that draws instead.
            samples: Vec::new(),
            width: grown.window.2,
            height: grown.window.3,
            keep: grown.keep,
            levels,
            matched: grown.matched,
            as_shot,
            wb_gains: Some(wb_gains),
            photograph: grown.frame,
            origin: (grown.window.0, grown.window.1),
            defocus: took_off,
            reference_nits: request.grade.reference_white_nits,
        },
    ))
}

/// What a tile request becomes: a region to decode, the window of the corrected frame to build out
/// of it, and where the rectangle actually asked for sits inside that window.
///
/// **Two coordinate spaces meet here, and only one of them leaves.** A request names its rectangle
/// in the photograph's own pixels, because that is what a reader points at; a decode asked for
/// [`crate::view::Scale::Half`] hands back a buffer half that size, and every stage below - the
/// gather, the sharpen, the cut - reads the buffer. So `grown` converts once, at the top, and
/// everything it returns except [`Grown::decode`] is in the buffer's pixels. `decode` is what the
/// sensor is asked for, so it stays in the photograph's.
struct Grown {
    /// The part of the *uncorrected* frame to decode, which the lens decides. **In the photograph's
    /// pixels**, at the scale below.
    decode: crate::Tile,
    /// What the decode is asked to produce, which is what makes `decode` and the rest differ.
    scale: crate::view::Scale,
    /// The window of the corrected frame to produce: `(left, top, width, height)` in the *buffer's*
    /// pixels.
    window: (usize, usize, usize, usize),
    /// `[left, top, width, height]` of the asked-for tile within that window, in the buffer's.
    keep: [usize; 4],
    /// The photograph the window is a piece of, as this scale draws it.
    frame: (usize, usize),
    /// The same photograph in its own pixels, which is the space `decode` is named in.
    photograph: (usize, usize),
    /// Its match, decoded once here so the footprint, the gather and the grade cannot disagree
    /// about whether there is a lens.
    matched: Option<crate::hdr_fit::HdrMatch>,
    /// Its lens, where that match carries one worth applying.
    lens: Option<crate::fit::Lens>,
}

impl Grown {
    /// The region to read, and at what resolution: what `decode_tile_source` takes.
    fn reading(&self) -> crate::view::View {
        crate::view::View {
            photograph: crate::px::Size::exact(self.photograph.0, self.photograph.1),
            window: crate::px::Rect::exact(
                self.decode.left,
                self.decode.top,
                self.decode.width,
                self.decode.height,
            ),
            scale: self.scale,
        }
    }
}

/// How far past a tile the sliders that read a neighbourhood read, in the pixels of the frame they
/// run on.
///
/// **The guided filter is two windows deep**, and both are fractions of the working texture the
/// blur is built on - so in that frame's own pixels the reach is that fraction of the whole of it,
/// whatever size it is. A tile without it fits its models against an edge the picture does not
/// have, and the Clarity along the rim of the glass is a filter looking at nothing.
///
/// `frame` is the decoded frame rather than the photograph, which at `Scale::Half` are not the
/// same: the working texture is sized off what the filter reads, so a reach measured against the
/// photograph would be twice what a halved frame wants.
///
/// Asked of [`crate::gpu::Adjust::reads_the_neighbourhood`] rather than of a list here, so the
/// blur's reach and the decision to build a blur at all cannot disagree: Highlights and Shadows
/// are weighted by how bright the region around a pixel is, so they read the same texture Clarity
/// does.
///
/// Zero where none of them is asked for, which is what most tiles are: this is four times the
/// decode for a 400px tile, and it buys nothing at all when the sliders are at rest.
fn presence_reach(adjust: &crate::gpu::Adjust, frame: Size<Drawn>) -> Span<Drawn> {
    if !adjust.reads_the_neighbourhood() {
        return Span::ZERO;
    }
    let long = frame.long().raw();
    let working = crate::gpu::detail_long(long);
    // Texels of the working texture, then back into the frame's own pixels at the rate that
    // texture shrinks it by - rounded up, because a reach one pixel short is a filtered edge. The
    // multiplication is the conversion, and the `raw` is where the texel stops being one.
    let texels = crate::gpu::detail_reach_texels(working);
    Span::exact(texels.raw() * long.div_ceil(working.max(1) as usize))
}

/// Everything a tile's rectangle implies, before anything is read off the disk.
///
/// **A tile is a rectangle of the corrected picture, not of the sensor.** That is what the client
/// names - its frame is `edit::open`'s, with the lens already materialised into it - and what a
/// rendition would write there. Two things follow, and neither was true before:
///
/// - The gather has to be the *frame's*, over this window ([`crate::base::Gather::window`]).
///   A crop warped as though it were the photograph corrects at the wrong radius and lifts its own
///   corners as if they were the frame's.
/// - What to decode is then whatever that window gathers *from*, which the warp itself answers.
///   The distortion moves a corner of a 24MP frame by tens of pixels, so the region is not the
///   window and cannot be assumed to be.
///
/// On top of that the window is grown by the reach of everything that runs after the gather. **A
/// deconvolution reads past what it writes**, by `image::Strengths::halo`: the decode's
/// own halo is eaten by the demosaic and the mosaic denoise long before the sharpen, so a tile
/// built at exactly the rectangle asked for rings along all four edges - and the loupe's tile is
/// only half again its glass, so at high magnification that ringing is inside what the reader is
/// looking at. The window is cut back to `keep` once every one of those stages has run.
///
/// Refuses a rectangle that is not inside the photograph.
fn grown(request: &TileRequest) -> Result<Grown, String> {
    let photograph: Size<Photograph> = Size::exact(request.frame[0], request.frame[1]);
    if photograph.width.is_zero() || photograph.height.is_zero() {
        return Err("a tile needs the size of the photograph it is a piece of".to_string());
    }
    let asked: Rect<Photograph> = Rect::exact(
        request.tile[0],
        request.tile[1],
        request.tile[2],
        request.tile[3],
    );
    // Two places compared, not two numbers: the photograph's far corner is where its origin plus
    // its size lands, which is the same shape as the rectangle's own far corner.
    let corner: At<Photograph> = At {
        x: Place::ORIGIN + photograph.width,
        y: Place::ORIGIN + photograph.height,
    };
    if asked.past().x > corner.x || asked.past().y > corner.y {
        let (left, top, width, height) = asked.raw();
        return Err(format!(
            "a tile of {width}x{height} at {left},{top} is outside a {}x{} photograph",
            photograph.width.raw(),
            photograph.height.raw(),
        ));
    }

    // **Into the buffer's pixels, once, here.** Everything below this line - the reach the sharpen
    // and the presence filters read past what they write, the texel grid the window aligns to, the
    // window itself, the rectangle kept inside it - is arithmetic about the frame the stages
    // actually run on, and at `Scale::Half` that frame is not the photograph. Converting at the top
    // is what lets those lines stay one set rather than growing a scaled twin, and the types below
    // are `Drawn` from here down so that a photograph coordinate cannot rejoin them by accident.
    //
    // **The kept rectangle is rounded outward**, its near edge down and its far edge up
    // (`Scale::at` against `Scale::past`). Halving is a floor, so an odd coordinate has no exact
    // answer; rounding out covers every pixel the reader asked for, where rounding in would drop
    // one at the seam between two tiles.
    let scale = request.scale;
    let frame: Size<Drawn> = Size {
        width: scale.span(photograph.width),
        height: scale.span(photograph.height),
    };
    let at: At<Drawn> = At {
        x: scale.at(asked.at.x),
        y: scale.at(asked.at.y),
    };
    let kept: Rect<Drawn> = Rect {
        at,
        size: Size {
            width: scale.past(asked.past().x).min(Place::ORIGIN + frame.width) - at.x,
            height: scale.past(asked.past().y).min(Place::ORIGIN + frame.height) - at.y,
        },
    };
    let (left, top) = (kept.at.x, kept.at.y);
    let (width, height) = (kept.size.width, kept.size.height);
    let matched = request.stored().from_raw.matched;
    let lens = matched
        .as_ref()
        .map(|matched| matched.lens.clone())
        .filter(|lens| !lens.is_identity());

    // **Added, not maxed: the two stages are sequential and each reads what the one before it
    // wrote.** The blur the presence sliders read is built from the *sharpened* window, so a kept
    // pixel needs every pixel the blur averages into it to be far enough inside the window that
    // the deconvolution had real context there - the blur's reach *plus* the sharpen's, not
    // whichever is larger. At `max` the outermost `Strengths::halo` of the window are sharpened
    // against a clamped edge and the blur reads them, which is a tile that differs from its export in
    // exactly the case a reader is most likely to have set up: Clarity on a sharpened photograph.
    // And the match's chroma smoothing, which reads a neighbourhood too: a kept pixel near
    // the window's edge would otherwise borrow its colour from a blur clamped at that edge.
    // And the match's supervision footprint, one stage further back. It reads the lattice at a
    // block mean and divides the pixel by it (`mean_frame.slang`), and the blocks partition the
    // *photograph* - so a block the kept rectangle only partly covers is averaged over what the
    // window holds and nothing beyond it. One block is the worst case, the kept edge landing
    // anywhere inside one.
    let reach: Span<Drawn> = Span::exact(request.strengths.halo())
        + presence_reach(&request.adjust, frame)
        + match matched.is_some() {
            // **The one place the two spaces meet, and it is a crossing rather than an
            // equivalence.** The smoothing's footprint is a share of the photograph in the pixels
            // of the frame the grade *writes*; this window is in the pixels the decode produced.
            // A tile is cut at 1:1, so for this caller the two are the same size and the reach
            // carries over - and a tile that ever rendered its window at another scale would have
            // to take the reach over that size instead, which is what saying so here is for.
            //
            // The block is added to the smoothing rather than maxed against it: the smoothing
            // runs over the *matched* frame, so a pixel it reads had to have its own block whole
            // before it was smoothed.
            //
            // **It adds no margin at any size this can be asked at, and belongs here anyway.**
            // Both terms are now shares of the photograph - the smoothing a 960th of it six times
            // over, the block an 808th of it - so the smoothing is five times the block whatever
            // the sensor, and only a `FIT_LONG_EDGE` under 160 would invert that. What
            // this sum is for is naming every stage that reads past what it writes; a stage left
            // out of it because another one currently reaches further is a stage nobody will
            // think of when the other one moves.
            true => Span::exact(
                crate::gpu::chroma_smooth_reach(crate::px::Span::measured(frame.long().raw()))
                    .raw()
                    + crate::gpu::mean_block(frame.long().raw()) as usize,
            ),
            false => Span::ZERO,
        };
    // Down to a whole texel of the blur's working texture, which is what lets that texture be the
    // photograph's own texels rather than a set of its own between them (`gpu::detail_step`).
    //
    // **An even number of them, which costs at most one texel of margin and is what lets a window
    // be copied back into the frame it came from.** A row is `width * 3` samples and two samples
    // make a word, so an odd-width frame's rows begin on alternate half-words - and a kept
    // rectangle an odd number of rows inside its window then starts where
    // `copy_buffer_to_buffer` will not begin (`wasm::HeldRaw::band_into`). Doubling the grid
    // keeps every alignment it had, being a multiple of the step either way.
    let step: Span<Drawn> = Span::exact(crate::gpu::detail_step(frame.long().raw()) as usize * 2);
    let start = |place: Place<Drawn>| (place - reach).floor_to(step);
    // What the window has to hold before its margin: the rectangle, and wherever the fill of a
    // repair reaching it is read from.
    let held = crate::repair::reaching(&request.repairs, frame, kept, reach);
    let (window_left, window_top) = (start(held.at.x), start(held.at.y));
    let window: Rect<Drawn> = Rect {
        at: At {
            x: window_left,
            y: window_top,
        },
        size: Size {
            width: (held.past().x + reach).min(Place::ORIGIN + frame.width) - window_left,
            height: (held.past().y + reach).min(Place::ORIGIN + frame.height) - window_top,
        },
    };
    let keep = [
        (left - window_left).raw(),
        (top - window_top).raw(),
        width.raw(),
        height.raw(),
    ];

    // What that window reads. Built against the whole frame first because the answer is the
    // question - the gather has to exist before it can say what it gathers from - and it is a
    // couple of tables either way.
    let whole: Rect<Drawn> = Rect {
        at: At::ORIGIN,
        size: frame,
    };
    let decode = match lens
        .as_ref()
        .filter(|_| window != whole)
        .and_then(|lens| crate::image::lens_footprint(frame, window, lens))
    {
        Some(read) => Rect::<Drawn>::exact(read.0, read.1, read.2, read.3),
        // Nothing to correct, or nothing to restrict: a window that is already the whole picture
        // reads the whole picture whatever the lens does with it, and asking the gather would come
        // back *smaller* - a barrel correction reads inwards at the edges, and the region would
        // then be missing the rows the frame's own gather clamps against.
        None => window,
    };

    // **Back into the photograph's pixels, because this one is what the sensor is asked for.** A
    // buffer coordinate multiplied by the ratio lands on a whole CFA site by construction, which is
    // what `decode_tile` requires of a halved region and what an origin scaled the other way could
    // not promise.
    let read_at: At<Photograph> = At {
        x: scale.read_at(decode.at.x),
        y: scale.read_at(decode.at.y),
    };
    let decode: Rect<Photograph> = Rect {
        at: read_at,
        size: Size {
            width: scale
                .read_span(decode.size.width)
                .min((Place::ORIGIN + photograph.width) - read_at.x),
            height: scale
                .read_span(decode.size.height)
                .min((Place::ORIGIN + photograph.height) - read_at.y),
        },
    };
    let decode = decode.raw();

    Ok(Grown {
        decode: crate::Tile {
            left: decode.0,
            top: decode.1,
            width: decode.2,
            height: decode.3,
        },
        scale,
        photograph: photograph.raw(),
        window: window.raw(),
        keep,
        frame: frame.raw(),
        matched,
        lens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asking(tile: [usize; 4]) -> TileRequest {
        TileRequest {
            tile,
            frame: [6000, 4000],
            grade: crate::hdr::Grade {
                peak_nits: crate::light::Light::exactly(1000.0),
                reference_white_nits: crate::light::Light::exactly(203.0),
                white_quantile: 0.995,
            },
            strengths: Strengths {
                sharpen: 1.0,
                defringe: 1.0,
            },
            denoise_luminance: Some(20.0),
            denoise_colour: Some(30.0),
            denoiser: crate::galosh::Denoiser::Galosh,
            dust: Default::default(),
            adjust: crate::gpu::Adjust::none(),
            levels: None,
            noise_fit: None,
            capture_sigma: None,
            sensor_long: None,
            defocus: crate::base::Defringe::Measure,
            photo_analysis: None,
            scale: crate::view::Scale::Full,
            repairs: Vec::new(),
        }
    }

    /// A loupe over a repair is built wide enough to hold where the repair's fill comes from, and
    /// what it keeps is still the rectangle it was asked for.
    #[test]
    fn a_window_over_a_repair_holds_where_its_fill_comes_from() {
        let asked = [2000, 1500, 256, 256];
        let quiet = grown(&asking(asked)).expect("a tile");
        let mut request = asking(asked);
        // A seam over the tile, its fill read a third of the photograph to the left.
        request.repairs = vec![
            serde_json::from_str(
                r#"{"drawn":[[22000,16500],[23000,16500],[22500,17500]],
                    "seam":[[21800,16300],[23200,16300],[23200,17700],[21800,17700]],
                    "donor":[-21845,0],"gain":1}"#,
            )
            .expect("a repair"),
        ];
        let over = grown(&request).expect("a tile");
        let (left, _, width, _) = over.window;
        assert!(
            left < 1000,
            "the window starts at {left}, short of the fill"
        );
        assert!(left + width >= quiet.window.0 + quiet.window.2);
        assert_eq!([over.keep[2], over.keep[3]], [256, 256]);
        assert_eq!(left + over.keep[0], asked[0]);
    }

    /// The window holds the rectangle asked for and the reach of everything that runs after the
    /// gather, and the rectangle is where the caller is told it is.
    ///
    /// **This is what a loupe tile is, as arithmetic**, and it is why nothing in the browser has to
    /// be opened to ask: the sharpen reads `Strengths::halo` past what it writes, so a tile cut at
    /// exactly the rectangle rings along all four edges - and the glass is only half again it,
    /// so at magnification that ringing is inside what the reader is looking at.
    #[test]
    fn the_window_carries_the_rectangle_and_what_reads_past_it() {
        let asked = [2000, 1500, 512, 512];
        let grown = grown(&asking(asked)).expect("a rectangle inside the photograph");
        let (left, top, width, height) = grown.window;

        assert!(
            width > 512 && height > 512,
            "the window did not grow: {width}x{height}"
        );
        assert_eq!(
            [grown.keep[2], grown.keep[3]],
            [512, 512],
            "the rectangle changed size"
        );
        // Where the rectangle sits inside the window, in the window's own pixels.
        assert_eq!(left + grown.keep[0], asked[0]);
        assert_eq!(top + grown.keep[1], asked[1]);
        assert!(grown.keep[0] + grown.keep[2] <= width);
        assert!(grown.keep[1] + grown.keep[3] <= height);
        assert!(
            left + width <= 6000 && top + height <= 4000,
            "the window left the photograph"
        );
        // No lens, so what is decoded is the window itself.
        assert_eq!(
            (
                grown.decode.left,
                grown.decode.top,
                grown.decode.width,
                grown.decode.height
            ),
            grown.window,
        );
    }

    /// A window carries both the chroma smoothing's reach and a whole supervision block.
    ///
    /// **Asserted as the sum, because the inequality would pass either way.** Both are shares of
    /// the photograph and the smoothing is eight times the block at any size, so "the margin
    /// covers a block" is true with the block's term deleted - which is a test that guards
    /// nothing. The two stages are sequential, the smoothing reading a frame the match has already
    /// divided by its block means, so what the window owes is both of them and that is what this
    /// reads.
    ///
    /// Sharpen and the presence sliders are off so the reach under test is not hidden behind
    /// theirs, and a match has to be present for either term to apply at all.
    #[test]
    fn a_kept_rectangle_reaches_a_whole_supervision_block_past_itself() {
        let mut request = asking([2000, 1500, 512, 512]);
        request.frame = [40000, 30000];
        // Sharpen and the presence sliders off, so the reach under test is not hidden behind
        // theirs - which is the configuration a plain rendition actually asks for.
        request.strengths = Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        };
        request.photo_analysis = Some(crate::photo_analysis::encode(
            &crate::photo_analysis::PhotoAnalysis {
                from_raw: crate::photo_analysis::FromRaw {
                    matched: Some(crate::hdr_fit::HdrMatch {
                        colour: Some(crate::hdr_fit::HdrColour::identity()),
                        lens: crate::fit::Lens::none(),
                    }),
                    ..Default::default()
                },
                from_render: Default::default(),
            },
        ));
        let grown = grown(&request).expect("a rectangle inside the photograph");
        let long = request.frame[0];
        let block = crate::gpu::mean_block(long) as usize;
        let smoothing = crate::gpu::chroma_smooth_reach(crate::px::Span::measured(long)).raw();
        // **The sum, not an inequality.** The smoothing alone reaches eight times a block at any
        // size, so "the margin covers a block" holds with this term deleted and would be asserting
        // nothing. What can only be true with it is that the window carries *both* stages.
        //
        // The far edges, because the near ones are floored to the blur's texel grid and carry a
        // whole step of slack they did not ask for.
        let (_, _, window_width, window_height) = grown.window;
        let far = [
            window_width - (grown.keep[0] + grown.keep[2]),
            window_height - (grown.keep[1] + grown.keep[3]),
        ];
        assert!(
            far.iter().all(|margin| *margin >= smoothing + block),
            "the window reaches {far:?} past the rectangle, short of a {smoothing}-pixel \
             smoothing and a {block}-pixel block",
        );
    }

    /// A band's kept rows begin where the frame it is copied back into can take them.
    ///
    /// **Three samples to a pixel and two samples to a word**, so an odd-width frame's rows begin
    /// on alternate half-words - and `copy_buffer_to_buffer` will not start on one
    /// (`wasm::HeldRaw::band_into`). The band's own `top` is even because the caller cuts at an
    /// even stride; what this pins is the other end, that the window's margin above the kept rows
    /// is an even number of them, which follows from the grid being an even number of texels.
    ///
    /// **Long edges chosen for an odd `detail_step`**, which is the only way the grid can land the
    /// margin on an odd row: the step is `ceil(long / 512)`, so 1500 gives 3, 2375 gives 5 and
    /// 3500 gives 7, where the 6000 the cases above use gives 12 and would carry the assertion for
    /// free. 2375x1583 is a 4750x3167 sensor halved, which is also how an odd *width* arises.
    ///
    /// The tops sweep two at a time - a band's stride being even - across a whole step, which
    /// covers every residue the margin can land on because an odd step and 2 are coprime. Well
    /// past the reach, so the window is grown rather than clamped at the frame's top, which is the
    /// case that answers zero whatever the grid does.
    #[test]
    fn a_bands_kept_rows_start_on_a_word_of_the_frame() {
        for (frame, step) in [
            ([1500usize, 1500usize], 3usize),
            ([2375, 1583], 5),
            ([3500, 2333], 7),
        ] {
            for top in (0..step).map(|n| 1024 + n * 2) {
                let rows = 1024.min(frame[1] - top);
                let mut request = asking([0, top, frame[0], rows]);
                request.frame = frame;
                let grown = grown(&request).expect("a band inside the photograph");
                assert_eq!(
                    grown.keep[1] % 2,
                    0,
                    "a {}x{} frame's band at {top} keeps from row {}",
                    frame[0],
                    frame[1],
                    grown.keep[1],
                );
            }
        }
    }

    /// The presence sliders reach hundreds of pixels further than the sharpen, at the
    /// *photograph's* scale, and cost that much more decode - so they are paid for only when one
    /// of the three is off zero, which most tiles are.
    #[test]
    fn the_sliders_that_read_a_neighbourhood_grow_the_window_and_nothing_else_does() {
        let asked = [2000, 1500, 512, 512];
        let quiet = grown(&asking(asked)).expect("a tile");

        // Every slider `Adjust::reads_the_neighbourhood` names, each on its own: the blur they
        // read is built for any one of them, so a window grown for only three of the five is a
        // Shadows slider filtering against an edge the picture does not have.
        let each: [(&str, fn(&mut crate::gpu::Adjust)); 5] = [
            ("clarity", |a| a.clarity = 60.0),
            ("texture", |a| a.texture = 60.0),
            ("dehaze", |a| a.dehaze = 25.0),
            ("highlights", |a| a.highlights = -40.0),
            ("shadows", |a| a.shadows = 40.0),
        ];
        for (what, set) in each {
            let mut wants = asking(asked);
            let mut adjust = crate::gpu::Adjust::none();
            set(&mut adjust);
            wants.adjust = adjust;
            let grew = grown(&wants).expect("a tile");
            assert!(
                grew.window.2 > quiet.window.2 + 100,
                "{what} read no further than the sharpen: {} against {}",
                grew.window.2,
                quiet.window.2,
            );
            assert_eq!(
                [grew.keep[2], grew.keep[3]],
                [512, 512],
                "{what} moved the kept rectangle"
            );
        }

        // And a slider that does not read one leaves the window where it was.
        let mut flat = asking(asked);
        flat.adjust = crate::gpu::Adjust {
            contrast: 50.0,
            ..crate::gpu::Adjust::none()
        };
        assert_eq!(grown(&flat).expect("a tile").window.2, quiet.window.2);
    }

    /// A rectangle outside the photograph is refused rather than clamped: a magnifier over
    /// somewhere the photograph is not has nothing to show, and a silently moved one is worse.
    #[test]
    fn a_rectangle_outside_the_photograph_is_refused() {
        assert!(grown(&asking([5900, 1500, 512, 512])).is_err());
        assert!(grown(&asking([2000, 3900, 512, 512])).is_err());
        let mut sizeless = asking([0, 0, 512, 512]);
        sizeless.frame = [0, 0];
        assert!(grown(&sizeless).is_err());
    }
}
