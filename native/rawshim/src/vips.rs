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

/// The largest 1/2, 1/4 or 1/8 DCT scale that still covers `target`.
///
/// libjpeg can only scale by these factors during the transform, so this gets as
/// close to the target as those factors allow and a real reduce does the rest.
///
/// Going all the way rather than leaving the reduce a factor of two to work with
/// is a deliberate quality trade. libjpeg's scaling and libvips' reduce are
/// different filters, so shifting work between them moves the result: against
/// decoding whole and reducing once, an 800px tile goes from deltaE 0.29 mean to
/// 0.63, and its worst pixels from 7 to 24. That error is confined to fine detail
/// where the two filters disagree - foliage, not sky - and at tile size it is not
/// visible even under a 1:1 crop. Buys 105ms per file against 125ms, where
/// decoding whole was 458ms.
fn dct_shrink(longest: usize, target: usize) -> usize {
    if target == 0 {
        return 1;
    }
    [8, 4, 2].into_iter().find(|shrink| longest / shrink >= target).unwrap_or(1)
}

pub fn init() {
    APP.get_or_init(|| {
        let app = VipsApp::new("bowerbird", false).expect("libvips failed to initialise");
        app.concurrency_set(thread_count());
        // The operation cache is turned off, and that is a correctness fix rather
        // than a memory tweak.
        //
        // libvips memoises operations by their arguments, so a cached result holds a
        // reference to the image it came from - and every image here is built with
        // `vips_image_new_from_buffer` or `_from_memory`, which reference the
        // caller's bytes rather than copying them. Those bytes belong to JavaScript
        // and are collectable the moment the call returns, so anything the cache
        // keeps is a pointer into memory that may already be gone. Measured, it also
        // grows: a batch of embedded previews went from 71ms to 114ms per file as
        // the cache filled, then died partway through the batch.
        //
        // Nothing here would benefit from it in any case. Every call is a different
        // photo, so there is no repeated operation to memoise.
        app.cache_set_max(0);
        app.cache_set_max_mem(0);
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

    /// Decodes an encoded image straight to a bounded size, shrinking during the
    /// decode rather than after it.
    ///
    /// Worth a separate entry point because the saving is not marginal. A 61MP
    /// body embeds a *full-resolution* preview - 9504x6336, 5-14MB of JPEG - and
    /// the grid tile is 800px, so decoding it whole and then resizing spends
    /// ~250-540ms to discard 99% of what it produced. libjpeg can scale during the
    /// DCT, which `thumbnail` picks a factor for, then reduces properly from
    /// there. It also rotates, so this replaces the `autorot` above; on a portrait
    /// frame that rotation alone was doubling the cost, since it shuffled 60MP.
    /// Not `vips_thumbnail`, which would be the obvious call: the crate's
    /// `thumbnail_buffer_with_opts` sends `input-profile`, which libvips 8.15.1
    /// calls `import-profile`, so it fails outright - the third property this crate
    /// has renamed out from under the version Debian ships. The loader's option
    /// *string* takes no such struct, so it is the version-independent way in.
    pub fn thumbnail(bytes: &'a [u8], long_edge: usize) -> Result<Pipeline<'a>> {
        // `shrink` is a jpegload option and other loaders reject it outright, so it
        // is only offered where the bytes are a JPEG. That covers what needs it:
        // the caller passing a size is always working on an embedded preview.
        let options = match bytes.starts_with(&[0xFF, 0xD8]) {
            false => String::new(),
            true => {
                // A load with no options is lazy, so this reads the header only.
                // Rotation swaps the two, which does not change the longer of them.
                let header = wrap(VipsImage::new_from_buffer(bytes, ""))?;
                match dct_shrink(header.get_width().max(header.get_height()) as usize, long_edge) {
                    1 => String::new(),
                    shrink => format!("shrink={shrink}"),
                }
            }
        };
        let image = wrap(VipsImage::new_from_buffer(bytes, &options))?;
        let upright = Pipeline { image: wrap(ops::autorot(&image))?, _borrow: std::marker::PhantomData };
        // The DCT gets within a factor of two; a proper reduce finishes the job.
        upright.resize_to_fit(long_edge)
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

    pub fn encode_jpeg(self, quality: i32) -> Result<Vec<u8>> {
        use libvips::bindings;
        use std::ffi::{c_char, c_void};

        let image = self.finish()?;
        let mut buffer: *mut c_void = std::ptr::null_mut();
        let mut len: u64 = 0;
        #[expect(unsafe_code)]
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
        #[expect(unsafe_code)]
        unsafe {
            let bytes = std::slice::from_raw_parts(buffer as *const u8, len as usize).to_vec();
            bindings::g_free(buffer);
            Ok(bytes)
        }
    }
}

/// Runs a libvips saver over `image`.
///
/// Through the raw bindings rather than the crate's `*_with_opts` helpers, which
/// send every property their options struct knows about - a `keep` flag for
/// jpegsave - which libvips 8.15, the version Debian and Ubuntu ship, does not
/// have. It logs a GLib critical rather than failing, which is worse, because it
/// looks like it worked. Naming the properties here means sending exactly the
/// ones the saver needs, and it keeps the version-coupled part of the dependency
/// here.
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
    #[expect(unsafe_code)]
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
    fn the_dct_shrink_never_undershoots_the_target() {
        // Undershooting is the failure that matters: it would decode below the size
        // asked for and the reduce afterwards would be an upscale.
        for (longest, target, expected) in [
            (9504, 800, 8),  // a 61MP body's full-resolution preview
            (6400, 800, 8),  // exactly the target at 1/8
            (3200, 800, 4),  // 1/8 would undershoot by half
            (1616, 800, 2),  // a small preview, one factor from the target
            (800, 800, 1),   // already the target
            (400, 800, 1),   // smaller than the target
        ] {
            assert_eq!(dct_shrink(longest, target), expected, "{longest} -> {target}");
            // Undershooting would make the reduce that follows an upscale.
            assert!(longest / dct_shrink(longest, target) >= target.min(longest));
        }
        assert_eq!(dct_shrink(9504, 0), 1, "no target means no shrink");
    }

    #[test]
    fn a_thumbnail_fits_inside_the_bound_and_never_enlarges() {
        init();
        let source = gradient(1600, 900);
        let jpeg = Pipeline::from_rgb(source.as_ref()).unwrap().encode_jpeg(92).unwrap();

        // The bound and the aspect, not the exact rounding: 900/1600*200 is 112.5,
        // and which side of it a given shrink lands on is libvips' business.
        let small = Pipeline::thumbnail(&jpeg, 200).unwrap().finish().unwrap();
        assert_eq!(small.width.max(small.height), 200);
        assert!((small.height as i32 - 113).abs() <= 1, "got {}x{}", small.width, small.height);

        // Bigger than the source: `size: down` territory, and inventing detail here
        // would mean a grid tile upscaled from a small embedded preview.
        let big = Pipeline::thumbnail(&jpeg, 4000).unwrap().finish().unwrap();
        assert_eq!((big.width, big.height), (1600, 900));
    }

    #[test]
    fn a_short_buffer_is_refused_rather_than_read_past() {
        init();
        let short = RgbRef { width: 64, height: 64, data: &[0u8; 64 * 3] };
        assert!(Pipeline::from_rgb(short).is_err());
    }
}

