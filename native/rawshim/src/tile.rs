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
    pub denoise_luminance: f64,
    pub denoise_colour: f64,
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
    #[serde(default)]
    pub camera_match: Option<Vec<u8>>,
}

impl TileRequest {
    fn amounts(&self) -> crate::galosh::Amounts {
        crate::galosh::Amounts::from_sliders(self.denoise_luminance, self.denoise_colour)
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
    /// The photograph the window is a piece of, which is the scale the presence sliders read at.
    pub photograph: (usize, usize),
    /// The library's reference white, which the coding above already used.
    reference_nits: f64,
}

impl Prepared {
    /// The scene this window is graded as part of: the photograph's colour and levels, with the
    /// reader's own exposure and sliders.
    pub fn scene(
        &self,
        exposure: f64,
        adjust: crate::gpu::Adjust,
    ) -> crate::tone::SceneGrade<'_> {
        crate::tone::SceneGrade::new(
            self.matched.as_ref().map(|m| &m.colour),
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
        peak_nits: f64,
        output: crate::gpu::Output,
    ) -> crate::gpu::Grade<'a> {
        crate::gpu::Grade {
            // The photograph's, where this frame is a window on one: `detail.wgsl` blurs at a
            // fraction of it, and a tile answering from its own dimensions would apply a Clarity
            // twelve times finer than the export's.
            photograph_long: self.photograph.0.max(self.photograph.1),
            ..scene.gpu_grade(self.width, self.height, peak_nits, output)
        }
    }
}

/// Where the RAW is: a file this process can open, or bytes a page already holds.
pub enum Source<'a> {
    Path(&'a str),
    Bytes(&'a [u8]),
}

/// The window, decoded and filtered, with the turn already taken.
pub fn prepared(source: Source<'_>, request: &TileRequest) -> Result<Prepared, String> {
    pollster::block_on(prepared_async(source, request))
}

/// The same, awaited, which is the only spelling a browser can take
/// ([`crate::edit::prepare_bytes_async`] says why).
pub async fn prepared_async(
    source: Source<'_>,
    request: &TileRequest,
) -> Result<Prepared, String> {
    let grown = grown(request)?;
    let amounts = request.amounts();
    // `noise_fit` is the photograph's, measured at the editor's open and handed back with the
    // request: a tile that fits its own is denoised at its own crop's strength rather than at the
    // photograph's, which is a loupe that disagrees with the export it exists to predict and
    // changes as the reader pans. Refused rather than trusted where it does not describe a sensor,
    // since it crosses an API from a client.
    let fit = request
        .noise_fit
        .filter(crate::galosh::NoiseFit::usable)
        .map_or(crate::galosh::Fit::Measure, crate::galosh::Fit::Given);
    // The rendition's halo, not the editor's, though a loupe is an editor feature: what it is for
    // is showing what the export will be, and a magnifier denoised to a different standard from
    // the export is one that lies.
    let halo = crate::RENDITION_TILE_HALO;
    let frame = match source {
        Source::Path(path) => {
            crate::decode_rawler::decode_tile_path_async(path, grown.decode, amounts, fit, halo)
                .await
        }
        Source::Bytes(bytes) => {
            crate::decode_rawler::decode_tile_bytes_async(bytes, grown.decode, amounts, fit, halo)
                .await
        }
    }
    .ok_or("could not decode the RAW scene-linear")?;

    let (width, height) = (frame.width, frame.height);
    // What came back is the rectangle that was asked for, or nothing is: `decode_tile` trims its
    // region to whole CFA sites and takes the trim off the *far* edge, so a region flush against
    // the sensor's own can come back a pixel short - and everything below is sized from the window
    // rather than from this, down to the buffer the GPU is handed. Refused rather than corrected,
    // because a tile one pixel narrower than the reader asked for is not the rectangle the glass
    // is drawing.
    if (width, height) != (grown.decode.width, grown.decode.height) {
        return Err(format!(
            "the decoder answered {width}x{height} for a {}x{} region",
            grown.decode.width, grown.decode.height,
        ));
    }

    let as_shot = frame.as_shot;
    let mut samples = frame.into_samples16().ok_or("a tile needs a 16-bit scene-linear decode")?;
    // The editor's, where it sent them: a quantile of a crop describes where the reader is
    // pointing rather than the photograph, so a tile measuring its own is graded against a white
    // that changes as the loupe moves - and over anything dark, against one far below the frame's,
    // which lifts the crop to reference white.
    let levels = match request.levels.filter(crate::tone::Levels::usable) {
        Some(given) => given,
        None => crate::tone::levels(&samples, request.grade.white_quantile),
    }
    .anchored();
    // Coded against those levels and defringed, as `job::Base::build` codes a whole frame: no lens
    // here, because a window's warp is the photograph's own over that window and happens below.
    let strengths = request.strengths.before_the_fit();
    let chained = match crate::gpu::device().and_then(crate::base::device) {
        Some(base) => {
            let gpu = crate::gpu::device().expect("the device the pipelines were built on");
            crate::base::prepare(
                gpu,
                base,
                &samples,
                (width, height),
                (width, height),
                levels,
                request.grade.reference_white_nits,
                strengths,
                &crate::fit::Lens::none(),
            )
            .await
        }
        None => None,
    };
    match chained {
        Some(prepared) => samples = prepared,
        None => {
            crate::base::declined("the coding and the defringe");
            crate::tone::encode_base(&mut samples, levels, request.grade.reference_white_nits);
            crate::hdr::filter_base(&mut samples, width, height, strengths);
        }
    }

    // The frame's own gather, over this window of it. Not `Cut::from_base`, which would take the
    // crop for the whole photograph and correct it at its own radius; the reader's geometry is not
    // applied either, because a tile is named in coordinates that already carry it.
    let mut cut = crate::hdr::Cut {
        samples: match grown.lens.as_ref().and_then(|lens| {
            crate::image::PlanarWarp::for_lens_window(
                grown.frame,
                grown.window,
                (grown.decode.left, grown.decode.top, width, height),
                lens,
                crate::image::Sampling::Bicubic,
            )
        }) {
            Some(warp) => warp.apply_u16(&samples),
            // No optics to correct, so the region decoded is the window itself.
            None => samples,
        },
        width: grown.window.2,
        height: grown.window.3,
    };
    // As `job::run` sharpens, and where it sharpens: the deconvolution undoes the *gather's* own
    // resample, so it belongs after it and before the colour transform. A tile skipped it
    // entirely, and showed a softer photograph than the export at the one magnification a reader
    // could have seen the difference at.
    cut.sharpen(request.strengths.sharpen);

    Ok(Prepared {
        samples: cut.samples,
        width: cut.width,
        height: cut.height,
        keep: grown.keep,
        levels,
        matched: grown.matched,
        as_shot,
        photograph: grown.frame,
        reference_nits: request.grade.reference_white_nits,
    })
}

/// What a tile request becomes: a region to decode, the window of the corrected frame to build out
/// of it, and where the rectangle actually asked for sits inside that window.
struct Grown {
    /// The part of the *uncorrected* frame to decode, which the lens decides.
    decode: crate::Tile,
    /// The window of the corrected frame to produce: `(left, top, width, height)` in the
    /// photograph's own pixels.
    window: (usize, usize, usize, usize),
    /// `[left, top, width, height]` of the asked-for tile within that window.
    keep: [usize; 4],
    /// The photograph the window is a piece of.
    frame: (usize, usize),
    /// Its match, decoded once here so the footprint, the gather and the grade cannot disagree
    /// about whether there is a lens.
    matched: Option<crate::hdr_fit::HdrMatch>,
    /// Its lens, where that match carries one worth applying.
    lens: Option<crate::fit::Lens>,
}

/// How far past a tile the presence sliders read, in the photograph's pixels.
///
/// **The guided filter is two windows deep**, and both are fractions of the working texture the
/// blur is built on - so in the picture's own pixels the reach is that fraction of the whole
/// photograph, whatever size the frame holding it is. A tile without it fits its models against
/// an edge the photograph does not have, and the Clarity along the rim of the glass is a filter
/// looking at nothing.
///
/// Zero where none of the three is asked for, which is what most tiles are: this is four times
/// the decode for a 400px tile, and it buys nothing at all when the sliders are at rest.
fn presence_reach(adjust: &crate::gpu::Adjust, frame: (usize, usize)) -> usize {
    let presence = [adjust.clarity, adjust.texture, adjust.dehaze];
    if presence.iter().all(|value| *value == 0.0) {
        return 0;
    }
    let long = frame.0.max(frame.1);
    let working = crate::gpu::detail_long(long);
    // Texels of the working texture, then back into the photograph's own pixels at the rate that
    // texture shrinks it by - rounded up, because a reach one pixel short is a filtered edge.
    crate::gpu::detail_reach(working) * long.div_ceil(working.max(1) as usize)
}

/// Everything a tile's rectangle implies, before anything is read off the disk.
///
/// **A tile is a rectangle of the corrected picture, not of the sensor.** That is what the client
/// names - its frame is `edit::open`'s, with the lens already materialised into it - and what a
/// rendition would write there. Two things follow, and neither was true before:
///
/// - The gather has to be the *frame's*, over this window ([`crate::image::PlanarWarp::for_lens_window`]).
///   A crop warped as though it were the photograph corrects at the wrong radius and lifts its own
///   corners as if they were the frame's.
/// - What to decode is then whatever that window gathers *from*, which the warp itself answers.
///   The distortion moves a corner of a 24MP frame by tens of pixels, so the region is not the
///   window and cannot be assumed to be.
///
/// On top of that the window is grown by the reach of everything that runs after the gather. **A
/// deconvolution reads 42 pixels past what it writes** (`image::Strengths::halo`): the decode's
/// own halo is eaten by the demosaic and the mosaic denoise long before the sharpen, so a tile
/// built at exactly the rectangle asked for rings along all four edges - and the loupe's tile is
/// only half again its glass, so at high magnification that ringing is inside what the reader is
/// looking at. The window is cut back to `keep` once every one of those stages has run.
///
/// Refuses a rectangle that is not inside the photograph.
fn grown(request: &TileRequest) -> Result<Grown, String> {
    let [left, top, width, height] = request.tile;
    let frame = (request.frame[0], request.frame[1]);
    if frame.0 == 0 || frame.1 == 0 {
        return Err("a tile needs the size of the photograph it is a piece of".to_string());
    }
    if left + width > frame.0 || top + height > frame.1 {
        return Err(format!(
            "a tile of {width}x{height} at {left},{top} is outside a {}x{} photograph",
            frame.0, frame.1,
        ));
    }
    let matched = request.camera_match.as_deref().and_then(crate::camera_match::decode);
    let lens = matched
        .as_ref()
        .map(|matched| matched.lens.clone())
        .filter(|lens| !lens.is_identity());

    // **Added, not maxed: the two stages are sequential and each reads what the one before it
    // wrote.** The blur the presence sliders read is built from the *sharpened* window, so a kept
    // pixel needs every pixel the blur averages into it to be far enough inside the window that
    // the deconvolution had real context there - the blur's reach *plus* the sharpen's, not
    // whichever is larger. At `max` the outermost 42 pixels of the window are sharpened against a
    // clamped edge and the blur reads them, which is a tile that differs from its export in
    // exactly the case a reader is most likely to have set up: Clarity on a sharpened photograph.
    let reach = request.strengths.halo() + presence_reach(&request.adjust, frame);
    // Down to a whole texel of the blur's working texture, which is what lets that texture be the
    // photograph's own texels rather than a set of its own between them (`gpu::detail_step`).
    let step = crate::gpu::detail_step(frame.0.max(frame.1)) as usize;
    let start = |value: usize| (value.saturating_sub(reach) / step) * step;
    let (window_left, window_top) = (start(left), start(top));
    let window = (
        window_left,
        window_top,
        (left + width + reach).min(frame.0) - window_left,
        (top + height + reach).min(frame.1) - window_top,
    );
    let keep = [left - window_left, top - window_top, width, height];

    // What that window reads. Built against the whole frame first because the answer is the
    // question - the gather has to exist before it can say what it gathers from - and it is a
    // couple of tables either way.
    let decode = match lens.as_ref().and_then(|lens| {
        crate::image::PlanarWarp::for_lens_window(
            frame,
            window,
            (0, 0, frame.0, frame.1),
            lens,
            crate::image::Sampling::Bicubic,
        )
    }) {
        Some(probe) => probe.footprint(),
        // Nothing to correct, so the window is its own region.
        None => window,
    };

    Ok(Grown {
        decode: crate::Tile { left: decode.0, top: decode.1, width: decode.2, height: decode.3 },
        window,
        keep,
        frame,
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
                peak_nits: 1000.0,
                reference_white_nits: 203.0,
                white_quantile: 0.995,
            },
            strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
            denoise_luminance: 20.0,
            denoise_colour: 30.0,
            adjust: crate::gpu::Adjust::none(),
            levels: None,
            noise_fit: None,
            camera_match: None,
        }
    }

    /// The window holds the rectangle asked for and the reach of everything that runs after the
    /// gather, and the rectangle is where the caller is told it is.
    ///
    /// **This is what a loupe tile is, as arithmetic**, and it is why nothing in the browser has to
    /// be opened to ask: the sharpen reads 42 pixels past what it writes, so a tile cut at exactly
    /// the rectangle rings along all four edges - and the glass is only half again the rectangle,
    /// so at magnification that ringing is inside what the reader is looking at.
    #[test]
    fn the_window_carries_the_rectangle_and_what_reads_past_it() {
        let asked = [2000, 1500, 512, 512];
        let grown = grown(&asking(asked)).expect("a rectangle inside the photograph");
        let (left, top, width, height) = grown.window;

        assert!(width > 512 && height > 512, "the window did not grow: {width}x{height}");
        assert_eq!([grown.keep[2], grown.keep[3]], [512, 512], "the rectangle changed size");
        // Where the rectangle sits inside the window, in the window's own pixels.
        assert_eq!(left + grown.keep[0], asked[0]);
        assert_eq!(top + grown.keep[1], asked[1]);
        assert!(grown.keep[0] + grown.keep[2] <= width);
        assert!(grown.keep[1] + grown.keep[3] <= height);
        assert!(left + width <= 6000 && top + height <= 4000, "the window left the photograph");
        // No lens, so what is decoded is the window itself.
        assert_eq!(
            (grown.decode.left, grown.decode.top, grown.decode.width, grown.decode.height),
            grown.window,
        );
    }

    /// The presence sliders reach hundreds of pixels further than the sharpen, at the
    /// *photograph's* scale, and cost that much more decode - so they are paid for only when one
    /// of the three is off zero, which most tiles are.
    #[test]
    fn the_presence_sliders_grow_the_window_and_nothing_else_does() {
        let asked = [2000, 1500, 512, 512];
        let quiet = grown(&asking(asked)).expect("a tile");
        let mut wants_clarity = asking(asked);
        wants_clarity.adjust = crate::gpu::Adjust { clarity: 60.0, ..crate::gpu::Adjust::none() };
        let clarity = grown(&wants_clarity).expect("a tile");

        assert!(
            clarity.window.2 > quiet.window.2 + 100,
            "clarity read no further than the sharpen: {} against {}",
            clarity.window.2,
            quiet.window.2,
        );
        assert_eq!([clarity.keep[2], clarity.keep[3]], [512, 512]);
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
