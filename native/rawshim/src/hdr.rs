// HDR renditions of one photo, end to end (DESIGN 10.7).
//
// One call does the whole job: decode the RAW scene-linear, fit the camera's colour in
// the grade's own domain, fit to size, warp, grade, and hand the samples to libavif.
// That is deliberate rather than convenient. The graded frame is ~115MB at 24MP and
// ~366MB at 61MP, and building it on the other side of the FFI would mean every one of
// those bytes crossing the boundary for a consumer that is not there.
//
// The still is an AVIF, which Chrome renders as HDR on Android 14+ and on desktop, and
// Safari renders on macOS - including at 4:4:4, confirmed on an HDR display. Firefox
// honours no HDR image tagging at all and is served the same file: it rewraps the
// bitstream as an MP4 in the page, its video pipeline being the one that composites
// HDR (§10.7).

use crate::hdr_args::{self, EncodeOptions};
use crate::hdr_fit::{self, CameraMatch, HdrMatch};
use crate::image;
use crate::tone;
use serde::{Deserialize, Serialize};

/// The long edge the camera match decodes its preview to, which is all of it (`jpeg::decode`
/// reads 0 as whole).
///
/// Whole rather than the fit's own grid, because `hdr_fit::preview_planes` averages it down in
/// linear light and anything here is a coded-domain filter underneath that. Measured on the
/// Canon fixture: stopping at the coarsest DCT scale that still covers the grid saves 90ms of
/// the decode and costs every crop against the camera's own rendering - 2.62 to 3.26 counts of
/// 255 on a saturated pot, its worst pixels 38 to 60.
const MATCH_PREVIEW: usize = 0;

/// The preview the camera match is fitted against, by path.
pub fn match_preview(raw_path: &str) -> Option<crate::rgb::Rgb> {
    crate::decode_rawler::upright_preview_rgb(
        raw_path,
        MATCH_PREVIEW,
        crate::decode_rawler::Preview::for_the_match(),
    )
}

/// The same, from a file already in memory.
///
/// Stood up by the tag `upright_preview_jpeg_bytes` writes over any the preview carried, where
/// `match_preview` honours the preview's own tag and turns the pixels after; a preview with a
/// tag of its own would come out differently through the two, and
/// `both_hosts_take_the_same_preview_pixels` is what holds them to one answer.
pub fn match_preview_from_bytes(bytes: &[u8]) -> Option<crate::rgb::Rgb> {
    let jpeg = crate::decode_rawler::upright_preview_jpeg_bytes(
        bytes,
        crate::decode_rawler::Preview::for_the_match(),
    )?;
    crate::jpeg::decode(&jpeg, MATCH_PREVIEW).ok()
}

/// How a scene-linear decode is anchored to a display (DESIGN 10.7).
///
/// One value rather than three loose numbers because the three are only meaningful
/// together: the quantile picks the sample diffuse white is read from, and the two nits
/// figures say where that sample and the highlights above it land. A rendition and a
/// slider tick that disagreed on any one of them would be grading different pictures.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grade {
    /// Display peak the grade rolls highlights into, and the declared mastering peak.
    ///
    /// The library's HDR figure. What a *target* rolls into is `job::peak_nits`, which is this
    /// for a PQ output and diffuse white for an sRGB one.
    pub peak_nits: crate::light::Light<crate::light::DisplayNits>,
    /// Nits diffuse white maps to (BT.2408 HDR Reference White).
    pub reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    /// Quantile of the frame taken as diffuse white.
    pub white_quantile: f64,
}

/// A frame and its dimensions: the scene-linear decode where a caller has just decoded, and
/// the coded base everywhere below `tone::encode_base`.
pub struct Source<'a> {
    pub samples: &'a [u16],
    pub width: usize,
    pub height: usize,
}

/// Fits the camera's colour for the HDR grade, for a lens the caller already holds.
///
/// The preview is decoded here rather than passed in, so the JPEG never leaves this
/// side. None when the file embeds no preview, or when there are too few usable pairs.
///
/// The levels the match was fitted against come back with it, so an open that fits reads
/// them off the frame once.
#[cfg(feature = "renditions")]
pub async fn fit_match(
    gpu: &'static crate::gpu::Gpu,
    raw_path: &str,
    frame: &crate::resident::Resident,
    quantile: f64,
    lens: crate::fit::Lens,
) -> Option<(HdrMatch, tone::Levels)> {
    let preview = match_preview(raw_path)?;
    fit_match_from(gpu, frame, quantile, &preview, lens).await
}

pub async fn fit_match_from(
    gpu: &'static crate::gpu::Gpu,
    frame: &crate::resident::Resident,
    quantile: f64,
    preview: &crate::rgb::Rgb,
    lens: crate::fit::Lens,
) -> Option<(HdrMatch, tone::Levels)> {
    let (tw, th) = hdr_fit::fitted_preview_size(preview.width, preview.height);
    let (width, height) = frame.size();
    if width < tw || height < th {
        return None;
    }
    let quantile = crate::tone::body_white_quantile(preview.as_ref()).unwrap_or(quantile);
    let prepared = crate::fit_source::prepared(gpu, frame, tw, quantile).await?;
    let matched = hdr_fit::fit(gpu, &prepared.plane, prepared.levels, preview, lens).await?;
    Some((matched, prepared.levels))
}

/// The whole camera match for an HDR rendition - the geometry and the colour - off one
/// pass over the decode.
///
/// Both halves want the same three things: the frame's levels, the camera's preview, and
/// the decode box-averaged to the width the preview is fitted at
/// (`hdr_fit::fitted_preview_size`). Asked for as two calls they each measured the levels,
/// each pulled the 5-14MB preview back out of the file, and each walked the whole frame to
/// build the same average.
///
/// Both normalise it by diffuse white, the geometry search included. The peak stood in
/// for the decoder's auto-brightening once, and it is a maximum over a strided subsample: one
/// specular sample drags the whole render toward black by the peak/white ratio, `pairs`
/// drops anything whose darkest channel lands on 1 or below, and a frame can fall under
/// `MIN_PAIRS` and lose its colour match entirely. Diffuse white is a percentile, so it
/// is also what keeps the fit stable across decode sizes.
///
/// Geometry first and colour second, which is not negotiable: the colour is fitted from
/// pixel pairs that only correspond through the warp (10.8).
///
/// **The geometry search reads a *finished* render: the defringe and the lateral tier remove
/// the same error.** Measured
/// on the raw render, the tier corrects a fringe the defringe at the end of `encode_still`
/// then removes as well, and the two together overshoot. Handed the frame as it will
/// actually look, the tier finds nothing left and declines on its own - no rule needed.
///
/// The colour half still reads `plane`, which is scene-linear and cannot be finished in the
/// same way: the denoise takes a difference against a blur, and a difference taken in
/// linear light follows absolute luminance rather than what the eye reads. What makes that
/// tolerable is `fit_source::prepared` itself - it box-averages the
/// decode down to the width the preview is fitted at (`hdr_fit::fitted_preview_size`),
/// which already removes most of the chroma noise a denoise would have.
///
/// None when the file embeds no preview, when the fit found nothing worth applying, or
/// when there were too few usable pairs - in each case the caller grades neutrally.
#[cfg(feature = "renditions")]
pub async fn fit_all(
    gpu: &'static crate::gpu::Gpu,
    raw_path: &str,
    frame: &crate::resident::Resident,
    quantile: f64,
    geometry: crate::fit::Geometry,
    camera_match: CameraMatch,
) -> Option<(crate::fit::Profile, HdrMatch, tone::Levels)> {
    if camera_match == CameraMatch::None {
        return None;
    }
    // One decode, read by both halves: the geometry fit takes it below and the colour fit
    // takes it again for the plane.
    let mut lap = crate::clock::laps("  match ");
    let preview = match_preview(raw_path)?;
    if crate::clock::watched() {
        eprintln!("  match preview {}x{}", preview.width, preview.height);
    }
    let lateral = crate::ffi::recorded_lateral(raw_path);
    lap("preview decode");
    fit_all_from_preview(gpu, frame, quantile, geometry, &preview, lateral, camera_match).await
}

/// `fit_all` off a preview the caller decoded, with the levels the match was fitted against.
pub async fn fit_all_from_preview(
    gpu: &'static crate::gpu::Gpu,
    frame: &crate::resident::Resident,
    quantile: f64,
    geometry: crate::fit::Geometry,
    preview: &crate::rgb::Rgb,
    lateral: Option<[Vec<f64>; 2]>,
    camera_match: CameraMatch,
) -> Option<(crate::fit::Profile, HdrMatch, tone::Levels)> {
    if camera_match == CameraMatch::None {
        return None;
    }
    let mut lap = crate::clock::laps("  match ");
    let (tw, _) = hdr_fit::fitted_preview_size(preview.width, preview.height);
    // The body's own anchor where its rendering carries one, and the caller's quantile where it
    // does not. Here rather than at the callers because this is the one place holding both the
    // frame and the picture the body made of it, and both arms of `open::measure` reach it.
    let quantile = crate::tone::body_white_quantile(preview.as_ref()).unwrap_or(quantile);
    if crate::clock::watched() {
        eprintln!("  match anchor at quantile {quantile:.5}");
    }
    let prepared = crate::fit_source::prepared(gpu, frame, tw, quantile).await?;
    let (plane, rendered, levels) = (prepared.plane, prepared.rendered, prepared.levels);
    lap("plane, levels, render");
    if !(levels.white > crate::light::Light::ZERO) {
        return None;
    }
    let (wide_jpeg, searched) = hdr_fit::preview_planes(gpu, preview).await?;
    lap("planes");
    let mut profile = crate::fit::fit_from_preview(gpu, &rendered, &searched, geometry)
        .await
        .ok()
        .flatten()?;
    lap("geometry");
    crate::fit::with_lateral(gpu, &mut profile, &rendered, lateral).await;
    lap("lateral");
    if camera_match == CameraMatch::Lens {
        let matched = HdrMatch { lens: profile.lens(), colour: None };
        return Some((profile, matched, levels));
    }
    let matched = hdr_fit::fit_linearised(gpu, &plane, levels, wide_jpeg, profile.lens())
        .await
        .unwrap_or_else(|| HdrMatch { lens: profile.lens(), colour: None });
    lap("colour");
    Some((profile, matched, levels))
}

/// A decode carried as far as it can go without knowing the exposure.
///
/// Fit to size and measured. A one-shot rendition gathers the lens inside the grade; an
/// editor materialises the warp into this buffer once (`apply_lens`) and re-grades on
/// every slider tick, which is the whole reason they are a value rather than a phase of
/// `graded`.
pub struct Prepared {
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    /// The frame's own, read before the grade so exposure can move against them instead
    /// of being folded into them (the `exposure` uniform in `edit.slang`).
    pub levels: tone::Levels,
}

/// The downscale, on the device the pipeline requires anyway (DESIGN 2.1).
///
/// Here rather than spelled at each of the three callers, and refusing rather than falling back:
/// there is one resize and it is a shader.
fn shrink(samples: &[u16], source: (usize, usize), out: (usize, usize)) -> Option<Vec<u16>> {
    let gpu = crate::gpu::device()?;
    let base = crate::base::device(gpu)?;
    let frame = crate::resident::Resident::upload(gpu, samples, source.0, source.1);
    let smaller = crate::base::resize(gpu, base, &frame, out);
    frame.reclaim();
    pollster::block_on(smaller?.into_host())
}

/// The coding, on the same device and for the same reason: `base.slang`'s `encode_base` is the only
/// one there is.
///
/// Panics rather than returning, because a caller of this has nothing to do with the answer: these
/// are the pins and the debug entry points, and a frame that reached here uncoded would be graded
/// as though sensor levels were PQ.
pub fn code_base(
    samples: &mut [u16],
    levels: tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
) {
    let coded = crate::gpu::device()
        .and_then(crate::base::device)
        .and_then(|base| {
            let gpu = crate::gpu::device()?;
            pollster::block_on(crate::base::encode_base(
                gpu,
                base,
                samples,
                levels,
                reference_white_nits,
            ))
        })
        .is_some();
    assert!(coded, "{}", crate::base::without_a_device("the coding"));
}

/// The frame's levels, for a caller holding samples on the host.
pub fn levels_of(
    gpu: &'static crate::gpu::Gpu,
    samples: &[u16],
    width: usize,
    height: usize,
    quantile: f64,
) -> Option<tone::Levels> {
    let frame = crate::resident::Resident::upload(gpu, samples, width, height);
    let levels = pollster::block_on(crate::fit_source::levels(gpu, &frame, quantile));
    frame.reclaim();
    levels
}

/// [`prepare`] against levels the caller has already read.
///
/// The levels are the photo's, not the target's: they are read off the *unresized* decode, and
/// a job cutting several sizes off one photo would otherwise measure the same frame once per
/// rendition for the same answer.
pub fn prepare_with(
    source: &Source<'_>,
    fit_to: Option<(usize, usize)>,
    levels: tone::Levels,
) -> Prepared {
    // Fit before grading, not after. zscale would have done the same resize in the
    // same linear light, but only once the whole frame had been graded - so a 61MP
    // decode was tone-mapped in full to produce a 3840px rendition and 15/16 of that
    // work was thrown away. After the resize because the lens model is in normalised
    // radii, so warping 61MP to make a 3840px rendition is the same picture for
    // sixteen times the work.
    let fitted = fit_to.and_then(|(width, height)| {
        shrink(
            source.samples,
            (source.width, source.height),
            (width, height),
        )
    });
    let (width, height) = match (fitted.is_some(), fit_to) {
        (true, Some(size)) => size,
        _ => (source.width, source.height),
    };

    // One owned buffer for the whole chain. Only a frame that needed no resize has to
    // be copied out of the caller's decode, which this must not write to.
    let samples = fitted.unwrap_or_else(|| source.samples.to_vec());
    Prepared {
        samples,
        width,
        height,
        levels,
    }
}

/// Everything `encode` does up to the point of handing bytes to ffmpeg.
///
/// Split out so a pin can be held against the graded frame without running an encoder,
/// which is what `debug::run`'s luma quantiles reach it for.
pub fn graded(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> (Vec<u16>, usize, usize) {
    graded_as(source, options, matched, crate::gpu::Output::Rolled)
}

/// [`graded`] in whichever coding the caller wants out.
///
/// The transfer is the shader's, in the same dispatch as the grade, so asking for sRGB here
/// is one argument rather than a second implementation of the primaries and the curve.
///
/// `source` is a scene-linear decode. **The fit-to-size happens here, before the coding, so
/// that this agrees with the job.** A rendition's decode arrives already fitted
/// (`decode_frame` bounds it to the largest target), so the only box average production takes
/// in light is that one; coding first and resizing after would put this path's average in PQ
/// and quietly make it a different picture from the one the renditions produce - which
/// matters, because what comes through here is what the pins and the examples measure.
///
/// The coded frame is a buffer of its own, the caller's decode being borrowed. The job does
/// not come through here: it codes in place at `Base::build` and never holds both.
pub fn graded_as(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
    output: crate::gpu::Output,
) -> (Vec<u16>, usize, usize) {
    graded_under(source, options, matched, output, crate::gpu::Intent::default())
}

/// [`graded_as`] brought inside an sRGB file's range by `intent`.
pub fn graded_under(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
    output: crate::gpu::Output,
    intent: crate::gpu::Intent,
) -> (Vec<u16>, usize, usize) {
    let gpu = crate::gpu::device().expect(
        "no Vulkan adapter answered, not even a software one. The grade runs on the GPU so \
         that the editor and a rendition cannot drift apart, and there is no CPU copy to \
         fall back to. On a machine with no GPU, `bun run get:swiftshader` fetches a CPU \
         driver that is enough - it is very slow and it works.",
    );
    let levels = levels_of(
        gpu,
        source.samples,
        source.width,
        source.height,
        options.grade.white_quantile,
    )
    .expect("the frame's levels could not be measured")
    .anchored();
    let mut cut = cut_for(
        gpu,
        source.samples.to_vec(),
        source.width,
        source.height,
        options,
        matched,
        levels,
    );
    let scene = neutral_scene(levels, options, matched);
    let graded = encode_cut(
        gpu,
        &cut,
        &crate::gpu::Grade { intent, ..scene.gpu_grade(cut.width, cut.height, options.grade.peak_nits, output) },
    );
    cut.release();
    (graded, cut.width, cut.height)
}

/// One `encode` dispatch over the cut, wherever its frame is - resident where the render
/// loop left it, host where a window arrived that way.
pub fn encode_cut(
    gpu: &'static crate::gpu::Gpu,
    cut: &Cut,
    grade: &crate::gpu::Grade<'_>,
) -> Vec<u16> {
    let peak = gpu.scene_peak();
    match cut.resident() {
        Some(frame) => gpu.upload_resident(frame, grade, &peak).encode(grade),
        None => {
            let samples = cut
                .host_samples()
                .expect("a cut holds one frame or the other");
            gpu.upload(samples, grade, &peak).encode(grade)
        }
    }
}

/// The scene as the camera rendered it: the photo's colour and levels, and nobody's edit.
///
/// What both one-shot entry points grade through. Every slider at the camera's own and no as-shot
/// illuminant, because these serve the pins and the debug paths, which measure the grade itself -
/// and with the illuminant pair unset there is nothing to balance away from.
fn neutral_scene<'a>(
    levels: tone::Anchored,
    options: &EncodeOptions,
    matched: Option<&'a HdrMatch>,
) -> tone::SceneGrade<'a> {
    tone::SceneGrade::new(
        matched.and_then(|m| m.colour.as_ref()),
        levels,
        options.grade.reference_white_nits,
        crate::light::Stops::ZERO,
        crate::gpu::Adjust::none(),
        None,
    )
}

/// The frame a one-shot render grades from: coded, fitted to size, warped and sharpened.
///
/// **`job::run`'s own chain, and the reason the two entry points below do not each carry one.**
/// They had an assembly each, and the difference between them was silent: this one omitted the
/// sharpen outright, so `baseline`, `crops`, `sweep` and every pin taken through `graded` measured
/// a frame that stops one stage short of anything a reader is ever shown.
///
/// **Coded first, then resized, which is the order a rendition takes.** `base::resize` decodes each
/// tap through `light_of_code` and averages light, so a coded frame through it and a linear frame
/// averaged before coding come to the same picture - and doing it this way leaves that kernel one
/// input domain rather than two. Resizing linear samples through it instead reads every level as a
/// PQ code, which `pq_inv` expands so violently that the average is a maximum.
///
/// The samples are taken rather than borrowed so the linear frame is dropped as soon as the device
/// holds it, which at 61MP is 361MB the host does not read again.
///
/// `levels` are the caller's because the caller needs them anyway, for the scene the same frame is
/// graded through. Read here instead and every render pays a quantile over the whole frame twice
/// for one answer.
///
/// No defringe: it is a shader on the linear frame (`base::prepare`) and neither of these paths
/// runs it, where `job::Base::build` does.
fn cut_for(
    gpu: &'static crate::gpu::Gpu,
    mut samples: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
    levels: tone::Anchored,
) -> Cut {
    code_base(&mut samples, levels, options.grade.reference_white_nits);
    let size = hdr_args::target_size(width as u32, height as u32, options);
    let frame = crate::resident::Resident::upload(gpu, &samples, width, height);
    drop(samples);
    Cut::from_base(
        frame,
        matched.map(|m| &m.lens),
        size,
        options.strengths.sharpen,
        image::SharpenSigma::fixed(options.sharpen_sigma.unwrap_or(image::DECONVOLVE_SIGMA)),
        image::SharpenNoise::NONE,
    )
}

/// One photo's renditions, carried to the point where only the display still differs.
///
/// Coded, fitted to size, warped and sharpened - **exactly what `edit::open` hands the
/// shader**, and for the same reason: the grade itself is one WGSL implementation now
/// (`gpu::encode`), so whatever reaches it has to be the same thing on both hosts.
///
/// Nothing here knows what display a rendition targets. The colour transform, the roll-off
/// and the transfer are all downstream of this and all run in one dispatch, so a job naming
/// several outputs shares everything up to here and pays only a dispatch each.
///
/// The colour transform is resolution-independent - a per-pixel lookup - so a smaller
/// rendition is a [`Cut::downscale`] of a larger one's frame rather than its own resize, its
/// own warp table and its own sweep. That it is cut before the transform is still what makes
/// the average an honest one: a box mean of the *rendered* picture runs into `mean(f(x))` not
/// being `f(mean(x))` across a whole tone curve and a chroma lattice, where this is one
/// transfer. Not the sensor's own integration either, which linear levels were - see
/// [`Cut::downscale`].
pub struct Cut {
    frame: CutFrame,
    pub width: usize,
    pub height: usize,
}

/// Where the cut's samples are: normalised PQ Rec.2020 `u16` either way, as
/// `tone::encode_base` coded them and as the shader reads them back through `nits_of_code`.
///
/// The render loop wants them on the device - the sharpen leaves them there and the grade
/// reads them there, so a host `Vec` between the two is 366MB down and 366MB back up at 61MP
/// for nothing. A window from `tile::prepared` arrives over the bus already and stays host.
enum CutFrame {
    Device(crate::resident::Resident),
    Host(Vec<u16>),
}

/// What a frame measures once the reader's geometry is applied to it.
///
/// The Rust twin of `displaySize` in `schemas/display_size.ts`, and the same three steps in the
/// same order: straighten to the bounding box, crop as fractions of *that*, then the quarter
/// turn. The two have to agree, because the catalogue lays a grid tile out on one and the
/// encoder writes a file at the other - a disagreement is a tile that is the wrong shape for
/// the picture inside it.
///
/// Floored at one: the fractions are free to describe a rectangle narrower than a pixel at
/// tile size, and a rendition of no pixels is a failed encode rather than a small picture.
///
/// **Not a sub-rectangle of what went in.** A straighten's bounding box is larger than the frame it
/// was cut from, so what comes back is its own space - which is why `encode` indexes
/// `output_width` and a caller that sized a buffer off the frame instead under-allocated it.
pub fn cropped_out(
    frame: crate::px::Size<crate::px::Drawn>,
    geometry: image::Geometry,
) -> crate::px::Size<crate::px::Output> {
    let (width, height) = cropped_size(frame.width.raw(), frame.height.raw(), geometry);
    // The extent of a frame that is about to exist, which is the one thing `Output` can be given
    // from outside: its pixels are as large as the rendition is small, so nothing in that space
    // can be written down and everything else in it is derived from this.
    crate::px::Size::measured(width, height)
}

pub fn cropped_size(width: usize, height: usize, geometry: image::Geometry) -> (usize, usize) {
    let radians = geometry.angle_degrees.to_radians();
    let (cos, sin) = (radians.cos().abs(), radians.sin().abs());
    let (sw, sh) = (
        width as f64 * cos + height as f64 * sin,
        width as f64 * sin + height as f64 * cos,
    );
    let [left, top, right, bottom] = geometry.crop;
    let w = sw * (right - left).max(0.0);
    let h = sh * (bottom - top).max(0.0);
    let turned = matches!(geometry.rotate % 360, 90 | 270);
    let (w, h) = if turned { (h, w) } else { (w, h) };
    ((w.round() as usize).max(1), (h.round() as usize).max(1))
}

impl Cut {
    /// The largest rendition's frame, off the shared base.
    ///
    /// A resize or a warp writes its own output, so the base is only copied when neither
    /// runs - the native-resolution, no-lens case, and 366MB of it on a 61MP frame. Worth
    /// knowing rather than worth avoiding: the caller's decode is borrowed and a `Cut` owns
    /// its samples, so the alternative is a lifetime on every rendition.
    ///
    /// No levels travel with it: the base carries the perceptual anchor the sharpen works in,
    /// and the grade reads the levels off `tone::SceneGrade` rather than off the frame.
    pub fn from_base(
        frame: crate::resident::Resident,
        lens: Option<&crate::fit::Lens>,
        size: hdr_args::Size,
        sharpen: f64,
        sharpen_sigma: image::SharpenSigma,
        sharpen_noise: image::SharpenNoise,
    ) -> Cut {
        let gpu = frame.gpu();
        let base = crate::base::device(gpu).expect("the device the pipelines were built on");
        let asked = (size.width as usize, size.height as usize);
        let frame = match crate::base::resize(gpu, base, &frame, asked) {
            Some(smaller) => {
                frame.reclaim();
                smaller
            }
            None => frame,
        };
        let (width, height) = frame.size();
        // **The lens, on the GPU, from the frame the editor's open warps through the same kernel.**
        // The reader's own geometry is not here: it is applied in the grade's dispatch, which is
        // where the editor has always applied it and cannot stop applying it - a crop handle must
        // not cost a re-prepare. What that costs is a second resample of an already resampled
        // frame, measured at mean 0.38 counts of 65535 against one fused gather
        // (`the_pipeline_places_a_pixel_where_one_fused_gather_would`).
        let cut = crate::base::gather_and_sharpen(
            gpu,
            base,
            frame,
            crate::base::Gather::frame(crate::px::Size::exact(width, height)),
            lens,
            sharpen,
            sharpen_sigma,
            sharpen_noise,
        );
        // No transfer at all: the grade reads this same buffer through
        // `gpu::upload_resident`, so the frame never leaves the device between the decode
        // and the graded readback.
        Cut {
            frame: CutFrame::Device(cut),
            width,
            height,
        }
    }

    /// A window that already crossed the bus - `tile::prepared`'s samples, which the editor
    /// path downloaded to hand to a client either way.
    pub fn host(samples: Vec<u16>, width: usize, height: usize) -> Cut {
        Cut {
            frame: CutFrame::Host(samples),
            width,
            height,
        }
    }

    /// A window that never crossed it: `tile::prepared_on_device`'s own buffer, already resized,
    /// warped and sharpened, and read from where it lies by the grade.
    pub fn device(frame: crate::resident::Resident, width: usize, height: usize) -> Cut {
        Cut {
            frame: CutFrame::Device(frame),
            width,
            height,
        }
    }

    /// The resident frame, where the cut is still on the device.
    pub(crate) fn resident(&self) -> Option<&crate::resident::Resident> {
        match &self.frame {
            CutFrame::Device(frame) => Some(frame),
            CutFrame::Host(_) => None,
        }
    }

    pub(crate) fn host_samples(&self) -> Option<&[u16]> {
        match &self.frame {
            CutFrame::Device(_) => None,
            CutFrame::Host(samples) => Some(samples),
        }
    }

    /// The samples on the host, downloading where they are still resident.
    ///
    /// The pins' spelling, not the render loop's: the loop grades the resident buffer where
    /// it lies, and a test that wants bytes to compare pays the one transfer here instead.
    pub fn into_samples(self) -> Vec<u16> {
        match self.frame {
            CutFrame::Device(frame) => {
                pollster::block_on(frame.into_host()).expect("the cut frame maps")
            }
            CutFrame::Host(samples) => samples,
        }
    }

    /// Hands the frame back, wherever it is; the cut stays sized but empty.
    pub fn release(&mut self) {
        match std::mem::replace(&mut self.frame, CutFrame::Host(Vec::new())) {
            CutFrame::Device(frame) => frame.reclaim(),
            CutFrame::Host(_) => {}
        }
    }

    /// A smaller rendition's frame, averaged out of this one.
    ///
    /// In light: `base::resize` decodes each tap through `light_of_code` and re-encodes the mean,
    /// so what comes out is what a lower-resolution sensor would have integrated rather than a mean
    /// of PQ codes, which on a specular is several times too dark.
    ///
    /// Off the cut above it rather than off the base, so a job naming three sizes pays one warp and
    /// two small reductions instead of three of each - and on the device, off a frame that is
    /// already there.
    pub fn downscale(&self, size: hdr_args::Size) -> Cut {
        let (width, height) = (size.width as usize, size.height as usize);
        match &self.frame {
            CutFrame::Device(frame) => {
                let gpu = frame.gpu();
                let base =
                    crate::base::device(gpu).expect("the device the pipelines were built on");
                match crate::base::resize(gpu, base, frame, (width, height)) {
                    Some(smaller) => Cut {
                        frame: CutFrame::Device(smaller),
                        width,
                        height,
                    },
                    None => Cut {
                        frame: CutFrame::Device(frame.duplicate()),
                        width: self.width,
                        height: self.height,
                    },
                }
            }
            CutFrame::Host(samples) => {
                match shrink(samples, (self.width, self.height), (width, height)) {
                    Some(samples) => Cut {
                        frame: CutFrame::Host(samples),
                        width,
                        height,
                    },
                    None => Cut {
                        frame: CutFrame::Host(samples.clone()),
                        width: self.width,
                        height: self.height,
                    },
                }
            }
        }
    }
}

/// Encodes samples that have already been graded and PQ-encoded, at the size they
/// arrived at.
///
/// `Cow` so a caller with an owned frame hands it over without a copy: it reaches libavif
/// directly and is dropped as soon as the YUV conversion has read it.
#[cfg(feature = "renditions")]
pub fn encode_frame(
    frame: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
    rotate: u16,
) -> Result<(), String> {
    crate::avif::save_still(frame, width, height, &still_options(options), &options.output_path, rotate)
}

/// [`encode_frame`] for a frame graded a band of whole rows at a time, written as a grid of them.
#[cfg(feature = "renditions")]
pub fn encode_bands(
    bands: Vec<Vec<u16>>,
    width: usize,
    options: &EncodeOptions,
    rotate: u16,
) -> Result<(), String> {
    crate::avif::save_still_bands(bands, width, &still_options(options), &options.output_path, rotate)
}

#[cfg(feature = "renditions")]
fn still_options(options: &EncodeOptions) -> crate::avif::StillOptions {
    // The transfer is already applied and PQ's output gamut is Rec.2020, which the grade
    // already works in, so all that is left between here and a file is the YCbCr matrix,
    // which libavif does.
    let (primaries, transfer, matrix) = hdr_args::cicp();
    crate::avif::StillOptions {
        cicp: crate::avif::Cicp {
            primaries,
            transfer,
            matrix,
        },
        format: options.still_chroma.avif_format(),
        quantizer: options.crf,
        speed: options.preset.min(10),
    }
}

/// The whole of one HDR still, from a scene-linear decode this takes ownership of.
///
/// For a caller with one frame and one rendition to make of it - the debug commands and the
/// pins. `job::run` does not go through here: it shares the decode, the levels, the camera
/// match and the filter across every rendition of a photo, and calls the same three stages
/// below with those already settled.
///
/// One file. Firefox needs the same bitstream wrapped as an MP4 to composite it, and does that
/// rewrap in the page against these very bytes - a second encode here would be libaom run twice
/// at the same settings over the same frame.
#[cfg(feature = "renditions")]
pub fn encode_still(
    samples: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> Result<(), String> {
    let gpu = crate::gpu::device().ok_or("no GPU adapter, and the shaders are the grade")?;
    let levels = levels_of(gpu, &samples, width, height, options.grade.white_quantile)
        .ok_or("the frame's levels could not be measured")?
        .anchored();
    let scene = neutral_scene(levels, options, matched);
    // Upright and uncropped: this path serves the pins and the debug renders, which measure the
    // pipeline rather than anybody's edit of it.
    let mut cut = cut_for(gpu, samples, width, height, options, matched, levels);

    let frame = encode_cut(
        gpu,
        &cut,
        &scene.gpu_grade(
            cut.width,
            cut.height,
            options.grade.peak_nits,
            crate::gpu::Output::Pq,
        ),
    );
    cut.release();
    encode_pq_frame(frame, cut.width, cut.height, options)
}

/// The transfer and the encode: everything a rolled HDR frame has left.
///
/// **Nothing filters here.** The denoise and the defringe ran on the coded base ahead of the
/// warp, and the sharpen ran on the frame every rendition is cut from (`Cut::from_base`) - which
/// is after the warp and the fit-to-size that apply the blur it deconvolves, and in a coding
/// that does not depend on which display this is for.
#[cfg(feature = "renditions")]
pub fn encode_pq_frame(
    frame: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
) -> Result<(), String> {
    encode_pq_frame_rotated(frame, width, height, options, 0)
}

#[cfg(feature = "renditions")]
pub fn encode_pq_frame_rotated(
    frame: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
    rotate: u16,
) -> Result<(), String> {
    // Handed over rather than lent, so libavif takes the frame rather than a copy of it.
    encode_frame(std::borrow::Cow::Owned(frame), width, height, options, rotate)
}
