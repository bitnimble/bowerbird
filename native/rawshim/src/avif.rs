// The still's encode, in this process (DESIGN 10.7).
//
// libavif is what puts the nclx `colr` box on the file - the thing Chrome reads to
// decide a still is HDR, and the whole reason ffmpeg's avif muxer cannot write these.
// Linked rather than spawned, so the graded frame reaches it as a pointer instead of
// being written out, converted and read back: 56MB at 3840 and ~366MB at native
// resolution, moved for a picture no process wanted kept.
//
// Nothing about the conversion is reimplemented here. The PQ transfer is `tone::pq`, the
// same curve the grade rolls highlights with; the sRGB transfer and the
// Rec.2020-to-BT.709 primaries matrix are `hdr_fit`'s, which has needed both all along
// because the fit measures its deltaE in sRGB; and the YCbCr matrix with its
// limited-range quantisation is libavif's own `avifImageRGBToYUV`.

use crate::raw;
use crate::rgb::Rgb;

/// CICP, the only signalling that matters (`hdr_args::cicp`).
pub struct Cicp {
    pub primaries: u16,
    pub transfer: u16,
    pub matrix: u16,
}

pub struct StillOptions {
    pub cicp: Cicp,
    /// From the still's chroma setting (`hdr_args::Chroma`).
    pub format: raw::avifPixelFormat,
    /// libaom's quantizer.
    pub quantizer: i32,
    /// libavif's encoder speed, 0 slowest and 10 fastest.
    pub speed: i32,
}

const AVIF_RANGE_LIMITED: raw::avifRange = raw::avifRange::AVIF_RANGE_LIMITED;
/// What an ordinary 8-bit picture uses, and what libheif was writing. Limited range
/// spends 7% of the code values on headroom a still has no use for, and it costs
/// measurably: the same quantizer scored SSIM 0.878 limited against 0.902 full.
const AVIF_RANGE_FULL: raw::avifRange = raw::avifRange::AVIF_RANGE_FULL;
/// The depth every HDR still is written at, and it is twelve rather than ten because ten is
/// not finer than the eight-bit SDR it replaces: at the luminance of a daylit sky one 10-bit
/// PQ code is 1.13% of the light it sits on against sRGB 8-bit's 1.15%, since PQ spends the
/// extra codes on the range up to 10000 nits rather than on the range a photograph occupies.
/// Twelve bits is 0.28%, and is the first depth here that can carry a gradient the encoder
/// has not already flattened.
///
/// **AV1 Professional profile**, which is software-decoded almost everywhere - Main is what
/// hardware takes. Chrome decodes it by both the `<img>` and `ImageDecoder` routes, measured;
/// `stage_gpu.ts` reads the frame's depth back off the format and scales for it.
const AVIF_DEPTH: u32 = 12;
const AVIF_PIXEL_FORMAT_YUV444: raw::avifPixelFormat = raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV444;
const AVIF_PIXEL_FORMAT_YUV420: raw::avifPixelFormat = raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV420;
const AVIF_RGB_FORMAT_RGB: raw::avifRGBFormat = raw::avifRGBFormat::AVIF_RGB_FORMAT_RGB;
/// libsharpyuv's solver for the 4:2:0 chroma, in place of a 2x2 box average; a no-op at 4:4:4.
///
/// **The box average is what speckles a saturated red.** Chroma is stored once per 2x2 and Y'
/// once per pixel, so a decoder reconstructs each pixel's R' as `R' − 0.737·ΔR' + 0.678·ΔG' +
/// 0.059·ΔB'`, Δ being the pixel's departure from its block's mean - the green channel's
/// per-pixel swing lands in red at two thirds. Where a colour sits at the gamut floor, G' is
/// clipped to 0 on half the pixels and PQ's foot makes the other half's residual noise thousands
/// of codes, so the averaged block hands the bright channel a hard speckle it never had:
/// measured on a red hood, R's 99th-percentile Laplacian went 2174 codes to 8630 through a
/// *lossless* 4:2:0 encode, and was unchanged through 4:4:4. The solver picks the block's chroma
/// so that the reconstruction lands closest to the source given each pixel's own Y', which is the
/// leak term.
const AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV: raw::avifChromaDownsampling =
    raw::avifChromaDownsampling::AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV;
/// The curve that solver works under, sRGB's for every file, a PQ still's included.
const SHARP_YUV_TRANSFER: u16 = 13;
const AVIF_RESULT_OK: raw::avifResult = raw::avifResult::AVIF_RESULT_OK;
// A flag set is a `uint32_t` typedef beside its enum, so its bits are written as that typedef: the
// enum's `.0` is `unsigned` to the Unixes and `int` to MSVC, and fits only on the first.
const AVIF_PLANES_YUV: raw::avifPlanesFlags = 1;
const AVIF_ADD_IMAGE_FLAG_SINGLE: raw::avifAddImageFlags = 1 << 1;
const AVIF_TRANSFORM_IROT: u32 = 1 << 2;
/// `avifImageContentTypeFlag`'s gain map bit, which decoding one is off without.
const AVIF_IMAGE_CONTENT_GAIN_MAP: u32 = 1 << 2;

fn max_threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(1)
}

/// libavif's decoder, freed when it leaves scope.
pub(crate) struct Decoder(pub(crate) *mut raw::avifDecoder);

impl Decoder {
    pub(crate) fn new() -> Result<Decoder, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::avifDecoderCreate() };
        match handle.is_null() {
            true => Err("libavif would not allocate a decoder".to_string()),
            false => Ok(Decoder(handle)),
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: built by `avifDecoderCreate` in `new` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifDecoderDestroy(self.0);
        }
    }
}

/// One libavif image, freed when it leaves scope.
pub(crate) struct Image(pub(crate) *mut raw::avifImage);

impl Image {
    /// The shape a decode fills in for itself.
    pub(crate) fn empty() -> Result<Image, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::avifImageCreateEmpty() };
        Image::owning(handle)
    }

    /// Room for a frame an encode is about to write.
    pub(crate) fn sized(
        width: u32,
        height: u32,
        depth: u32,
        format: raw::avifPixelFormat,
    ) -> Result<Image, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::avifImageCreate(width, height, depth, format) };
        Image::owning(handle)
    }

    fn owning(handle: *mut raw::avifImage) -> Result<Image, String> {
        match handle.is_null() {
            true => Err("libavif would not allocate an image".to_string()),
            false => Ok(Image(handle)),
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        // SAFETY: built by libavif in `empty` or `sized` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifImageDestroy(self.0);
        }
    }
}

/// libavif's encoder, freed when it leaves scope.
pub(crate) struct Encoder(pub(crate) *mut raw::avifEncoder);

impl Encoder {
    pub(crate) fn new() -> Result<Encoder, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::avifEncoderCreate() };
        match handle.is_null() {
            true => Err("libavif would not allocate an encoder".to_string()),
            false => Ok(Encoder(handle)),
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: built by `avifEncoderCreate` in `new` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifEncoderDestroy(self.0);
        }
    }
}

/// The buffer libavif builds a file in.
pub(crate) struct Output(pub(crate) raw::avifRWData);

impl Output {
    pub(crate) fn empty() -> Output {
        // SAFETY: `avifRWData` is a pointer and a length, and all-zero is the empty one libavif
        // documents as the starting state.
        #[expect(unsafe_code)]
        let zeroed = unsafe { std::mem::zeroed::<raw::avifRWData>() };
        Output(zeroed)
    }

    /// What libavif wrote, copied out.
    pub(crate) fn bytes(&self) -> Option<Vec<u8>> {
        if self.0.data.is_null() {
            return None;
        }
        // SAFETY: libavif filled `data` with `size` bytes and neither changes until it is freed.
        #[expect(unsafe_code)]
        let written = unsafe { std::slice::from_raw_parts(self.0.data, self.0.size) };
        Some(written.to_vec())
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        // A write that failed part way has already allocated, and `avifRWDataFree` is defined on
        // a zeroed struct, so this frees on every path without the caller deciding.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifRWDataFree(&mut self.0);
        }
    }
}

/// Decodes an AVIF back to interleaved 8-bit RGB.
///
/// Here because a rendition is stored as AVIF and a download asks for JPEG, so something has to
/// read one. Doing it with libvips is what makes a photo server link libheif, ImageMagick and
/// poppler; reading with the library that wrote the file also keeps a second AV1 implementation
/// out of the process.
///
/// 8-bit RGB out of whatever depth is in the file: libavif scales during the YUV
/// conversion. No tone mapping and no transfer applied - an SDR rendition is already sRGB,
/// and a PQ still hands back its PQ code values, which is what libheif did too.
///
pub fn decode(bytes: &[u8]) -> Result<Rgb, String> {
    let (data, width, height) = decode_at(bytes, 8)?;
    Ok(Rgb { width, height, data: data.iter().map(|v| *v as u8).collect() })
}

/// The EXIF block an AVIF carries, read off the container without decoding a pixel.
pub fn exif(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoder = Decoder::new().ok()?;
    // SAFETY: the decoder is live for the block and reads `bytes`, which outlives it; the image it
    // parses into is its own, and the EXIF is copied out before either is freed.
    #[expect(unsafe_code)]
    unsafe {
        if raw::avifDecoderSetIOMemory(decoder.0, bytes.as_ptr(), bytes.len()) != AVIF_RESULT_OK
            || raw::avifDecoderParse(decoder.0) != AVIF_RESULT_OK
        {
            return None;
        }
        let image = (*decoder.0).image;
        if image.is_null() || (*image).exif.data.is_null() || (*image).exif.size == 0 {
            return None;
        }
        Some(std::slice::from_raw_parts((*image).exif.data, (*image).exif.size).to_vec())
    }
}

/// The same decode at whatever depth the caller can use, widened to one sample per `u16`.
///
/// 8 bits is a floor a measurement trips over: one 8-bit step of a PQ signal is four of the
/// ten the file carries, which is larger than the coding error at any quantizer worth
/// shipping, so a comparison run through it measures the readback instead.
pub fn decode_at(bytes: &[u8], depth: u32) -> Result<(Vec<u16>, usize, usize), String> {
    decode_at_with_rotation(bytes, depth, true)
}

pub(crate) fn decode_at_unturned(bytes: &[u8], depth: u32) -> Result<(Vec<u16>, usize, usize), String> {
    decode_at_with_rotation(bytes, depth, false)
}

fn decode_at_with_rotation(bytes: &[u8], depth: u32, rotate: bool) -> Result<(Vec<u16>, usize, usize), String> {
    let decoder = Decoder::new()?;
    let image = Image::empty()?;

    // SAFETY: both handles are live for the block, and `source.pixels` points into `data`, which
    // outlives the conversion.
    #[expect(unsafe_code)]
    unsafe {
        (*decoder.0).maxThreads = max_threads();
        let status =
            raw::avifDecoderReadMemory(decoder.0, image.0, bytes.as_ptr(), bytes.len());
        if status != AVIF_RESULT_OK {
            return Err(format!("libavif could not decode: {}", message(status)));
        }

        let (width, height) = ((*image.0).width as usize, (*image.0).height as usize);
        // libavif writes one byte per sample at 8 and two above it, in host order, so the
        // buffer is bytes either way and the samples are widened once it has filled it.
        let stride = match depth > 8 {
            true => 2,
            false => 1,
        };
        let mut data = vec![0u8; width * height * 3 * stride];
        let mut source = std::mem::zeroed::<raw::avifRGBImage>();
        raw::avifRGBImageSetDefaults(&mut source, image.0);
        source.format = AVIF_RGB_FORMAT_RGB;
        source.depth = depth;
        source.pixels = data.as_mut_ptr();
        source.rowBytes = (width * 3 * stride) as u32;
        // The direction libavif *will* thread, and the only one: the field on the encoder is
        // documented as ignored for RGB to YUV, which is why that way round is banded by hand.
        source.maxThreads = max_threads();

        let status = raw::avifImageYUVToRGB(image.0, &mut source);
        if status != AVIF_RESULT_OK {
            return Err(format!("libavif could not convert to RGB: {}", message(status)));
        }
        let samples = match stride {
            1 => data.iter().map(|v| u16::from(*v)).collect(),
            _ => bytemuck::pod_collect_to_vec(&data),
        };
        let angle = if rotate && (*image.0).transformFlags & AVIF_TRANSFORM_IROT != 0 {
            (*image.0).irot.angle
        } else {
            0
        };
        Ok(rotate_samples(samples, width, height, angle))
    }
}

fn rotate_samples(samples: Vec<u16>, width: usize, height: usize, angle: u8) -> (Vec<u16>, usize, usize) {
    if angle == 0 || angle > 3 {
        return (samples, width, height);
    }
    let (out_width, out_height) = if angle % 2 == 0 { (width, height) } else { (height, width) };
    let mut turned = vec![0; samples.len()];
    for y in 0..height {
        for x in 0..width {
            let (out_x, out_y) = match angle {
                1 => (y, width - 1 - x),
                2 => (width - 1 - x, height - 1 - y),
                3 => (height - 1 - y, x),
                _ => unreachable!(),
            };
            let from = (y * width + x) * 3;
            let to = (out_y * out_width + out_x) * 3;
            turned[to..to + 3].copy_from_slice(&samples[from..from + 3]);
        }
    }
    (turned, out_width, out_height)
}

/// The gain map beside an AVIF's picture, decoded, with the terms that apply it.
///
/// **libavif reads it, which took the pinned build.** The API arrived in 1.1 behind a compile flag
/// and settled in 1.2; Ubuntu's 1.0.4 and Debian's 1.1.1 have no gain map symbols at all, so
/// `scripts/get-codecs.ts` builds the version this needs.
///
/// The terms come back in ISO 21496-1's own shape, which is the shape `linearise` applies, so
/// nothing here re-derives them. None where the file carries no map, which is most AVIFs.
pub fn gain_map(bytes: &[u8]) -> Option<(Vec<u16>, usize, usize, u32, crate::linearise::Reconstruction)> {
    let decoder = Decoder::new().ok()?;
    let image = Image::empty().ok()?;

    // SAFETY: both handles are live for the block, and the gain map and its image belong to the
    // decoded image, which outlives every read of them here.
    #[expect(unsafe_code)]
    unsafe {
        (*decoder.0).maxThreads = max_threads();
        // The gain map as well as the picture, which is off by default.
        (*decoder.0).imageContentToDecode |= AVIF_IMAGE_CONTENT_GAIN_MAP;
        if raw::avifDecoderReadMemory(decoder.0, image.0, bytes.as_ptr(), bytes.len())
            != AVIF_RESULT_OK
        {
            return None;
        }
        let map = (*image.0).gainMap;
        if map.is_null() || (*map).image.is_null() {
            return None;
        }
        let coded = (*map).image;
        let (width, height) = ((*coded).width as usize, (*coded).height as usize);
        if width == 0 || height == 0 {
            return None;
        }

        // Sixteen bits asked for whatever the map carries, as the picture arm asks: libavif
        // rescales during the conversion, so the depth handed back is the one requested.
        let mut data = vec![0u8; width * height * 3 * 2];
        let mut source = std::mem::zeroed::<raw::avifRGBImage>();
        raw::avifRGBImageSetDefaults(&mut source, coded);
        source.format = AVIF_RGB_FORMAT_RGB;
        source.depth = 16;
        source.pixels = data.as_mut_ptr();
        source.rowBytes = (width * 3 * 2) as u32;
        source.maxThreads = max_threads();
        if raw::avifImageYUVToRGB(coded, &mut source) != AVIF_RESULT_OK {
            return None;
        }
        let samples = bytemuck::pod_collect_to_vec(&data);

        let signed = |it: raw::avifSignedFraction| match it.d {
            0 => 0.0,
            d => it.n as f32 / d as f32,
        };
        let unsigned = |it: raw::avifUnsignedFraction| match it.d {
            0 => 1.0,
            d => it.n as f32 / d as f32,
        };
        let triple = |from: [raw::avifSignedFraction; 3]| from.map(signed);
        Some((
            samples,
            width,
            height,
            16u32,
            crate::linearise::Reconstruction::Iso {
                min: triple((*map).gainMapMin),
                max: triple((*map).gainMapMax),
                gamma: (*map).gainMapGamma.map(unsigned),
                offset_base: triple((*map).baseOffset),
                offset_alternate: triple((*map).alternateOffset),
            },
        ))
    }
}

/// Encodes one frame as an AVIF still and hands back the file.
///
/// `pq` is interleaved 16-bit Rec.2020 RGB in the PQ transfer, as `frame.slang`'s `encode`
/// leaves it. What comes out of that is what libavif's own converter takes to YCbCr, so
/// the matrix and the limited-range quantisation stay libavif's rather than being
/// written a second time here.
///
/// `Cow` rather than a slice, and that is the memory knob rather than a signature
/// preference: an owned frame is handed straight to libavif and dropped as soon as the
/// YUV conversion has read it.
///
/// Only one frame of this is left live by the time libaom runs, and libaom's own working
/// set - ~700MB for a 24MP 4:4:4 all-intra frame, five times ours - is what actually sets
/// the peak. It tracks pixel count rather than depth: on a 61MP frame the whole job peaks at
/// 795MB fitted to 3840 and 2199MB at native, and twelve bits is 1-4% of that. Multiply by
/// `processing_concurrency` on a machine that starts OOM-killing; DESIGN 10.7 has the rest.
///
/// Bytes rather than a path because the browser has neither (DESIGN 21.3). The frame is
/// what costs; the encoded file is single-digit MB, so carrying it back through a `Vec`
/// is not the copy worth avoiding.
pub fn encode_still(
    pq: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &StillOptions,
) -> Result<Vec<u8>, String> {
    encode_still_rotated(pq, width, height, options, 0, None)
}

/// `exif` is a TIFF block (`crate::exif`).
pub(crate) fn encode_still_rotated(
    pq: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &StillOptions,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if pq.len() < width * height * 3 {
        return Err(format!("frame is {} samples, expected {}", pq.len(), width * height * 3));
    }
    encode_avif(pq, 16, AVIF_RANGE_LIMITED, width, height, AVIF_DEPTH, options.format,
        &options.cicp, options.quantizer, options.speed, rotate, exif)
}

/// `encode_still` to a file, for the renditions.
pub fn save_still(
    pq: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &StillOptions,
    out_path: &str,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<(), String> {
    let file = encode_still_rotated(pq, width, height, options, rotate, exif)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// [`save_still`] for a still that arrives as bands of whole rows (`encode_grid`), written as a grid
/// of them.
pub fn save_still_bands(
    bands: Vec<Vec<u16>>,
    width: usize,
    options: &StillOptions,
    out_path: &str,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<(), String> {
    let file = encode_grid(bands, 16, AVIF_RANGE_LIMITED, width, AVIF_DEPTH, options.format,
        &options.cicp, options.quantizer, options.speed, rotate, exif)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// [`encode_rendition_rotated`] for a rendition that arrives as bands of whole rows.
#[allow(clippy::too_many_arguments)]
pub fn save_rendition_bands(
    bands: Vec<Vec<u8>>,
    width: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    out_path: &str,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<(), String> {
    let format = match full_chroma {
        true => AVIF_PIXEL_FORMAT_YUV444,
        false => AVIF_PIXEL_FORMAT_YUV420,
    };
    let file = encode_grid(bands, 8, AVIF_RANGE_FULL, width, 8, format, &SRGB, quantizer, speed, rotate, exif)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// An 8-bit sRGB rendition, straight to disk.
///
/// Nothing to transfer and no gamut to convert: the 8-bit decode already produced sRGB,
/// so the pixels go to libavif exactly as they arrive and only the YCbCr matrix is left.
/// Tagged sRGB rather than left bare, since a file that says what it is costs nine bytes.
///
/// `full_chroma` is the `sdr_full_chroma` setting, 4:2:0 by default for the reasons
/// DESIGN 10.1 measures. No even-dimension problem to go with it: libavif pads odd
/// chroma itself.
pub fn encode_rgb8(
    rgb8: std::borrow::Cow<'_, [u8]>,
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
) -> Result<Vec<u8>, String> {
    encode_rgb8_rotated(rgb8, width, height, quantizer, speed, full_chroma, 0, None)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn encode_rgb8_rotated(
    rgb8: std::borrow::Cow<'_, [u8]>,
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if rgb8.len() < width * height * 3 {
        return Err(format!("frame is {} bytes, expected {}", rgb8.len(), width * height * 3));
    }
    let format = match full_chroma {
        true => AVIF_PIXEL_FORMAT_YUV444,
        false => AVIF_PIXEL_FORMAT_YUV420,
    };
    encode_avif(rgb8, 8, AVIF_RANGE_FULL, width, height, 8, format, &SRGB, quantizer, speed, rotate, exif)
}

/// sRGB primaries, sRGB transfer, BT.601 matrix.
const SRGB: Cicp = Cicp { primaries: 1, transfer: 13, matrix: 6 };

/// `encode_rgb8` to a file, for the renditions.
pub fn encode_rendition(
    rgb8: std::borrow::Cow<'_, [u8]>,
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    out_path: &str,
) -> Result<(), String> {
    encode_rendition_rotated(rgb8, width, height, quantizer, speed, full_chroma, out_path, 0, None)
}

#[allow(clippy::too_many_arguments)]
pub fn encode_rendition_rotated(
    rgb8: std::borrow::Cow<'_, [u8]>,
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    out_path: &str,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<(), String> {
    let file = encode_rgb8_rotated(rgb8, width, height, quantizer, speed, full_chroma, rotate, exif)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// A raw pointer a rayon closure may carry, which one is not by default.
///
/// Every band writes a disjoint rectangle of the same planes and reads a disjoint run of the same
/// source rows, so nothing is shared that is also written.
#[derive(Clone, Copy)]
struct Bands(*mut raw::avifImage, *const u8);

// SAFETY: see `Bands`. The image outlives the scope the bands run in, and the rows one band touches
// belong to no other.
#[expect(unsafe_code)]
unsafe impl Send for Bands {}
#[expect(unsafe_code)]
unsafe impl Sync for Bands {}

/// `avifImageRGBToYUV` over row bands, in parallel.
///
/// **The one call in the encode libavif will not thread.** `avif.h` says of `maxThreads` that "this
/// value is ignored for RGB to YUV conversion", and 16-bit RGB into a high-bit-depth YUV has no
/// libyuv fast path either, so it runs the generic float loop on one core: measured at 92ms of a
/// 164ms encode for a 3840x2560 still, against 9ms for the same dimensions at 8 bits.
///
/// A band is a view onto the parent's planes rather than a copy, so the conversion writes where it
/// always did. **Bands start on even rows**, which is what keeps the result identical rather than
/// merely close: 4:2:0 averages a 2x2 block, and a band boundary through the middle of one would
/// change the chroma either side of it.
#[expect(unsafe_code)]
unsafe fn to_yuv_banded(
    image: *mut raw::avifImage,
    pixels: *const u8,
    row_bytes: usize,
    rgb_depth: u32,
) -> Result<(), String> {
    use rayon::prelude::*;

    let height = unsafe { (*image).height } as usize;
    let allocated = unsafe { raw::avifImageAllocatePlanes(image, AVIF_PLANES_YUV) };
    if allocated != AVIF_RESULT_OK {
        let why = unsafe { message(allocated) };
        return Err(format!("libavif would not allocate planes: {why}"));
    }

    // Even, and at least two: an odd band start would split a chroma block, and a zero-row band is
    // a rectangle libavif refuses.
    let wanted = max_threads().max(1) as usize;
    let rows = (height.div_ceil(wanted).max(1)).next_multiple_of(2);
    let shared = Bands(image, pixels);

    let failures: Vec<String> = (0..height.div_ceil(rows))
        .into_par_iter()
        .filter_map(|band| {
            let top = band * rows;
            let tall = rows.min(height - top);
            unsafe { one_band(shared, top, tall, row_bytes, rgb_depth) }.err()
        })
        .collect();
    match failures.into_iter().next() {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

/// One band's rows, through a view onto the parent's planes.
#[expect(unsafe_code)]
unsafe fn one_band(
    shared: Bands,
    top: usize,
    tall: usize,
    row_bytes: usize,
    rgb_depth: u32,
) -> Result<(), String> {
    let Bands(image, pixels) = shared;
    unsafe {
        // **On the stack, and never destroyed.** `avifImageSetViewRect` copies the parent struct
        // wholesale and then clears the two owns-planes flags, so a view owns nothing - not the
        // planes, and not the ICC, Exif or XMP payloads whose pointers came across with the copy.
        // Handing one to `avifImageDestroy` frees what the parent still holds, which is a double
        // free at the end of the encode: `munmap_chunk(): invalid pointer`, reliably, on the second
        // photograph of a run.
        let mut view = std::mem::zeroed::<raw::avifImage>();
        let rect = raw::avifCropRect {
            x: 0,
            y: top as u32,
            width: (*image).width,
            height: tall as u32,
        };
        if raw::avifImageSetViewRect(&mut view, image, &rect) != AVIF_RESULT_OK {
            return Err("libavif refused a band's rectangle".to_string());
        }
        // Against the *view*, not the parent: it is what carries this band's height, and defaults
        // taken from the parent would describe the whole frame.
        let mut source = std::mem::zeroed::<raw::avifRGBImage>();
        raw::avifRGBImageSetDefaults(&mut source, &view);
        source.format = AVIF_RGB_FORMAT_RGB;
        source.depth = rgb_depth;
        source.pixels = pixels.add(top * row_bytes) as *mut u8;
        source.rowBytes = row_bytes as u32;
        source.chromaDownsampling = AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV;
        // The view only, so the file keeps its own. Told PQ, libsharpyuv solves in linear light:
        // 5x the time, and several times the p99.9 speckle it is here to remove (`aom_quality`).
        view.transferCharacteristics = SHARP_YUV_TRANSFER;
        match raw::avifImageRGBToYUV(&mut view, &source) {
            AVIF_RESULT_OK => Ok(()),
            status => Err(format!("libavif could not convert to YUV: {}", message(status))),
        }
    }
}

/// Hands interleaved RGB to libavif and returns the file it builds.
///
/// Never copies the frame: `avifRGBImage.pixels` points into `rgb`.
///
/// `Cow` so an owned frame can be **dropped as soon as the YUV conversion has read
/// it**, which is the peak that matters rather than a tidiness point. libaom allocates
/// its own working set - measured at ~560MB for a 24MP 4:4:4 all-intra frame, near
/// enough flat in the thread count and in the depth, so it is per-frame state rather than
/// anything tiling can be traded against. Holding the RGB across `avifEncoderWrite`
/// stacked a whole frame under that for no reader: 145MB at 24MP, 366MB at 61MP.
#[allow(clippy::too_many_arguments)]
fn encode_avif<T: Clone>(
    rgb: std::borrow::Cow<'_, [T]>,
    rgb_depth: u32,
    range: raw::avifRange,
    width: usize,
    height: usize,
    depth: u32,
    format: raw::avifPixelFormat,
    cicp: &Cicp,
    quantizer: i32,
    speed: i32,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let image = converted(rgb, rgb_depth, range, width, height, depth, format, cicp, rotate, exif)?;
    let encoder = configured(quantizer, speed)?;
    let mut output = Output::empty();
    // SAFETY: both handles are live for the call, and `output` is libavif's to fill.
    #[expect(unsafe_code)]
    let status = unsafe { raw::avifEncoderWrite(encoder.0, image.0, &mut output.0) };
    written(status, &output)
}

/// Whole-width bands, top to bottom, as one grid still. **Every band but the last the same height,
/// at least 64 rows**, and even at 4:2:0 - the grid's own rules (MIAF 7.3.11.4.2), which libavif
/// refuses the encode for breaking. At most 256 of them.
#[allow(clippy::too_many_arguments)]
fn encode_grid<T: Clone>(
    bands: Vec<Vec<T>>,
    rgb_depth: u32,
    range: raw::avifRange,
    width: usize,
    depth: u32,
    format: raw::avifPixelFormat,
    cicp: &Cicp,
    quantizer: i32,
    speed: i32,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let rows = u32::try_from(bands.len()).map_err(|_| "too many bands for a grid".to_string())?;
    debug_assert!(
        bands.split_last().is_some_and(|(last, rest)| {
            rest.iter().all(|band| band.len() == bands[0].len()) && last.len() <= bands[0].len()
        }),
        "every band but the last is one height, and the last no taller",
    );
    let mut cells = Vec::with_capacity(bands.len());
    for (index, band) in bands.into_iter().enumerate() {
        let height = band.len() / (width * 3);
        cells.push(converted(
            std::borrow::Cow::Owned(band),
            rgb_depth,
            range,
            width,
            height,
            depth,
            format,
            cicp,
            rotate,
            // libavif writes the grid's metadata from its first cell.
            exif.filter(|_| index == 0),
        )?);
    }
    let encoder = configured(quantizer, speed)?;
    let pointers: Vec<*const raw::avifImage> = cells.iter().map(|cell| cell.0.cast_const()).collect();
    let mut output = Output::empty();
    // SAFETY: every cell outlives both calls, and `output` is libavif's to fill.
    #[expect(unsafe_code)]
    unsafe {
        let status = raw::avifEncoderAddImageGrid(
            encoder.0,
            1,
            rows,
            pointers.as_ptr(),
            // Each cell's encoder is freed as soon as the cell is written, not held to the end.
            AVIF_ADD_IMAGE_FLAG_SINGLE,
        );
        if status != AVIF_RESULT_OK {
            return Err(format!("libavif could not encode the grid: {}", message(status)));
        }
        written(raw::avifEncoderFinish(encoder.0, &mut output.0), &output)
    }
}

/// A frame in libavif's YUV, tagged for the file, with the RGB it came from dropped.
#[allow(clippy::too_many_arguments)]
fn converted<T: Clone>(
    rgb: std::borrow::Cow<'_, [T]>,
    rgb_depth: u32,
    range: raw::avifRange,
    width: usize,
    height: usize,
    depth: u32,
    format: raw::avifPixelFormat,
    cicp: &Cicp,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<Image, String> {
    if rotate % 90 != 0 {
        return Err(format!("rotation must be a quarter turn: {rotate}"));
    }
    let image = Image::sized(width as u32, height as u32, depth, format)?;

    // SAFETY: every pointer below is either the handle above or points into `rgb` or `exif`, which
    // outlive the calls that read them.
    #[expect(unsafe_code)]
    unsafe {
        // Ahead of the turn: libavif sets `irot` from an Orientation tag it finds in the block.
        if let Some(exif) = exif {
            let status = raw::avifImageSetMetadataExif(image.0, exif.as_ptr(), exif.len());
            if status != AVIF_RESULT_OK {
                return Err(format!("libavif refused the EXIF: {}", message(status)));
            }
        }
        (*image.0).yuvRange = range;
        (*image.0).colorPrimaries = cicp.primaries;
        (*image.0).transferCharacteristics = cicp.transfer;
        (*image.0).matrixCoefficients = cicp.matrix;
        if rotate % 360 != 0 {
            (*image.0).transformFlags |= AVIF_TRANSFORM_IROT;
            (*image.0).irot.angle = ((360 - rotate % 360) / 90) as u8;
        }

        let row_bytes = width * 3 * (rgb_depth as usize / 8);
        to_yuv_banded(image.0, rgb.as_ptr() as *const u8, row_bytes, rgb_depth)?;
    }
    // The planes hold everything now, and the encoder works off `image`. So the frame goes back
    // before the encoder asks for its own, rather than sitting under it.
    drop(rgb);
    Ok(image)
}

/// The encoder every still is written with.
fn configured(quantizer: i32, speed: i32) -> Result<Encoder, String> {
    let encoder = Encoder::new()?;
    // SAFETY: the handle is live, and these are plain fields libavif reads at the encode.
    #[expect(unsafe_code)]
    unsafe {
        (*encoder.0).maxThreads = max_threads();
        (*encoder.0).speed = speed;
        // Both ends, not `--min 0 --max N`. libavif derives the encode's quality from the
        // **midpoint** of the pair, so a floor of 0 quietly halved every quantizer this app
        // asked for (DESIGN §10.7); and libaom takes the pair as the bounds of every block's
        // own quantizer, so a range is a different encode from its midpoint besides.
        (*encoder.0).minQuantizer = quantizer;
        (*encoder.0).maxQuantizer = quantizer;
        // libaom parallelises across tiles, so without them the threads idle.
        (*encoder.0).autoTiling = 1;
        // Named rather than left to libavif, whose default follows the aom it finds: a quantizer
        // under IQ spends up to three quarters more bytes than under SSIM, and the quality anchors
        // are IQ's. Not at 0, which libavif encodes lossless and libaom refuses IQ for.
        if quantizer > 0 {
            let status = raw::avifEncoderSetCodecSpecificOption(encoder.0, c"tune".as_ptr(), c"iq".as_ptr());
            if status != AVIF_RESULT_OK {
                return Err(format!("libavif would not set the tune: {}", message(status)));
            }
        }
    }
    Ok(encoder)
}

fn written(status: raw::avifResult, output: &Output) -> Result<Vec<u8>, String> {
    if status != AVIF_RESULT_OK {
        // SAFETY: `message` reads a static string libavif owns.
        #[expect(unsafe_code)]
        let why = unsafe { message(status) };
        return Err(format!("libavif could not encode: {why}"));
    }
    output.bytes().ok_or_else(|| "libavif returned no bytes".to_string())
}

/// libavif's own words for a failure, rather than a number.
#[expect(unsafe_code)]
pub(crate) unsafe fn message(status: raw::avifResult) -> String {
    let text = unsafe { raw::avifResultToString(status) };
    if text.is_null() {
        return format!("result {}", status.0);
    }
    unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file's YUV planes, laid out one after another as `VideoFrame.copyTo` lays out a page's.
    fn yuv_planes(bytes: &[u8]) -> (Vec<u8>, crate::planes::Layout) {
        let decoder = Decoder::new().expect("a decoder");
        let image = Image::empty().expect("an image");
        let mut samples = Vec::new();
        // SAFETY: both handles are live for the block, and each plane is `rows * yuvRowBytes` long.
        #[expect(unsafe_code)]
        unsafe {
            let status = raw::avifDecoderReadMemory(decoder.0, image.0, bytes.as_ptr(), bytes.len());
            assert_eq!(status, AVIF_RESULT_OK, "libavif decodes the still");
            let image = &*image.0;
            let subsampled = image.yuvFormat == AVIF_PIXEL_FORMAT_YUV420;
            let planes = [0, 1, 2].map(|at| {
                let rows = match at > 0 && subsampled {
                    true => (image.height as usize).div_ceil(2),
                    false => image.height as usize,
                };
                let stride = image.yuvRowBytes[at] as usize;
                let offset = samples.len();
                samples.extend_from_slice(std::slice::from_raw_parts(image.yuvPlanes[at], rows * stride));
                crate::planes::Plane { offset, stride }
            });
            let layout = crate::planes::Layout {
                width: image.width as usize,
                height: image.height as usize,
                bits: image.depth,
                subsampled,
                planes,
            };
            (samples, layout)
        }
    }

    /// `planes.slang` against libavif's own conversion, which the page's planes stand in for: the
    /// mockup opens from one and the server's prepare from the other.
    #[test]
    fn planes_convert_to_the_codes_libavif_decodes() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the plane conversion was not run.");
            return;
        };
        let frame = |width: usize, height: usize, code: &dyn Fn(usize, usize) -> [u16; 3]| -> Vec<u16> {
            (0..width * height).flat_map(|at| code(at % width, at / width)).collect()
        };
        let colours = |x: usize, y: usize| [20_000 + x as u16 * 300, 22_000 + y as u16 * 300, 30_000 - x as u16 * 150];
        // One ramp under all three channels, so the chroma is flat: libavif upsamples 4:2:0 chroma
        // bilinear where the viewer reads it nearest, and on a flat plane the two cannot differ.
        let shades = |x: usize, y: usize| {
            let ramp = (x * 300 + y * 200) as u16;
            [24_000 + ramp, 20_000 + ramp, 16_000 + ramp]
        };
        // Odd at 4:2:0, where the last chroma sample covers a single luma column and row.
        let cases = [
            (AVIF_PIXEL_FORMAT_YUV444, 64usize, 48usize, frame(64, 48, &colours)),
            (AVIF_PIXEL_FORMAT_YUV420, 63, 47, frame(63, 47, &shades)),
        ];
        for (format, width, height, picture) in cases {
            let options =
                StillOptions { cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 }, format, quantizer: 0, speed: 10 };
            let file = encode_still(picture.into(), width, height, &options).expect("the still encodes");
            let (libavif, ..) = decode_at_unturned(&file, 16).expect("libavif converts it");
            let (samples, layout) = yuv_planes(&file);
            let codes = crate::planes::codes(gpu, &samples, &layout).expect("the planes convert");
            let ours = pollster::block_on(codes.into_host()).expect("the codes read back");
            let worst = ours
                .iter()
                .zip(&libavif)
                .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
                .max()
                .unwrap_or(0);
            // A twelve-bit step is sixteen codes.
            assert!(worst <= 16, "{format:?}: a code {worst} away from libavif's");
        }
    }

    #[test]
    fn rotation_is_container_metadata_and_decode_honours_it() {
        let (width, height) = (8usize, 6usize);
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let pixel = (y * width + x) * 3;
                frame[pixel] = (x * 23) as u8;
                frame[pixel + 1] = (y * 31) as u8;
                frame[pixel + 2] = (x * 17 + y * 11) as u8;
            }
        }
        let encode = |rotate| {
            encode_rgb8_rotated((&frame[..]).into(), width, height, 0, 10, true, rotate, None)
                .expect("AVIF encode")
        };
        let unturned = encode(0);
        let (samples, _, _) = decode_at(&unturned, 8).expect("AVIF decode");
        let stored = crate::heif::read(&unturned).expect("AVIF container");
        for (rotate, angle, turn) in [
            (90, 3, rawler::decoders::Orientation::Rotate90),
            (180, 2, rawler::decoders::Orientation::Rotate180),
            (270, 1, rawler::decoders::Orientation::Rotate270),
        ] {
            let encoded = encode(rotate);
            let picture = crate::heif::read(&encoded).expect("rotated AVIF container").primary;
            assert_eq!(picture.tiles, stored.primary.tiles, "coded pixels at {rotate}");
            assert_eq!(picture.turn, turn, "container orientation at {rotate}");
            let rendered = crate::decode_rendered::read(&encoded).expect("rendered AVIF decode");
            let raw = decode_at_unturned(&encoded, 16).expect("unturned AVIF decode");
            assert_eq!((rendered.codes, rendered.width, rendered.height), raw,
                "rendered-source pixels remain unturned at {rotate}");
            assert_eq!(rendered.turn, turn);
            assert_eq!(decode_at_unturned(&encoded, 8).expect("raw AVIF decode"),
                (samples.clone(), width, height));
            assert_eq!(decode_at(&encoded, 8).expect("rotated AVIF decode"),
                rotate_samples(samples.clone(), width, height, angle));
        }
    }

    #[test]
    fn an_sdr_roll_keeps_hdr_source_orientation_and_builds_a_shareable_gain_map() {
        if crate::gpu::device().is_none() {
            return;
        }
        let (width, height) = (64usize, 48usize);
        let mut frame = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let at = (y * width + x) * 3;
                frame[at] = 20_000 + x as u16 * 300;
                frame[at + 1] = 22_000 + y as u16 * 300;
                frame[at + 2] = 24_000;
            }
        }
        let source = encode_still_rotated(
            frame.into(),
            width,
            height,
            &StillOptions {
                cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: AVIF_PIXEL_FORMAT_YUV444,
                quantizer: 10,
                speed: 10,
            },
            90,
            None,
        )
        .expect("HDR still");
        let dir = std::env::temp_dir().join(format!("bb-orientation-roll-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        let source_path = dir.join("source.avif");
        let base_path = dir.join("base.avif");
        std::fs::write(&source_path, &source).expect("HDR source");
        let job: crate::job::Job = serde_json::from_value(serde_json::json!({
            "rawFilePath": source_path,
            "cameraMatch": "none",
            "preserveSourceOrientation": true,
            "sharpen": 0,
            "defringe": 0,
            "grade": { "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 },
            "targets": [{
                "rendition": "max",
                "output": "srgb",
                "outputPath": base_path,
                "size": 0,
                "source": "render",
                "sdrQuantizer": 10,
                "hdrQuantizer": 10,
                "preset": 10,
                "stillFullChroma": true,
                "sdrFullChroma": true
            }]
        }))
        .expect("SDR roll job");
        crate::job::run(&job).expect("SDR roll");
        let base = std::fs::read(&base_path).expect("SDR still");
        let hdr = crate::heif::read(&source).expect("HDR container");
        let sdr = crate::heif::read(&base).expect("SDR container");
        assert_eq!((sdr.primary.width, sdr.primary.height, sdr.primary.turn),
            (hdr.primary.width, hdr.primary.height, hdr.primary.turn));
        let shared = crate::jpeg_gain_write::combine(&base, &source, 90).expect("gain-map JPEG");
        let probe = crate::decode_rendered::probe(&shared).expect("shared JPEG header");
        assert_eq!(probe.orientation, 6);
        assert!(crate::jpeg_gain::read(&shared, probe.exif.as_deref()).is_some());
        std::fs::remove_file(source_path).expect("remove HDR scratch");
        std::fs::remove_file(base_path).expect("remove SDR scratch");
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused_rather_than_read_past() {
        let options = StillOptions {
            cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
            format: AVIF_PIXEL_FORMAT_YUV444,
            quantizer: 20,
            speed: 8,
        };
        let short = vec![0u16; 8 * 8 * 3 - 1];
        assert!(encode_still(short.into(), 8, 8, &options).is_err());
    }

    /// The rendition path both ways: what `encode_rendition` writes is what a download
    /// reads back, which is the only reason `decode` exists.
    #[test]
    fn a_rendition_decodes_back_to_the_pixels_it_was_written_from() {
        let dir = std::env::temp_dir().join("bb-avif-round-trip");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("rendition.avif");
        let (width, height) = (48usize, 32usize);
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                frame[i] = (x * 255 / width) as u8;
                frame[i + 1] = (y * 255 / height) as u8;
                frame[i + 2] = 96;
            }
        }

        // Lossless-ish and full chroma, so what comes back is the encode's own error and
        // not 4:2:0's. `decode` is what is under test, not libaom's rate control.
        encode_rendition(
            std::borrow::Cow::Borrowed(&frame),
            width,
            height,
            0,
            10,
            true,
            path.to_str().expect("a path"),
        )
        .expect("the encode");

        let decoded = decode(&std::fs::read(&path).expect("the file")).expect("the decode");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((decoded.width, decoded.height), (width, height));
        let worst = frame
            .iter()
            .zip(decoded.data.iter())
            .map(|(wrote, read)| wrote.abs_diff(*read))
            .max()
            .expect("pixels");
        assert!(worst <= 4, "the round trip moved a channel by {worst} of 255");
    }

    /// A still written as a grid of bands reads back as one picture, the bands in order: what lets
    /// a picture too large for one frame be written at all. At 4:2:0, whose grid has the most rules.
    #[test]
    fn a_still_written_in_bands_reads_back_as_one_picture() {
        let dir = std::env::temp_dir().join("bb-avif-bands");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("bands.avif");
        let (width, height) = (96usize, 200usize);
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| {
                let (pixel, channel) = (i / 3, i % 3);
                let (x, y) = (pixel % width, pixel / width);
                (20_000 + x * 100 + y * 100 + channel * 3000) as u16
            })
            .collect();
        let bands: Vec<Vec<u16>> =
            frame.chunks(width * 64 * 3).map(<[u16]>::to_vec).collect();
        assert_eq!(bands.len(), 4, "three whole bands and a short one");
        let options = StillOptions {
            cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
            format: AVIF_PIXEL_FORMAT_YUV420,
            quantizer: 0,
            speed: 10,
        };
        save_still_bands(bands, width, &options, path.to_str().expect("a path"), 0, None)
            .expect("the encode");
        let (read, read_width, read_height) =
            decode_at(&std::fs::read(&path).expect("the file"), 16).expect("the decode");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((read_width, read_height), (width, height));
        let worst = frame.iter().zip(&read).map(|(a, b)| a.abs_diff(*b)).max().expect("pixels");
        assert!(worst <= 1024, "the round trip moved a sample by {worst} of 65535");
    }

    /// A block with an Orientation tag in it, which libavif turns into `irot` if it is allowed to.
    fn turned_exif() -> Vec<u8> {
        let mut out = Vec::new();
        let tiff =
            rawler::formats::tiff::writer::TiffWriter::new(std::io::Cursor::new(&mut out)).expect("a writer");
        let mut root = rawler::formats::tiff::writer::DirectoryWriter::new();
        root.add_tag(rawler::tags::ExifTag::Model, "ILCE-7M4");
        root.add_tag(rawler::tags::ExifTag::Orientation, 6u16);
        tiff.build(root).expect("the block");
        out
    }

    #[test]
    fn a_still_carries_its_exif_and_keeps_its_own_turn() {
        let exif = turned_exif();
        let frame = vec![128u8; 16 * 8 * 3];
        let bytes = encode_rgb8_rotated(frame.into(), 16, 8, 20, 10, true, 180, Some(&exif))
            .expect("the encode");

        assert_eq!(super::exif(&bytes).as_deref(), Some(&exif[..]));
        let turn = crate::heif::read(&bytes).expect("the container").primary.turn;
        assert_eq!(turn, rawler::decoders::Orientation::Rotate180);
    }

    #[test]
    fn a_still_written_in_bands_carries_its_exif() {
        let exif = turned_exif();
        let bands = vec![vec![128u8; 64 * 64 * 3]; 2];
        let dir = std::env::temp_dir().join(format!("bb-avif-bands-exif-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("bands.avif");
        save_rendition_bands(bands, 64, 20, 10, true, path.to_str().expect("a path"), 0, Some(&exif))
            .expect("the encode");
        let bytes = std::fs::read(&path).expect("the file");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(super::exif(&bytes).as_deref(), Some(&exif[..]));
    }

    #[test]
    fn a_still_written_without_exif_reads_back_with_none() {
        let bytes = encode_rgb8(vec![128u8; 16 * 8 * 3].into(), 16, 8, 20, 10, true).expect("the encode");
        assert_eq!(super::exif(&bytes), None);
    }

    /// Every grid tile is 4:2:0, which is a different conversion inside libavif and the one this
    /// file bands across threads - so the shape of the frame decides how it is cut up, and a shape
    /// that produces a band libsharpyuv will not take is a rendition that cannot be written at all.
    #[test]
    fn a_subsampled_rendition_encodes_at_every_shape_a_tile_takes() {
        // A tile of a 3:2 frame, of a panorama, and of the two-row and one-row edges the banding
        // itself can produce.
        for (width, height) in [(48usize, 32usize), (800, 533), (800, 368), (800, 345), (64, 3), (64, 2)] {
            let frame = vec![128u8; width * height * 3];
            let encoded = encode_rgb8(std::borrow::Cow::Borrowed(&frame), width, height, 30, 10, false);
            assert!(encoded.is_ok(), "{width}x{height}: {:?}", encoded.err());
        }
    }

    /// A saturated red with white sparkle over it, the hood 4:2:0 speckled (§10.7): green swings
    /// per pixel from the floor, and the block's chroma has to hand red none of that swing.
    #[test]
    fn a_subsampled_still_keeps_a_saturated_colour_clean() {
        let (width, height) = (128usize, 128usize);
        let mut frame = vec![0u16; width * height * 3];
        for (i, pixel) in frame.chunks_exact_mut(3).enumerate() {
            let sparkle = (i.wrapping_mul(2_654_435_761) >> 7) % 5 == 0;
            pixel.copy_from_slice(&match sparkle {
                true => [44_000, 38_000, 36_000],
                false => [40_000, 3_000, 9_000],
            });
        }

        let bytes = encode_still(
            std::borrow::Cow::Borrowed(&frame),
            width,
            height,
            &StillOptions {
                cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: AVIF_PIXEL_FORMAT_YUV420,
                quantizer: 0,
                speed: 10,
            },
        )
        .expect("the encode");
        let (back, _, _) = decode_at(&bytes, 16).expect("the decode");

        let mut worst: Vec<u16> = frame
            .chunks_exact(3)
            .zip(back.chunks_exact(3))
            .map(|(wrote, read)| (0..3).map(|c| wrote[c].abs_diff(read[c])).max().expect("3 channels"))
            .collect();
        let at = worst.len() * 999 / 1000;
        let (_, speckle, _) = worst.select_nth_unstable(at);
        let steps = f64::from(*speckle) / 65535.0 * 1023.0;
        // Solved under sRGB's curve this reads 202; under PQ's, 388.
        assert!(steps < 300.0, "p99.9 worst channel {steps:.1} PQ steps off");
    }

    #[test]
    fn bytes_that_are_not_an_avif_are_an_error_rather_than_a_panic() {
        assert!(decode(b"").is_err());
        assert!(decode(&[0u8; 64]).is_err());
    }

    /// The quantizer a caller names is the one the encoder works at: each step down spends more
    /// bytes. A quantizer lost on the way to libaom - clamped, ignored, or read as the midpoint
    /// of a range that starts at 0, which is how this app once encoded everything at half its
    /// setting (§10.7) - comes out as two sizes out of order or the same.
    #[test]
    fn a_lower_quantizer_spends_more_bytes() {
        // Something with detail to spend bits on: a flat frame encodes to the same few
        // bytes at any quantizer and would pass this without meaning anything.
        let (width, height) = (64usize, 64usize);
        let mut frame = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                frame[i] = ((x * 977 + y * 631) % 65536) as u16;
                frame[i + 1] = ((x * 331 + y * 1181) % 65536) as u16;
                frame[i + 2] = ((x * 1499 + y * 173) % 65536) as u16;
            }
        }

        let bytes = |quantizer: i32| {
            encode_avif(
                std::borrow::Cow::Borrowed(&frame),
                16,
                AVIF_RANGE_LIMITED,
                width,
                height,
                AVIF_DEPTH,
                AVIF_PIXEL_FORMAT_YUV444,
                &Cicp { primaries: 9, transfer: 16, matrix: 9 },
                quantizer,
                10,
                0,
                None,
            )
            .expect("the encode")
            .len()
        };

        let sizes = [26, 13, 6].map(|quantizer| (quantizer, bytes(quantizer)));
        assert!(
            sizes.windows(2).all(|pair| pair[0].1 < pair[1].1),
            "bytes by quantizer should rise as it falls: {sizes:?}"
        );
    }
}
