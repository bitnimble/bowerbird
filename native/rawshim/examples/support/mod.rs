//! The library's shipped settings, open and grade, for examples that show what the library ships.
//! `rawshim::decode_frame`, `fit_hdr_for` and `hdr::graded_as` skip the denoise, dust or defringe
//! before the camera match, which moves the match.
#![allow(dead_code)]

use denoise::galosh::Detail;
use rawshim::hdr::Grade;
use rawshim::hdr_args::EncodeOptions;
use rawshim::image::Strengths;
use units::light::Light;

/// `hdr_reference_white_nits` and `hdr_white_quantile` in `src/schemas/settings.ts`.
pub const GRADE: Grade = Grade {
    reference_white_nits: Light::exactly(203.0),
    white_quantile: 0.9,
};

/// `EditDoc.sharpening`'s 50 over 100, as `developed.ts` sends it, and `raw_defringe`.
pub const STRENGTHS: Strengths = Strengths {
    sharpen: 0.5,
    defringe: 1.0,
};

/// `full_rendition_size`: the decode floor of the rendition a photograph is first rendered at, and
/// so the frame its stored camera match was fitted on.
pub const FULL_RENDITION_SIZE: u32 = 3840;

/// A RAW taken as far as `job::Base::build` takes it before the coding: decoded with the mosaic
/// denoised and its dust divided out, defringed, and measured by `open::measure`.
pub struct Open<'a> {
    pub path: &'a str,
    /// The decode's floor, as a rendition's largest target sets it. 0 is the sensor's own size.
    pub floor: u32,
    pub detail: Detail,
    pub strengths: Strengths,
    /// The pair to defringe by, in place of the one this frame measures.
    pub defocus: Option<(f32, f32)>,
    pub dust: denoise::dust::Wanted<'a>,
    /// Edits the decode's half-float samples before anything measures them, as a stage between the
    /// decode and the open would.
    pub edit: Option<&'a dyn Fn(&mut [u16])>,
    /// The camera match to apply in place of one fitted here. An `edit` needs the unedited frame's:
    /// the embedded JPEG still shows what the edit took out, and a fit to it puts that back.
    pub matched: Option<rawshim::hdr_fit::HdrMatch>,
}

pub struct Opened {
    /// Read back to the host. A RAW is already defringed and `measured.defringe` is `Done`; a
    /// rendered file is not, and carries `Measure` or `Take`.
    pub frame: rawshim::frame::Frame,
    pub measured: rawshim::open::Measured,
}

impl<'a> Open<'a> {
    /// A photograph nobody has edited, as the library renders it.
    pub fn shipped(path: &'a str, floor: u32) -> Open<'a> {
        Open {
            path,
            floor,
            detail: Detail::AUTO,
            strengths: STRENGTHS,
            defocus: None,
            dust: denoise::dust::Settings::default().wanted(None),
            edit: None,
            matched: None,
        }
    }

    pub fn run(self) -> Option<Opened> {
        let mut frame = rawshim::decode::frame_from_path(
            self.path,
            self.detail,
            self.floor,
            false,
            denoise::galosh::wanted(None, self.detail),
            self.dust,
        )?;
        if let Some(edit) = self.edit {
            frame = pollster::block_on(frame.to_host())?;
            let mut samples = frame.samples16()?.to_vec();
            edit(&mut samples);
            let gpu = gpu::device()?;
            // Back on the device, since the measure below defringes the frame it is given in place.
            frame.pixels = rawshim::frame::Pixels::Resident(colour::resident::Resident::upload(
                gpu,
                &samples,
                frame.width,
                frame.height,
            ));
        }
        // Handed over as a stored pair, which `open::measure` applies ahead of the fit.
        let long_edge = frame.width.max(frame.height);
        let stored = rawshim::photo_analysis::PhotoAnalysis {
            from_render: rawshim::photo_analysis::FromRender {
                defocus: self
                    .defocus
                    .map(|(red, blue)| rawshim::photo_analysis::MeasuredDefocus {
                        red,
                        blue,
                        defringe: self.strengths.defringe,
                        long_edge,
                    }),
                ..Default::default()
            },
            from_raw: rawshim::photo_analysis::FromRaw {
                matched: self.matched,
                ..Default::default()
            },
            ..Default::default()
        };
        let opening = rawshim::open::Opening {
            grade: GRADE,
            strengths: self.strengths,
            stored: &stored,
            fitting: match formats::rendered::is_rendered(self.path) {
                true => rawshim::open::Fitting::None,
                false => rawshim::open::Fitting::Profiled(self.path),
            },
            camera_match: rawshim::hdr_fit::CameraMatch::LensAndColour,
            noise: frame.noise,
            matrix: frame.matrix,
            as_shot: frame.as_shot,
            neutral_ceiling: frame.neutral_ceiling,
        };
        let measured = pollster::block_on(rawshim::open::measure(frame.resident()?, &opening))
            .inspect_err(|why| eprintln!("{}: {why}", self.path))
            .ok()?;
        let frame = pollster::block_on(frame.to_host())?;
        Some(Opened { frame, measured })
    }
}

/// The opened frame graded as `job::run` grades a rendition with nobody's edit on it.
///
/// Use this, not `hdr::graded_as`, which skips the defringe and sharpens at a fixed sigma with no
/// noise table.
pub fn graded(
    opened: &Opened,
    options: &EncodeOptions,
    output: rawshim::grade::Output,
) -> (Vec<u16>, usize, usize) {
    graded_under(opened, options, output, rawshim::grade::Intent::default())
}

pub fn graded_under(
    opened: &Opened,
    options: &EncodeOptions,
    output: rawshim::grade::Output,
    intent: rawshim::grade::Intent,
) -> (Vec<u16>, usize, usize) {
    let gpu = gpu::device().expect("a Vulkan adapter, since the grade is a shader");
    let matched = opened.measured.matched.as_ref();
    let mut cutting = cut(opened, options, matched.map(|m| &m.lens));
    let scene = rawshim::grade::SceneGrade::new(
        matched.and_then(|m| m.colour.as_ref()),
        opened.measured.levels.anchored(),
        options.grade.reference_white_nits,
        None,
        rawshim::grade::Adjust {
            camera_balance: true,
            ..rawshim::grade::Adjust::none()
        },
        opened.frame.as_shot,
    );
    let (width, height) = (cutting.cut.width, cutting.cut.height);
    let coded = rawshim::hdr::encode_cut(
        gpu,
        &cutting.cut,
        &rawshim::grade::Grade {
            intent,
            ..scene.gpu_grade(width, height, output)
        },
    );
    cutting.cut.release();
    (coded, width, height)
}

pub struct Cutting {
    pub cut: rawshim::hdr::Cut,
    /// The open's measured blur, in the sensor's pixels.
    pub capture_sigma: Option<f32>,
    pub sigma: rawshim::image::SharpenSigma,
}

/// `job::Base::build`'s coding, then the fit to size, warp and sharpen a rendition takes.
///
/// One size, cut from the base: a job with several targets cuts and sharpens its largest and
/// downscales the rest from it.
///
/// `options.sharpen_sigma` fixes the deconvolution's sigma in place of the measured one.
pub fn cut(
    opened: &Opened,
    options: &EncodeOptions,
    lens: Option<&geometry::lens::Lens>,
) -> Cutting {
    let frame = &opened.frame;
    let gpu = gpu::device().expect("a Vulkan adapter, since the grade is a shader");
    let base = rawshim::base::device(gpu).expect("the device the pipelines were built on");
    let levels = opened.measured.levels.anchored();
    let size = rawshim::hdr_args::target_size(frame.width as u32, frame.height as u32, options);
    let sensor_long = frame.width.max(frame.height) * frame.reduced.max(1);
    let capture_sigma = opened
        .measured
        .blur
        .map(|blur| blur * frame.reduced.max(1) as f32);
    let sigma = match options.sharpen_sigma {
        Some(fixed) => rawshim::image::SharpenSigma::fixed(fixed),
        None => rawshim::image::deconvolve_split(
            capture_sigma,
            sensor_long,
            size.width.max(size.height) as usize,
        ),
    };
    let sharpen_noise = rawshim::base::sharpen_noise(
        levels,
        options.grade.reference_white_nits,
        frame.noise,
        frame.noise_left,
        frame.matrix,
        frame.wb_gains,
        frame.reduced,
    )
    .at(
        units::px::Span::<units::px::Sensor>::exact(sensor_long),
        units::px::Span::<units::px::Drawn>::exact(size.width.max(size.height) as usize),
    );
    let resident = colour::resident::Resident::upload(
        gpu,
        frame.samples16().expect("16-bit"),
        frame.width,
        frame.height,
    );
    // No lens: a rendition warps per target, in `Cut::from_base`.
    let (prepared, _) = pollster::block_on(rawshim::base::prepare(
        gpu,
        base,
        resident,
        rawshim::base::Gather::frame(units::px::Size::exact(frame.width, frame.height)),
        levels,
        options.grade.reference_white_nits,
        // Sharpen held back for `Cut::from_base`, after the warp.
        options.strengths.before_the_fit(),
        rawshim::image::SharpenSigma::fixed(rawshim::image::DECONVOLVE_SIGMA),
        rawshim::image::SharpenNoise::NONE,
        &geometry::lens::Lens::none(),
        opened.measured.defringe,
        frame.noise,
        frame.matrix,
    ))
    .expect("the coding");
    Cutting {
        cut: rawshim::hdr::Cut::from_base(
            prepared,
            lens,
            size,
            options.strengths.sharpen,
            sigma,
            sharpen_noise,
        ),
        capture_sigma,
        sigma,
    }
}
