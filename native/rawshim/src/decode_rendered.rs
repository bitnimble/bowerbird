//! Reading a photograph that arrives already rendered: PNG, JPEG, HEIC and AVIF.
//!
//! **The rendered counterpart of `decode_rawler`, and it stops at the same place.** That module
//! holds a RAW at the conditioned mosaic, where a Detail slider is the next thing that can move;
//! this one holds a finished picture at its code values, where nothing above the transfer can move
//! at all. Both hand the pipeline the same thing - a scene-linear Rec.2020 frame on the device -
//! and everything below the two is one implementation.
//!
//! **What a finished picture does not have**, and therefore what it does not run: a mosaic. So no
//! GALOSH, no dust search, no demosaic, no camera matrix to fit, and no recorded as-shot
//! illuminant: its white balance moves away from the white it was rendered to
//! ([`colour::white_balance::RENDERED_WHITE`]). What it does run is everything below those: the
//! coding, the defringe, the lens gather, the sharpen, the grade, the crop and the roll-off -
//! which is most of the pipeline and all of the editor.
//!
//! A linear DNG is held here too, since a camera demosaiced it before it was written, and it is
//! the one picture that keeps the as-shot illuminant its camera recorded ([`Camera`]). What each
//! container's file says is `formats::rendered`'s to read.

use formats::rendered::{Read, coding_of, pixels_read, read, read_heif};

/// A finished picture opened and kept where the kernel can reach it.
///
/// **The rendered arm of `decode_rawler::Held`, and the pair is what `decode::Held` routes
/// between.** A RAW stops at the mosaic because the Detail sliders live below it; this stops at
/// the code values because nothing above the transfer can move at all. Both answer the same
/// questions, and a caller above them asks without knowing which it has.
pub struct Held {
    picture: crate::linearise::Picture,
    /// Only a linear DNG's, which is a camera's counts rather than a rendering of them.
    camera: Option<Camera>,
}

/// What a picture demosaiced before it was written still says about the sensor behind it.
pub struct Camera {
    pub as_shot: Option<colour::white_balance::Illuminant>,
    /// Where each channel saturates on the frame's scale, as `decode_rawler::channel_ceilings`
    /// states a RAW's.
    pub ceiling: [f32; 3],
}

impl Held {
    pub fn camera(picture: crate::linearise::Picture, camera: Camera) -> Held {
        Held {
            picture,
            camera: Some(camera),
        }
    }
}

/// Opens a finished picture as far as the device, which is as far as any setting is irrelevant.
pub fn hold(bytes: &[u8]) -> Result<Held, String> {
    holding(read(bytes)?)
}

/// The same, for a caller that already has the samples: a RAW's embedded preview, decoded and
/// turned upright by `decode_rawler::upright_preview_rgb`, is a finished picture that never was a
/// file. Re-encoding one to hand it to `hold` costs a full-size encode and a second decode.
pub fn holding(read: Read) -> Result<Held, String> {
    let gpu = gpu::device()
        .ok_or_else(|| render::base::without_a_device("reading a finished picture"))?;
    let picture = crate::linearise::Picture::upload(
        gpu,
        read.codes,
        read.width,
        read.height,
        read.coding,
        read.turn,
        read.gain,
    )
    .ok_or("this picture decoded to nothing")?;
    Ok(Held {
        picture,
        camera: None,
    })
}

/// An AVIF the page decoded itself: `avif` for what the container says around the pixels, and the
/// planes its `ImageDecoder` handed back.
///
/// No gain map: a rendition's base is the HDR picture, so the map would only lead away from it.
pub fn hold_planes(
    avif: &[u8],
    planes: &[u8],
    layout: &formats::planes::Layout,
) -> Result<Held, String> {
    let gpu = gpu::device()
        .ok_or_else(|| render::base::without_a_device("reading a decoded rendition"))?;
    let primary = read_heif(avif)?.primary;
    let codes = formats::planes::codes(gpu, planes, layout)?;
    let turn = formats::orientation::of_heif(primary.turn);
    let picture =
        crate::linearise::Picture::on_device(gpu, codes, coding_of(&primary, 16), turn, None);
    Ok(Held {
        picture,
        camera: None,
    })
}

/// An SDR AVIF the page decoded to RGBA itself, upright: `avif` for what the container says its
/// colour is.
pub fn hold_pixels(avif: &[u8], rgba: &[u8], width: usize, height: usize) -> Result<Held, String> {
    holding(pixels_read(avif, rgba, width, height)?)
}

impl Held {
    /// The picture's size the way a reader sees it.
    pub fn size(&self) -> units::px::Size<units::px::Photograph> {
        self.picture.upright_size()
    }

    /// The brightest level the file can state ([`crate::linearise::Picture::peak_level`]).
    pub fn peak_level(&self) -> Option<units::light::Light<units::light::Level>> {
        self.picture.peak_level()
    }

    /// One window of it, as the scene-linear frame every stage below a decode reads.
    ///
    /// **The Detail amounts are not arguments here, and that is the point.** GALOSH is fitted to a
    /// photosite's own noise on the CFA and the dust search reads the same lattice; a picture that
    /// has been demosaiced by somebody else's camera has neither, so a slider that moved either
    /// would be filtering a reconstruction and calling it the sensor.
    pub fn window(
        &self,
        window: units::px::Rect<units::px::Photograph>,
        scale: crate::view::Scale,
    ) -> Option<crate::frame::Frame> {
        let gpu = gpu::device()?;
        let resident = self
            .picture
            .window(gpu, crate::linearise::device(gpu), window, scale)?;
        Some(crate::frame::Frame {
            width: resident.width,
            height: resident.height,
            pixels: crate::frame::Pixels::Resident(resident),
            // **Reported, and it has to be.** What every reader of this field does with it is
            // scale a blur sigma back to the photograph's own pixels, and that pair is kept
            // beside the photograph and reused by every later rendition - so a frame that halved
            // and did not say would have its sigma stored at twice the width it was measured at,
            // and the next render at full size would sharpen through it.
            // A finished picture has no mosaic, so this is the resample's own factor rather than a
            // pattern's: the scale asked for and nothing to do with 2x2 sites.
            reduced: match scale == crate::view::Scale::Half {
                true => 2,
                false => 1,
            },
            as_shot: self
                .camera
                .as_ref()
                .map_or(Some(colour::white_balance::RENDERED_WHITE), |camera| {
                    camera.as_shot
                }),
            noise: None,
            noise_left: 1.0,
            dust: None,
            // RCD did not run, so there is no reconstruction matrix for the defringe to propagate
            // its channel correlations through; it falls back to its own estimate.
            matrix: None,
            // One, which is what the field means for a frame whose white balance was applied by
            // somebody else's camera: all three channels clip at full scale together. A linear
            // DNG's balance is the table's, so its channels keep a RAW's separate ceilings.
            neutral_ceiling: self.camera.as_ref().map_or(1.0, |camera| {
                camera.ceiling.iter().copied().fold(f32::INFINITY, f32::min)
            }),
            wb_gains: self
                .camera
                .as_ref()
                .map_or([1.0; 3], |camera| camera.ceiling),
            // A finished picture states its white at full scale; a linear DNG's is a quantile of
            // its scene, as a RAW's is.
            stated_white: match self.camera {
                Some(_) => None,
                None => Some(units::light::Light::measured(colour::transfer::FULL_SCALE)),
            },
        })
    }
}

