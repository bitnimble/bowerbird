// libvips, which is the library sharp wraps.
//
// Calling it from here rather than through sharp removes the split where
// TypeScript owned pixel work: the fit blurs inside its candidate loop, and
// crossing back into JS for that meant a boundary per candidate. It also happens
// to be faster - the system 8.15.1 build encodes a 3840px AVIF in ~287ms against
// sharp's bundled build at ~575ms, same file size - because the encode is the
// largest single item in a rendition.
//
// One process-wide init, guarded: libvips is not safe to initialise twice, and a
// worker may reach this from several call sites.

use libvips::{ops, VipsApp, VipsImage};
use std::sync::OnceLock;

static APP: OnceLock<VipsApp> = OnceLock::new();

/// Thread count for libvips operations, overridable with BOWERBIRD_VIPS_THREADS.
///
/// Pinning this to 1 - on the reasoning that the worker pool already saturates the
/// machine - was a mistake worth recording: sharp runs the same operations
/// multi-threaded, so it removed parallelism the TypeScript path had and made the
/// fit slower than what it replaced. The default follows the machine, and a
/// batch-heavy deployment can turn it down.
fn thread_count() -> i32 {
    std::env::var("BOWERBIRD_VIPS_THREADS")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4))
}

/// Which AV1 encoder libheif should use for AVIF, overridable with
/// BOWERBIRD_AVIF_ENCODER (aom, rav1e, svt).
///
/// Named rather than `auto` on purpose; see `save_avif`. Anything unrecognised
/// falls back to aom rather than to libheif's plugin ordering, because the failure
/// this guards against is a silent one.
fn avif_encoder() -> u32 {
    use libvips::bindings as b;
    match std::env::var("BOWERBIRD_AVIF_ENCODER").unwrap_or_default().as_str() {
        "rav1e" => b::VipsForeignHeifEncoder_VIPS_FOREIGN_HEIF_ENCODER_RAV1E,
        "svt" => b::VipsForeignHeifEncoder_VIPS_FOREIGN_HEIF_ENCODER_SVT,
        // libheif's own pick, by plugin priority. What this did before the encoder
        // was named, and kept only so that behaviour stays reachable for testing.
        "auto" => b::VipsForeignHeifEncoder_VIPS_FOREIGN_HEIF_ENCODER_AUTO,
        _ => b::VipsForeignHeifEncoder_VIPS_FOREIGN_HEIF_ENCODER_AOM,
    }
}

pub fn init() {
    APP.get_or_init(|| {
        let app = VipsApp::new("bowerbird", false).expect("libvips failed to initialise");
        app.concurrency_set(thread_count());
        app
    });
}

pub type Result<T> = std::result::Result<T, String>;

fn wrap<T>(result: std::result::Result<T, libvips::error::Error>) -> Result<T> {
    // libvips reports the useful part in a process-global buffer rather than in
    // the error value, so "HeifsaveError, check the error buffer" is all a caller
    // sees without this.
    result.map_err(|e| match APP.get().and_then(|app| app.error_buffer().ok()).filter(|b| !b.is_empty()) {
        Some(detail) => format!("{e}: {}", detail.trim()),
        None => e.to_string(),
    })
}

/// Interleaved 8-bit RGB, owned. What an operation produces.
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Rgb {
    pub fn as_ref(&self) -> RgbRef<'_> {
        RgbRef { width: self.width, height: self.height, data: &self.data }
    }
}

/// Interleaved 8-bit RGB, borrowed. What an operation reads.
///
/// Every entry point here takes one of these rather than `&Rgb`, so pixels held
/// by something else - a decode handle TypeScript is keeping alive, most of the
/// time - can be operated on where they lie. The owned form was the whole surface
/// once, and it meant a ~45MB copy at each end of every call for images no caller
/// ever wanted materialised.
#[derive(Clone, Copy)]
pub struct RgbRef<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}

/// Reads an image out as interleaved 8-bit RGB.
///
/// Never clones a `VipsImage`. The crate derives `Clone` on it - a shallow copy of
/// a refcounted pointer - while also implementing `Drop` to unref, so a clone and
/// its original both unref the same object and libvips reports
/// "g_object_unref: assertion 'G_IS_OBJECT (object)' failed" on the second. Doing
/// that once per operation produced hundreds of them per fit.
fn to_rgb(image: &VipsImage) -> Result<Rgb> {
    let read = |image: &VipsImage| Rgb {
        width: image.get_width() as usize,
        height: image.get_height() as usize,
        data: image.image_write_to_memory(),
    };

    // Renditions and fits are all 3-band; an embedded JPEG occasionally carries an
    // alpha or is greyscale, so normalise rather than trusting the source.
    match image.get_bands() {
        3 => Ok(read(image)),
        4 => Ok(read(&wrap(ops::flatten(image))?)),
        _ => {
            let srgb = wrap(ops::colourspace(image, ops::Interpretation::Srgb))?;
            if srgb.get_bands() == 4 {
                Ok(read(&wrap(ops::flatten(&srgb))?))
            } else {
                Ok(read(&srgb))
            }
        }
    }
}

/// A chain of libvips operations that has not been evaluated yet.
///
/// libvips is lazy: chaining resize onto blur builds a graph, and only asking for
/// the pixels runs it, streaming in tiles with no intermediate image ever built.
/// Exposing one function per operation threw that away - each call materialised
/// its result into a Vec and the next copied it back in, so a four-step setup paid
/// eight full-image copies for work libvips would have fused into one pass. That
/// is why the first version of this module lost to sharp, which chains.
///
/// Consumes `self` at every step, which also keeps the crate's derived `Clone` on
/// `VipsImage` - a shallow copy of a refcounted pointer, with a `Drop` that unrefs
/// - permanently out of reach.
pub struct Pipeline<'a> {
    image: VipsImage,
    /// vips_image_new_from_memory references the caller's buffer rather than
    /// copying it, so the graph is only valid while those pixels live. Borrowed
    /// rather than owned: the render is ~45MB, and cloning it just to hand over
    /// ownership was exactly the sort of unnecessary copy this rewrite is removing.
    _borrow: std::marker::PhantomData<&'a [u8]>,
}

impl<'a> Pipeline<'a> {
    pub fn from_rgb(image: RgbRef<'a>) -> Result<Pipeline<'a>> {
        let expected = image.width * image.height * 3;
        if image.data.len() < expected {
            return Err(format!("buffer is {} bytes, expected {expected}", image.data.len()));
        }
        let handle = wrap(VipsImage::new_from_memory(
            image.data,
            image.width as i32,
            image.height as i32,
            3,
            ops::BandFormat::Uchar,
        ))?;
        Ok(Pipeline { image: handle, _borrow: std::marker::PhantomData })
    }

    /// Decodes an encoded image and applies its EXIF orientation, which a render
    /// does not need because the decoder bakes it in.
    pub fn decode_upright(bytes: &'a [u8]) -> Result<Pipeline<'a>> {
        let image = wrap(VipsImage::new_from_buffer(bytes, ""))?;
        Ok(Pipeline { image: wrap(ops::autorot(&image))?, _borrow: std::marker::PhantomData })
    }

    /// Longest-edge fit, preserving aspect. 0 leaves the image alone.
    ///
    /// Only ever shrinks. Nothing here wants an enlargement - a rendition is
    /// bounded by the frame it came from, and a fit grid exists to make the
    /// comparison cheaper - and a body that embeds a preview smaller than the fit
    /// grid would otherwise have it upscaled into invented detail.
    pub fn resize_to_fit(self, long_edge: usize) -> Result<Pipeline<'a>> {
        let longest = self.image.get_width().max(self.image.get_height()) as usize;
        if long_edge == 0 || longest <= long_edge {
            return Ok(self);
        }
        let scale = long_edge as f64 / longest as f64;
        self.resize(scale, scale)
    }

    /// Exact dimensions, ignoring aspect. Used where two planes must share a grid.
    pub fn resize_exact(self, width: usize, height: usize) -> Result<Pipeline<'a>> {
        let hscale = width as f64 / self.image.get_width() as f64;
        let vscale = height as f64 / self.image.get_height() as f64;
        self.resize(hscale, vscale)
    }

    /// `vscale` is always passed: its default is 0, which collapses the image to a
    /// single row rather than following the horizontal scale.
    fn resize(self, hscale: f64, vscale: f64) -> Result<Pipeline<'a>> {
        let image = wrap(ops::resize_with_opts(
            &self.image,
            hscale,
            &ops::ResizeOptions { kernel: ops::Kernel::Lanczos3, vscale, ..Default::default() },
        ))?;
        Ok(Pipeline { image, _borrow: self._borrow })
    }

    pub fn blur(self, sigma: f64) -> Result<Pipeline<'a>> {
        if sigma <= 0.0 {
            return Ok(self);
        }
        let image = wrap(ops::gaussblur(&self.image, sigma))?;
        Ok(Pipeline { image, _borrow: self._borrow })
    }

    /// Runs the graph. The only point at which pixels are produced.
    pub fn finish(self) -> Result<Rgb> {
        to_rgb(&self.image)
    }

    /// AVIF, 4:4:4. Chroma is kept at full resolution because these are
    /// photographs: 4:2:0 smears the saturated edges a photo is judged on
    /// (DESIGN 10.1).
    ///
    /// The encoder is named rather than left to libheif's plugin priority, and
    /// that is load-bearing: 4:4:4 is an AV1 profile, not a setting, and SVT-AV1
    /// implements Profile 0 only while *converting silently* (DESIGN 10.7). If a
    /// deployment happened to have the svtenc plugin at a higher priority, `auto`
    /// would quietly ship 4:2:0. BOWERBIRD_AVIF_ENCODER overrides for measurement.
    pub fn save_avif(self, quality: i32, effort: i32, out_path: &str) -> Result<()> {
        use libvips::bindings;
        use std::ffi::{c_char, CString};

        let path = CString::new(out_path).map_err(|_| "output path contains a NUL".to_string())?;
        let image = self.finish()?;
        let encoder = avif_encoder();

        // SAFETY: as `writer`. The property names are NUL-terminated literals and
        // the list is NULL-terminated, as the varargs contract requires.
        writer("heifsave", &image, |source| unsafe {
            bindings::vips_heifsave(
                source,
                path.as_ptr(),
                c"Q".as_ptr() as *const c_char,
                quality,
                c"compression".as_ptr() as *const c_char,
                bindings::VipsForeignHeifCompression_VIPS_FOREIGN_HEIF_COMPRESSION_AV1,
                c"effort".as_ptr() as *const c_char,
                effort,
                c"subsample_mode".as_ptr() as *const c_char,
                bindings::VipsForeignSubsample_VIPS_FOREIGN_SUBSAMPLE_OFF,
                c"encoder".as_ptr() as *const c_char,
                encoder,
                std::ptr::null::<c_char>(),
            )
        })?;
        Ok(())
    }

    pub fn encode_jpeg(self, quality: i32) -> Result<Vec<u8>> {
        use libvips::bindings;
        use std::ffi::{c_char, c_void};

        let image = self.finish()?;
        let mut buffer: *mut c_void = std::ptr::null_mut();
        let mut len: u64 = 0;
        writer("jpegsave_buffer", &image, |source| unsafe {
            bindings::vips_jpegsave_buffer(
                source,
                &mut buffer,
                &mut len,
                c"Q".as_ptr() as *const c_char,
                quality,
                std::ptr::null::<c_char>(),
            )
        })?;
        if buffer.is_null() {
            return Err("jpegsave_buffer produced nothing".into());
        }
        // SAFETY: libvips allocated `len` bytes at `buffer` and hands over
        // ownership; g_free is the matching release.
        unsafe {
            let bytes = std::slice::from_raw_parts(buffer as *const u8, len as usize).to_vec();
            bindings::g_free(buffer);
            Ok(bytes)
        }
    }
}

/// Runs one of libvips' savers over `image`.
///
/// Through the raw bindings rather than the crate's `*_with_opts` helpers, which
/// send every property their options struct knows about - `tune` for heifsave,
/// a `keep` flag for jpegsave - and libvips 8.15, the version Debian and Ubuntu
/// ship, has neither. heifsave failed outright with "no property named `tune`";
/// jpegsave only logged a GLib critical, which is worse, because it looked like
/// it worked. Naming the properties here means sending exactly the ones each
/// saver needs, and it keeps the version-coupled part of the dependency here.
///
/// Materialises first, which the rest of a chain does not have to: the crate
/// keeps the underlying `VipsImage` pointer private, so the only way to reach a
/// saver is to build a fresh one from pixels. One copy at the end of a chain,
/// not one per step.
fn writer(name: &str, image: &Rgb, save: impl FnOnce(*mut libvips::bindings::VipsImage) -> i32) -> Result<()> {
    use libvips::bindings;
    use std::ffi::c_void;

    let expected = image.width * image.height * 3;
    if image.data.len() < expected {
        return Err(format!("buffer is {} bytes, expected {expected}", image.data.len()));
    }

    // SAFETY: `image` outlives the call, so the pixels the VipsImage references
    // stay valid until it is unreffed below.
    let status = unsafe {
        let source = bindings::vips_image_new_from_memory(
            image.data.as_ptr() as *const c_void,
            expected as u64,
            image.width as i32,
            image.height as i32,
            3,
            bindings::VipsBandFormat_VIPS_FORMAT_UCHAR,
        );
        if source.is_null() {
            return Err("vips_image_new_from_memory returned null".into());
        }
        let status = save(source);
        bindings::g_object_unref(source as *mut c_void);
        status
    };
    if status != 0 {
        return Err(format!(
            "{name} failed: {}",
            APP.get().and_then(|app| app.error_buffer().ok()).unwrap_or_default().trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                data[i] = (x * 255 / width.max(1)) as u8;
                data[i + 1] = (y * 255 / height.max(1)) as u8;
                data[i + 2] = 128;
            }
        }
        Rgb { width, height, data }
    }

    #[test]
    fn resizes_to_a_long_edge_keeping_aspect() {
        init();
        let source = gradient(400, 200);
        let out = Pipeline::from_rgb(source.as_ref()).unwrap().resize_to_fit(100).unwrap().finish().unwrap();
        assert_eq!((out.width, out.height), (100, 50));
        assert_eq!(out.data.len(), 100 * 50 * 3);
    }

    #[test]
    fn a_chain_resizes_and_blurs_in_one_pass() {
        init();
        let source = gradient(400, 200);
        let out = Pipeline::from_rgb(source.as_ref())
            .unwrap()
            .resize_to_fit(100)
            .unwrap()
            .blur(2.0)
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!((out.width, out.height), (100, 50));
    }

    #[test]
    fn blur_flattens_detail_without_shifting_the_average() {
        init();
        let source = gradient(64, 64);
        let out = Pipeline::from_rgb(source.as_ref()).unwrap().blur(3.0).unwrap().finish().unwrap();
        assert_eq!((out.width, out.height), (64, 64));
        let mean = |d: &[u8]| d.iter().map(|v| *v as u64).sum::<u64>() / d.len() as u64;
        assert!(
            (mean(&source.data) as i64 - mean(&out.data) as i64).abs() < 3,
            "a blur should not move the overall level"
        );
    }

    #[test]
    fn round_trips_through_jpeg_with_orientation_applied() {
        init();
        let source = gradient(80, 40);
        let encoded = Pipeline::from_rgb(source.as_ref()).unwrap().encode_jpeg(92).unwrap();
        let decoded = Pipeline::decode_upright(&encoded).unwrap().finish().unwrap();
        assert_eq!((decoded.width, decoded.height), (80, 40));
        assert_eq!(decoded.data.len(), 80 * 40 * 3);
    }

    #[test]
    fn writes_an_avif_that_reads_back_at_the_same_size() {
        init();
        let path = std::env::temp_dir().join("rawshim-avif-test.avif");
        let out = path.to_str().unwrap();
        let source = gradient(120, 90);
        // 4:4:4 and effort 0, the settings the renditions use.
        Pipeline::from_rgb(source.as_ref()).unwrap().save_avif(80, 0, out).unwrap();
        let bytes = std::fs::read(out).unwrap();
        assert!(bytes.len() > 64, "an AVIF of a gradient should not be empty");
        let back = Pipeline::decode_upright(&bytes).unwrap().finish().unwrap();
        assert_eq!((back.width, back.height), (120, 90));
        std::fs::remove_file(out).ok();
    }

    #[test]
    fn a_short_buffer_is_refused_rather_than_read_past() {
        init();
        let short = RgbRef { width: 64, height: 64, data: &[0u8; 64 * 3] };
        assert!(Pipeline::from_rgb(short).is_err());
    }
}
